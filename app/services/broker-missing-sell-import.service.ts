import { Op } from 'sequelize';
import { BrokerReport, OperationItem, OperationState, OperationType } from 'tinkoff-sdk-grpc-js/dist/generated/operations';
import { RobotConfig } from '../config/robot.config';
import { TradesModel } from '../models/trades.model';
import { quotationToNumber } from '../utils/money';
import AccountingAuditService from './accounting-audit.service';
import OperationsService from './operations.service';

const SELL_DIRECTION = '2';
const FILL_STATUS = 'EXECUTION_REPORT_STATUS_FILL';
const LOOKBACK_DAYS = 30;

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

const operationLots = (operation: OperationItem) => {
    const done = toNumber(operation.quantityDone);
    if (done > 0) return done;

    return Math.max(0, toNumber(operation.quantity));
};

const operationToCandidate = (issue: AuditIssue, operation: OperationItem): MissingBrokerSellCandidate | undefined => {
    const lots = operationLots(operation);
    const price = absMoney(quotationToNumber(operation.price));
    const amount = absMoney(quotationToNumber(operation.payment));

    if (!operation.id || lots <= 0 || !price || !amount) return undefined;

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
        price,
        amount,
        reason: `broker sell exists, but local trades table has no matching orderId; ledger ${issue.ledgerLots}, broker ${issue.brokerLots}`
    };
};

const brokerReportDirectionIsSell = (direction: unknown) => {
    const value = String(direction ?? '').toLowerCase();
    return value.includes('sell') || value.includes('прод');
};

const brokerReportToCandidate = (issue: AuditIssue, row: BrokerReport): MissingBrokerSellCandidate | undefined => {
    const lots = toNumber(row.quantity);
    const price = absMoney(quotationToNumber(row.price));
    const amount = absMoney(quotationToNumber(row.totalOrderAmount)) ?? absMoney(quotationToNumber(row.orderAmount));

    if (!row.orderId || lots <= 0 || !price || !amount) return undefined;
    if (!brokerReportDirectionIsSell(row.direction)) return undefined;
    if (issue.figi && row.figi && row.figi !== issue.figi) return undefined;

    return {
        accountId: issue.accountId,
        accountAlias: issue.accountAlias,
        ticker: row.ticker || issue.ticker,
        name: row.name || issue.name,
        figi: row.figi || issue.figi,
        instrumentUid: issue.instrumentUid,
        orderId: row.orderId,
        tradeDateTime: row.tradeDatetime?.toISOString(),
        lots,
        price,
        amount,
        reason: `broker report sell exists, but local trades table has no matching orderId; ledger ${issue.ledgerLots}, broker ${issue.brokerLots}`
    };
};

export default class BrokerMissingSellImportService {
    private static async getBrokerSellCandidates(issue: AuditIssue, from: Date, to: Date) {
        try {
            const operations = await OperationsService.getOperationsByCursorItems(issue.accountId, from, to, {
                instrumentId: issue.instrumentUid || issue.figi,
                figi: issue.figi,
                operationTypes: [OperationType.OPERATION_TYPE_SELL],
                state: OperationState.OPERATION_STATE_EXECUTED,
                withoutCommissions: false,
                withoutTrades: false,
                withoutOvernights: true
            });

            return operations
                .map(operation => operationToCandidate(issue, operation))
                .filter((candidate): candidate is MissingBrokerSellCandidate => Boolean(candidate));
        } catch (error) {
            console.warn('Broker operations cursor failed, falling back to broker report:', {
                accountId: issue.accountId,
                ticker: issue.ticker,
                error: error instanceof Error ? error.message : String(error)
            });
        }

        const rows = await OperationsService.getBrokerReportRows(issue.accountId, from, to);

        return (rows as BrokerReport[])
            .map(row => brokerReportToCandidate(issue, row))
            .filter((candidate): candidate is MissingBrokerSellCandidate => Boolean(candidate));
    }

    static async importMissingSells(config: RobotConfig, options: { apply?: boolean; from?: Date; to?: Date } = {}): Promise<MissingBrokerSellImportResult> {
        const audit = await AccountingAuditService.getLedgerBrokerAudit(config);
        const issues = audit.issues.filter(issue => (
            issue.type === 'ledger-overstates-broker'
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

            const brokerCandidates = await this.getBrokerSellCandidates(issue, from, to);
            const orderIds = brokerCandidates.map(candidate => candidate.orderId).filter(Boolean);
            const existing = orderIds.length > 0
                ? await TradesModel.findAll({
                    where: {
                        orderId: { [Op.in]: orderIds }
                    } as any
                })
                : [];
            const existingOrderIds = new Set(existing.map(trade => String(trade.getDataValue('orderId'))));
            let selectedLots = 0;

            const candidates = brokerCandidates
                .filter(candidate => !existingOrderIds.has(candidate.orderId))
                .sort((a, b) => new Date(a.tradeDateTime || 0).getTime() - new Date(b.tradeDateTime || 0).getTime());

            for (const candidate of candidates) {
                if (selectedLots >= missingLots) {
                    result.skipped.push({ ...candidate, skippedReason: 'missing lots already covered by earlier broker sell operations' });
                    continue;
                }

                selectedLots += candidate.lots;
                result.candidates.push(candidate);

                if (!options.apply) continue;

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
                    lot: String(1),
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

        return result;
    }
}
