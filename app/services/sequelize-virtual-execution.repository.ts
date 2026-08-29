import sequelize from '../config/database';
import { VirtualAccountModel } from '../models/virtual-account.model';
import { VirtualFillModel } from '../models/virtual-fill.model';
import { VirtualLedgerEventModel } from '../models/virtual-ledger-event.model';
import { VirtualOrderModel } from '../models/virtual-order.model';
import { decodeKopecks, encodeKopecks } from '../virtual/codecs';
import {
    DeterministicVirtualExecutionSimulator, VirtualExecutionPolicy,
    VirtualExecutionResult, VirtualMarketQuote, VirtualOrderIntent
} from '../virtual/execution';
import {
    decodeVirtualExecutionResult, encodeVirtualExecutionResult,
    virtualOrderIntentFingerprint
} from '../virtual/execution-codecs';
import { applyVirtualLedgerEvent, replayVirtualLedger } from '../virtual/ledger';
import {
    virtualLedgerEventToColumns, virtualLedgerRowToStoredEvent
} from './sequelize-virtual-ledger.repository';
import { decodeVirtualLedgerEvent } from '../virtual/codecs';

export interface PersistedVirtualExecutionContext {
    readonly now: string;
    readonly availableLots: number;
}

const fillColumns = (result: Extract<VirtualExecutionResult, { status: 'filled' }>) => ({
    virtualAccountId: result.fill.virtualAccountId,
    fillId: result.fill.id,
    orderId: result.fill.orderId,
    instrumentId: result.fill.instrumentId,
    side: result.fill.side,
    quantityLots: result.fill.quantityLots,
    lotSize: result.fill.lotSize,
    referencePriceKopecks: encodeKopecks(result.fill.referencePriceKopecks),
    executionPriceKopecks: encodeKopecks(result.fill.executionPriceKopecks),
    grossAmountKopecks: encodeKopecks(result.fill.grossAmountKopecks),
    feeKopecks: encodeKopecks(result.fill.feeKopecks),
    netCashDeltaKopecks: encodeKopecks(result.fill.netCashDeltaKopecks),
    filledAt: result.fill.filledAt
});

export const virtualFillRowCashDelta = (row: VirtualFillModel) =>
    decodeKopecks(row.netCashDeltaKopecks);

export class SequelizeVirtualExecutionRepository {
    async execute(
        order: VirtualOrderIntent,
        quote: VirtualMarketQuote,
        context: PersistedVirtualExecutionContext,
        policy: VirtualExecutionPolicy
    ): Promise<VirtualExecutionResult> {
        const requestFingerprint = virtualOrderIntentFingerprint(order);
        return sequelize.transaction(async transaction => {
            const account = await VirtualAccountModel.findOne({
                where: { virtualAccountId: order.virtualAccountId }, transaction,
                lock: transaction.LOCK.UPDATE
            });
            if (!account) throw new Error(`virtual account not found: ${order.virtualAccountId}`);

            const existing = await VirtualOrderModel.findOne({
                where: { virtualAccountId: order.virtualAccountId, orderId: order.id },
                transaction, lock: transaction.LOCK.UPDATE
            });
            if (existing) {
                if (existing.requestFingerprint !== requestFingerprint) {
                    throw new Error(`virtual order ID conflict: ${order.id}`);
                }
                return decodeVirtualExecutionResult(existing.resultJson);
            }

            const ledgerRows = await VirtualLedgerEventModel.findAll({
                where: { virtualAccountId: order.virtualAccountId },
                order: [['sequence', 'ASC']], transaction, lock: transaction.LOCK.UPDATE
            });
            let ledger = replayVirtualLedger(ledgerRows.map(row =>
                decodeVirtualLedgerEvent(virtualLedgerRowToStoredEvent(row))
            ));
            const simulator = new DeterministicVirtualExecutionSimulator();
            const result = simulator.execute(order, quote, {
                now: context.now,
                cashKopecks: ledger.cashKopecks,
                availableLots: context.availableLots
            }, policy);

            if (result.status === 'filled') {
                for (const event of result.ledgerEvents) {
                    ledger = applyVirtualLedgerEvent(ledger, event);
                }
                await VirtualFillModel.create(fillColumns(result), { transaction });
                for (const event of result.ledgerEvents) {
                    await VirtualLedgerEventModel.create(virtualLedgerEventToColumns(event), { transaction });
                }
            }

            const completedAt = result.status === 'filled' ? result.fill.filledAt : result.rejectedAt;
            await VirtualOrderModel.create({
                virtualAccountId: order.virtualAccountId,
                orderId: order.id,
                requestFingerprint,
                instrumentId: order.instrumentId,
                side: order.side,
                quantityLots: order.quantityLots,
                submittedAt: order.submittedAt,
                status: result.status,
                rejectionReason: result.status === 'rejected' ? result.reason : null,
                completedAt,
                resultJson: encodeVirtualExecutionResult(result)
            }, { transaction });
            return result;
        });
    }
}

export default SequelizeVirtualExecutionRepository;
