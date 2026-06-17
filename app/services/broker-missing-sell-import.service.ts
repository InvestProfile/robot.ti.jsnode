import { Op } from 'sequelize';
import { OperationItem, OperationState, OperationType } from 'tinkoff-sdk-grpc-js/dist/generated/operations';
import { RobotConfig } from '../config/robot.config';
import { TradesModel } from '../models/trades.model';
import { quotationToNumber } from '../utils/money';
import AccountingAuditService from './accounting-audit.service';
import InstrumentsService from './instruments.service';
import OperationsService from './operations.service';

const SELL_DIRECTION = '2';
const FILL_STATUS = 'EXECUTION_REPORT_STATUS_FILL';
const LOOKBACK_DAYS = 31;
const RECENT_SELL_LOOKBACK_DAYS = 3;

type AuditIssue = {
    type: string;
    accountId: string;
    accountAlias?: string;
    ticker?: string;
    name?: string;
    figi?: string;
    instrumentUid?: string;
    ledgerLots: number;
    brokerLots: number;
    lastTradeAt?: string;
};

export type MissingBrokerSellCandidate = {
    accountId: string;
    accountAlias?: string;
    ticker?: string;
    name?: string;
    figi?: string;
    instrumentUid?: string;
    orderId: string;
    tradeDateTime?: string;
    lots: number;
    lotSize: number;
    price: number;
    amount: number;
    reason: string;
};

export type MissingBrokerSellImportResult = {
    generatedAt: string;
    dryRun: boolean;
    checkedIssues: number;
    candidates: MissingBrokerSellCandidate[];
    imported: MissingBrokerSellCandidate[];
    skipped: Array<MissingBrokerSellCandidate & { skippedReason: string }>;
};

const toNumber = (value: unknown) => {
    const number = Number(value ?? 0);
    return Number.isFinite(number) ? number : 0;
};

const absMoney = (value: ReturnType<typeof quotationToNumber>) => {
    if (value === undefined || !Number.isFinite(value)) return undefined;
    return Math.abs(value);
};

const moneyParts = (value: number) => {
    const units = Math.trunc(value);
    const nano = Math.round((value - units) * 1e9);

    return {
        units: String(units),
        nano: String(nano)
    };
};

const operationQuantity = (operation: OperationItem) => {
    const done = toNumber(operation.quantityDone);
    if (done > 0) return done;

    return Math.max(0, toNumber(operation.quantity));
};

const operationToCandidate = (issue: AuditIssue, operation: OperationItem, lotSize: number): MissingBrokerSellCandidate | undefined => {
    const quantity = operationQuantity(operation);
    const lots = lotSize > 1 ? quantity / lotSize : quantity;
    const price = absMoney(quotationToNumber(operation.price));
    const amount = absMoney(quotationToNumber(operation.payment));

    if (!operation.id || lots <= 0 || !Number.isInteger(lots) || !price || !amount) return undefined;

    return {
        accountId: issue.accountId,
        accountAlias: issue.accountAlias,
        ticker: operation.ticker || issue.ticker,
        name: operation.name || issue.name,
        figi: operation.figi || issue.figi,
        instrumentUid: operation.instrumentUid || issue.instrumentUid,
        orderId: operation.id,
        tradeDateTime: operation.date?.toISOString(),
        lots,
        lotSize,
        price,
        amount,
        reason: `broker sell exists, but local trades table has no matching orderId; issue ${issue.type}, ledger ${issue.ledgerLots}, broker ${issue.brokerLots}`
    };
};

const operationToRecentCandidate = (
    accountId: string,
    accountAlias: string | undefined,
    operation: OperationItem,
    lotSize: number
): MissingBrokerSellCandidate | undefined => {
    const quantity = operationQuantity(operation);
    const lots = lotSize > 1 ? quantity / lotSize : quantity;
    const price = absMoney(quotationToNumber(operation.price));
    const amount = absMoney(quotationToNumber(operation.payment));

    if (!operation.id || lots <= 0 || !Number.isInteger(lots) || !price || !amount) return undefined;

    return {
        accountId,
        accountAlias,
        ticker: operation.ticker,
        name: operation.name,
        figi: operation.figi,
        instrumentUid: operation.instrumentUid,
        orderId: operation.id,
        tradeDateTime: operation.date?.toISOString(),
        lots,
        lotSize,
        price,
        amount,
        reason: 'recent broker sell exists, but local trades table has no matching orderId'
    };
};

export default class BrokerMissingSellImportService {
    private static async importCandidates(
        result: MissingBrokerSellImportResult,
        candidates: MissingBrokerSellCandidate[],
        selectedLotsLimit?: number,
        apply = false
    ) {
        const orderIds = candidates.map(candidate => candidate.orderId).filter(Boolean);
        const existing = orderIds.length > 0
            ? await TradesModel.findAll({
                where: {
                    orderId: { [Op.in]: orderIds }
                } as any
            })
            : [];
        const existingOrderIds = new Set(existing.map(trade => String(trade.getDataValue('orderId'))));
        const seenResultOrderIds = new Set(result.candidates.map(candidate => candidate.orderId));
        let selectedLots = 0;

        for (const candidate of candidates
            .filter(candidate => !existingOrderIds.has(candidate.orderId))
            .filter(candidate => !seenResultOrderIds.has(candidate.orderId))
            .sort((a, b) => new Date(a.tradeDateTime || 0).getTime() - new Date(b.tradeDateTime || 0).getTime())) {
            if (selectedLotsLimit !== undefined && selectedLots >= selectedLotsLimit) {
                result.skipped.push({ ...candidate, skippedReason: 'missing lots already covered by earlier broker sell operations' });
                continue;
            }

            selectedLots += candidate.lots;
            result.candidates.push(candidate);
            seenResultOrderIds.add(candidate.orderId);

            if (!apply) continue;

            const price = moneyParts(candidate.price);
            const amount = moneyParts(candidate.amount);
            await TradesModel.create({
                figi: candidate.figi,
                quantity: String(candidate.lots),
                direction: SELL_DIRECTION,
                price_units: price.units,
                price_nano: price.nano,
                uid: candidate.instrumentUid,
                instrumentUid: candidate.instrumentUid,
                instrumentId: candidate.instrumentUid,
                accountId: candidate.accountId,
                ticker: candidate.ticker,
                name: candidate.name,
                lot: String(candidate.lotSize),
                orderId: candidate.orderId,
                orderType: 'broker-import',
                status: FILL_STATUS,
                tradeDateTime: candidate.tradeDateTime,
                lotsRequested: candidate.lots,
                lotsExecuted: candidate.lots,
                executedPriceUnits: price.units,
                executedPriceNano: price.nano,
                totalAmountUnits: amount.units,
                totalAmountNano: amount.nano,
                orderError: null
            });
            result.imported.push(candidate);
        }
    }

    private static async getBrokerSellCandidates(issue: AuditIssue, from: Date, to: Date, missingLots: number, lotSize: number) {
        const candidates: MissingBrokerSellCandidate[] = [];
        const seenOrderIds = new Set<string>();
        const fromDay = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
        let cursorTo = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate()));

        while (cursorTo > fromDay) {
            const cursorFrom = new Date(cursorTo.getTime() - 24 * 60 * 60 * 1000);
            let operations: OperationItem[] = [];
            try {
                operations = await OperationsService.getOperationsByCursorItems(issue.accountId, cursorFrom, cursorTo, {
                    instrumentId: issue.instrumentUid || issue.figi,
                    figi: issue.figi,
                    operationTypes: [OperationType.OPERATION_TYPE_SELL],
                    state: OperationState.OPERATION_STATE_EXECUTED,
                    withoutCommissions: false,
                    withoutTrades: false,
                    withoutOvernights: true,
                    fallbackToBrokerReport: false
                });
            } catch (error) {
                console.warn('Broker sell daily window failed:', {
                    accountId: issue.accountId,
                    ticker: issue.ticker,
                    from: cursorFrom.toISOString(),
                    to: cursorTo.toISOString(),
                    error: error instanceof Error ? error.message : String(error)
                });
            }

            for (const candidate of operations
                .map(operation => operationToCandidate(issue, operation, lotSize))
                .filter((item): item is MissingBrokerSellCandidate => Boolean(item))) {
                if (seenOrderIds.has(candidate.orderId)) continue;
                seenOrderIds.add(candidate.orderId);
                candidates.push(candidate);
            }

            const foundLots = candidates.reduce((sum, candidate) => sum + candidate.lots, 0);
            if (foundLots >= missingLots) break;

            cursorTo = cursorFrom;
        }

        return candidates;
    }

    private static async getRecentBrokerSellCandidates(config: RobotConfig, from: Date, to: Date, instruments: Array<{ uid?: string; figi?: string; ticker?: string; lot?: number }>) {
        const candidates: MissingBrokerSellCandidate[] = [];
        const tradeAccountIds = config.accountIds ?? [];

        for (const accountId of tradeAccountIds) {
            let operations: OperationItem[] = [];
            try {
                operations = await OperationsService.getOperationsByCursorItems(accountId, from, to, {
                    operationTypes: [OperationType.OPERATION_TYPE_SELL],
                    state: OperationState.OPERATION_STATE_EXECUTED,
                    withoutCommissions: false,
                    withoutTrades: false,
                    withoutOvernights: true,
                    fallbackToBrokerReport: false
                });
            } catch (error) {
                console.warn('Recent broker sell window failed:', {
                    accountId,
                    from: from.toISOString(),
                    to: to.toISOString(),
                    error: error instanceof Error ? error.message : String(error)
                });
                continue;
            }

            for (const operation of operations) {
                const instrument = instruments.find(item =>
                    item.uid === operation.instrumentUid
                    || item.figi === operation.figi
                    || item.ticker === operation.ticker
                );
                const lotSize = Math.max(1, Math.trunc(toNumber(instrument?.lot) || 1));
                const candidate = operationToRecentCandidate(
                    accountId,
                    config.accountAliases[accountId],
                    operation,
                    lotSize
                );
                if (candidate) candidates.push(candidate);
            }
        }

        return candidates;
    }

    static async importMissingSells(config: RobotConfig, options: { apply?: boolean; from?: Date; to?: Date } = {}): Promise<MissingBrokerSellImportResult> {
        const audit = await AccountingAuditService.getLedgerBrokerAudit(config);
        const shares = await InstrumentsService.getShares();
        const instruments = shares?.instruments ?? [];
        const issues = audit.issues.filter(issue => (
            (issue.type === 'ledger-overstates-broker' || issue.type === 'ledger-ghost')
            && toNumber(issue.ledgerLots) > toNumber(issue.brokerLots)
            && Boolean(issue.accountId)
            && Boolean(issue.instrumentUid || issue.figi)
        )) as AuditIssue[];
        const result: MissingBrokerSellImportResult = {
            generatedAt: new Date().toISOString(),
            dryRun: !options.apply,
            checkedIssues: issues.length,
            candidates: [],
            imported: [],
            skipped: []
        };
        const to = options.to ?? new Date();
        const from = options.from ?? new Date(to.getTime() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000);

        for (const issue of issues) {
            const missingLots = Math.max(0, toNumber(issue.ledgerLots) - toNumber(issue.brokerLots));
            if (missingLots <= 0) continue;

            const instrument = instruments.find(item =>
                item.uid === issue.instrumentUid
                || item.figi === issue.figi
                || item.ticker === issue.ticker
            );
            const lotSize = Math.max(1, Math.trunc(toNumber(instrument?.lot) || 1));
            const brokerCandidates = await this.getBrokerSellCandidates(issue, from, to, missingLots, lotSize);
            await this.importCandidates(result, brokerCandidates, missingLots, options.apply);
        }

        const recentFrom = options.from ?? new Date(to.getTime() - RECENT_SELL_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
        const recentCandidates = await this.getRecentBrokerSellCandidates(config, recentFrom, to, instruments);
        await this.importCandidates(result, recentCandidates, undefined, options.apply);

        return result;
    }
}
