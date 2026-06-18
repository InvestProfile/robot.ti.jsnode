import { Op } from 'sequelize';
import { RobotConfig } from '../config/robot.config';
import { TradeDecisionModel } from '../models/trade-decision.model';
import { TradesModel } from '../models/trades.model';
import TradesService from './trades.service';
import { isIgnoredAccountingOrderStatus } from '../utils/order-status';
import OperationsService from './operations.service';
import { quotationToNumber } from '../utils/money';
import { OperationItem, OperationState, OperationType } from 'tinkoff-sdk-grpc-js/dist/generated/operations';
import { PortfolioSnapshotModel } from '../models/portfolio-snapshot.model';
import RobotPositionLedgerService from './robot-position-ledger.service';
import AccountingAuditService from './accounting-audit.service';

const BUY_DIRECTION = '1';
const SELL_DIRECTION = '2';
const BROKER_REPORT_MAX_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

interface OpenBuy {
    row: Record<string, unknown>;
    remainingLots: number;
    unitAmount: number;
    unitCommission: number;
}

interface OpenLot {
    accountId: string;
    accountAlias?: string;
    ticker?: unknown;
    name?: unknown;
    lots: number;
    entryAt: string;
    entryAmount: number;
    entryCommissionRub: number;
    entryPrice: number;
    entrySignalSource?: unknown;
    entryDecisionReason?: unknown;
    entryTradeId?: unknown;
}

interface DecisionMatch {
    id?: unknown;
    status?: unknown;
    signalSource?: unknown;
    reason?: unknown;
    createdAt?: unknown;
}

interface RoundTripPnlOptions {
    includeCommissions?: boolean;
}

interface PnlReconciliationOptions {
    limit?: number;
    includeCashflows?: boolean;
}

const toNumber = (value: unknown) => {
    const number = Number(value ?? 0);
    return Number.isFinite(number) ? number : 0;
};

const tradeTime = (row: Record<string, unknown>) => String(row.tradeDateTime || row.createdAt || '');

const tradeTimestamp = (row: Record<string, unknown>) => {
    const timestamp = new Date(tradeTime(row)).getTime();
    return Number.isFinite(timestamp) ? timestamp : 0;
};

const directionFromTrade = (row: Record<string, unknown>) => String(row.direction || '');

const lotsFromTrade = (row: Record<string, unknown>) => {
    const executed = toNumber(row.lotsExecuted);
    if (executed > 0) return executed;

    const status = row.status ? String(row.status) : undefined;
    if (isIgnoredAccountingOrderStatus(status)) return 0;

    const requested = toNumber(row.lotsRequested);
    if (requested > 0) return requested;

    return Math.max(0, toNumber(row.quantity || row.lot));
};

const priceFromTrade = (row: Record<string, unknown>) => {
    const units = toNumber(row.executedPriceUnits ?? row.price_units);
    const nano = toNumber(row.executedPriceNano ?? row.price_nano);
    const price = units + nano * 1e-9;

    return price > 0 ? price : undefined;
};

const instrumentKeyFromTrade = (row: Record<string, unknown>) =>
    String(row.instrumentId || row.uid || row.figi || row.ticker || '');

const queueKeyFromTrade = (row: Record<string, unknown>) => {
    const accountId = String(row.accountId || '');
    const instrumentKey = instrumentKeyFromTrade(row);

    return accountId && instrumentKey ? `${accountId}:${instrumentKey}` : '';
};

const decisionKey = (accountId: unknown, instrument: unknown) => `${String(accountId || '')}:${String(instrument || '')}`;

const decisionKeys = (row: Record<string, unknown>) => [
    decisionKey(row.accountId, row.ticker),
    decisionKey(row.accountId, row.figi),
    decisionKey(row.accountId, row.instrumentUid),
    decisionKey(row.accountId, row.instrumentId),
    decisionKey(row.accountId, row.uid)
].filter(key => !key.endsWith(':'));

const tradeAmount = (row: Record<string, unknown>, lots: number) => {
    const amount = TradesService.amountFromTrade(row);
    if (amount !== undefined) return amount;

    const price = priceFromTrade(row);
    const lotSize = Math.max(1, toNumber(row.lot) || 1);
    return price ? price * lots * lotSize : undefined;
};

const buildDecisionIndex = (decisions: Record<string, unknown>[]) => {
    const index = new Map<string, Record<string, unknown>[]>();

    for (const decision of decisions) {
        for (const key of decisionKeys(decision)) {
            const rows = index.get(key) ?? [];
            rows.push(decision);
            index.set(key, rows);
        }
    }

    for (const rows of index.values()) {
        rows.sort((a, b) => new Date(String(a.createdAt || '')).getTime() - new Date(String(b.createdAt || '')).getTime());
    }

    return index;
};

const findNearestDecision = (
    decisionIndex: Map<string, Record<string, unknown>[]>,
    trade: Record<string, unknown>
): DecisionMatch | undefined => {
    const rows = decisionKeys(trade)
        .flatMap(key => decisionIndex.get(key) ?? [])
        .filter((row, index, all) => all.findIndex(candidate => candidate.id === row.id) === index);
    const tradeAt = tradeTimestamp(trade);
    const minTime = tradeAt - 12 * 60 * 60 * 1000;
    const maxTime = tradeAt + 30 * 1000;
    const direction = directionFromTrade(trade);
    const candidates = [];

    for (const row of rows.sort((a, b) => new Date(String(a.createdAt || '')).getTime() - new Date(String(b.createdAt || '')).getTime())) {
        const createdAt = new Date(String(row.createdAt || '')).getTime();
        if (!Number.isFinite(createdAt)) continue;
        if (createdAt < minTime) continue;
        if (createdAt > maxTime) break;
        candidates.push({ row, createdAt });
    }

    if (candidates.length === 0) return undefined;

    const scored = candidates
        .map(candidate => ({
            ...candidate,
            relevance: decisionRelevance(direction, candidate.row),
            distance: Math.abs(candidate.createdAt - tradeAt)
        }))
        .filter(candidate => candidate.relevance > 0)
        .sort((a, b) => b.relevance - a.relevance || a.distance - b.distance);

    return scored[0]?.row;
};

const decisionRelevance = (direction: string, decision: Record<string, unknown>) => {
    const source = sourceLabel(decision.signalSource).toLowerCase();
    const status = String(decision.status || '').toLowerCase();
    const reason = String(decision.reason || '').toLowerCase();
    const text = `${source} ${reason}`;

    if (direction === BUY_DIRECTION) {
        if (status === 'order-posted' && (source === 'score-buy' || source === 'watchlist-buy')) return 4;
        if (source === 'score-buy' || source === 'watchlist-buy') return 3;
        if (status === 'order-posted' && reason.includes('score-buy')) return 2;
        return 0;
    }

    if (direction === SELL_DIRECTION) {
        if (text.includes('stop-loss')) return 4;
        if (text.includes('trailing-stop')) return 4;
        if (text.includes('profit-take')) return 4;
        if (text.includes('hold-winner')) return 3;
        if (status === 'order-posted' && reason.includes('sell policy')) return 2;
        return 0;
    }

    return 0;
};

const inferBrokerExitDecision = (
    config: RobotConfig,
    pnlPercent: number | undefined
): DecisionMatch | undefined => {
    if (pnlPercent === undefined || !Number.isFinite(pnlPercent)) return undefined;

    const stopLossPercent = Number(config.stopLossPercent);
    if (!Number.isFinite(stopLossPercent) || stopLossPercent <= 0) return undefined;

    const brokerStopThreshold = -Math.max(1, stopLossPercent * 0.8);
    if (pnlPercent > brokerStopThreshold) return undefined;

    return {
        signalSource: 'broker-stop-loss',
        reason: `inferred broker protective stop: sell fill has no matching decision and closed near stop-loss (${pnlPercent.toFixed(2)}%, configured ${stopLossPercent.toFixed(2)}%)`
    };
};

const sourceLabel = (value: unknown) => String(value || 'unknown');

const parseScore = (value: unknown) => {
    const match = String(value || '').match(/score\s+(-?\d+(?:\.\d+)?)(?:\/\d+)?/i);
    if (!match) return undefined;

    const score = Number(match[1]);
    return Number.isFinite(score) ? score : undefined;
};

const exitKind = (signalSource: unknown, reason: unknown) => {
    const text = `${signalSource || ''} ${reason || ''}`.toLowerCase();
    if (text.includes('stop-loss')) return 'stop-loss';
    if (text.includes('trailing-stop')) return 'trailing-stop';
    if (text.includes('profit-take')) return 'profit-take';
    if (text.includes('hold-winner')) return 'hold-winner';
    if (text.includes('score-buy')) return 'score-buy';
    return sourceLabel(signalSource);
};

const minutesBetween = (from: unknown, to: unknown) => {
    const fromTime = new Date(String(from || '')).getTime();
    const toTime = new Date(String(to || '')).getTime();
    if (!Number.isFinite(fromTime) || !Number.isFinite(toTime)) return undefined;

    return Math.max(0, (toTime - fromTime) / 60_000);
};

const dateLabel = (value: unknown) => {
    const date = new Date(String(value || ''));
    if (Number.isNaN(date.getTime())) return 'unknown';
    return date.toISOString().slice(0, 10);
};

const decisionTimeWindow = (rows: Record<string, unknown>[]) => {
    const timestamps = rows
        .map(tradeTimestamp)
        .filter(timestamp => Number.isFinite(timestamp) && timestamp > 0);

    if (timestamps.length === 0) return undefined;

    return {
        from: new Date(Math.min(...timestamps) - 12 * 60 * 60 * 1000),
        to: new Date(Math.max(...timestamps) + 5 * 60 * 1000)
    };
};

const commissionTimeWindow = (rows: Record<string, unknown>[]) => {
    const timestamps = rows
        .map(tradeTimestamp)
        .filter(timestamp => Number.isFinite(timestamp) && timestamp > 0);

    if (timestamps.length === 0) return undefined;

    const from = Math.min(...timestamps) - 24 * 60 * 60 * 1000;
    const to = Math.min(Date.now(), Math.max(...timestamps) + 24 * 60 * 60 * 1000);
    if (from >= to) return undefined;

    return {
        from: new Date(from),
        to: new Date(to)
    };
};

const splitDateWindow = (from: Date, to: Date, maxWindowMs = BROKER_REPORT_MAX_WINDOW_MS) => {
    const chunks = [];
    let chunkFrom = new Date(from);
    const finalTo = new Date(to);

    while (chunkFrom.getTime() < finalTo.getTime()) {
        const chunkTo = new Date(Math.min(finalTo.getTime(), chunkFrom.getTime() + maxWindowMs));
        chunks.push({ from: chunkFrom, to: chunkTo });
        chunkFrom = new Date(chunkTo.getTime() + 1);
    }

    return chunks.length ? chunks : [{ from, to }];
};

const moneyValueToRub = (value: unknown) => {
    const amount = quotationToNumber(value as { units?: number; nano?: number } | undefined);
    return amount !== undefined && Number.isFinite(amount) ? Math.abs(amount) : 0;
};

const tradeInstrumentId = (row: Record<string, unknown>) => String(row.instrumentId || row.instrumentUid || row.uid || row.figi || '');

const getOrderKeys = (row: Record<string, unknown>) => [
    row.orderId,
    row.clientOrderId
]
    .map(value => value === undefined || value === null ? '' : String(value))
    .filter(Boolean);

const operationTypeForTrade = (row: Record<string, unknown>) => {
    const direction = directionFromTrade(row);
    if (direction === BUY_DIRECTION) return OperationType.OPERATION_TYPE_BUY;
    if (direction === SELL_DIRECTION) return OperationType.OPERATION_TYPE_SELL;
    return undefined;
};

const operationCommissionRub = (operation: OperationItem) => {
    const directCommission = moneyValueToRub(operation.commission);
    if (directCommission > 0) return directCommission;

    return (operation.childOperations ?? [])
        .reduce((sum, child) => sum + moneyValueToRub(child.payment), 0);
};

const operationTimestamp = (operation: OperationItem) => {
    const timestamp = operation.date ? new Date(operation.date).getTime() : 0;
    return Number.isFinite(timestamp) ? timestamp : 0;
};

const operationQuantity = (operation: OperationItem) => Math.max(0, Number(operation.quantityDone || operation.quantity || 0));

const operationPaymentRub = (operation: OperationItem) => moneyValueToRub(operation.payment);

const isAmountClose = (left: number, right: number) => {
    if (!Number.isFinite(left) || !Number.isFinite(right) || left <= 0 || right <= 0) return true;
    return Math.abs(left - right) <= Math.max(1, Math.max(left, right) * 0.02);
};

const buildFallbackCommissionByOrderId = async (
    accountIds: string[],
    rows: Record<string, unknown>[],
    existing: Map<string, number>
) => {
    const fallback = new Map<string, number>();
    const candidates = rows
        .filter(row => !isIgnoredAccountingOrderStatus(row.status ? String(row.status) : undefined))
        .filter(row => getOrderKeys(row).length > 0)
        .filter(row => getOrderKeys(row).every(key => !existing.has(key)))
        .filter(row => accountIds.includes(String(row.accountId || '')))
        .filter(row => tradeInstrumentId(row) || row.figi);

    if (candidates.length === 0) return fallback;

    const groups = new Map<string, Record<string, unknown>[]>();
    for (const row of candidates) {
        const accountId = String(row.accountId || '');
        const instrumentId = tradeInstrumentId(row);
        const key = `${accountId}:${instrumentId || row.figi}`;
        const group = groups.get(key) ?? [];
        group.push(row);
        groups.set(key, group);
    }

    await Promise.all([...groups.values()].map(async groupRows => {
        const accountId = String(groupRows[0].accountId || '');
        const instrumentId = tradeInstrumentId(groupRows[0]);
        const figi = groupRows[0].figi ? String(groupRows[0].figi) : undefined;
        const timestamps = groupRows.map(tradeTimestamp).filter(timestamp => timestamp > 0);
        if (!accountId || timestamps.length === 0) return;

        const from = new Date(Math.min(...timestamps) - 60 * 60 * 1000);
        const to = new Date(Math.max(...timestamps) + 60 * 60 * 1000);

        let operations: OperationItem[] = [];
        try {
            operations = await OperationsService.getOperationsByCursorItems(accountId, from, to, {
                instrumentId,
                figi,
                operationTypes: [OperationType.OPERATION_TYPE_BUY, OperationType.OPERATION_TYPE_SELL],
                state: OperationState.OPERATION_STATE_EXECUTED,
                withoutCommissions: false,
                withoutTrades: false,
                withoutOvernights: true,
                fallbackToBrokerReport: true
            });
        } catch (error) {
            console.warn('Trade P/L commission fallback fetch failed:', {
                accountId,
                instrumentId,
                error: error instanceof Error ? error.message : String(error)
            });
            return;
        }

        const usedOperationIds = new Set<string>();
        for (const row of groupRows.sort((a, b) => tradeTimestamp(a) - tradeTimestamp(b))) {
            const orderKeys = getOrderKeys(row);
            const type = operationTypeForTrade(row);
            if (!type || orderKeys.some(key => fallback.has(key) || existing.has(key))) continue;

            const directMatch = operations.find(operation => !usedOperationIds.has(operation.id) && orderKeys.includes(operation.id));
            const tradeLots = lotsFromTrade(row);
            const tradeRub = tradeAmount(row, tradeLots) ?? 0;
            const timestamp = tradeTimestamp(row);
            const matchedOperation = directMatch ?? operations
                .filter(operation => !usedOperationIds.has(operation.id))
                .filter(operation => operation.type === type)
                .filter(operation => operationCommissionRub(operation) > 0)
                .filter(operation => Math.abs(operationTimestamp(operation) - timestamp) <= 30 * 60 * 1000)
                .filter(operation => operationQuantity(operation) === 0 || operationQuantity(operation) === tradeLots)
                .filter(operation => isAmountClose(operationPaymentRub(operation), tradeRub))
                .sort((left, right) => Math.abs(operationTimestamp(left) - timestamp) - Math.abs(operationTimestamp(right) - timestamp))[0];

            if (!matchedOperation) continue;

            const commissionRub = operationCommissionRub(matchedOperation);
            if (commissionRub <= 0) continue;

            usedOperationIds.add(matchedOperation.id);
            for (const key of orderKeys) {
                fallback.set(key, commissionRub);
            }
        }
    }));

    return fallback;
};

const buildCommissionByOrderId = async (
    accountIds: string[],
    rows: Record<string, unknown>[]
) => {
    const accountingRows = rows.filter(row => !isIgnoredAccountingOrderStatus(row.status ? String(row.status) : undefined));
    const rowsWithOrderKeys = accountingRows.filter(row => getOrderKeys(row).length > 0);
    const reportAccountIds = [...new Set(rowsWithOrderKeys
        .map(row => row.accountId ? String(row.accountId) : '')
        .filter(accountId => accountId && accountIds.includes(accountId)))];
    const window = commissionTimeWindow(rowsWithOrderKeys);
    const commissionByOrderId = new Map<string, number>();
    if (!window || reportAccountIds.length === 0) return commissionByOrderId;

    await Promise.all(reportAccountIds.map(async accountId => {
        try {
            for (const chunk of splitDateWindow(window.from, window.to)) {
                const reportRows = await OperationsService.getBrokerReportRows(accountId, chunk.from, chunk.to);

                for (const reportRow of reportRows) {
                    const data = reportRow as Record<string, unknown>;
                    const orderId = data.orderId ? String(data.orderId) : undefined;
                    if (!orderId) continue;

                    const commissionRub = moneyValueToRub(data.brokerCommission)
                        + moneyValueToRub(data.exchangeCommission)
                        + moneyValueToRub(data.exchangeClearingCommission);
                    if (commissionRub <= 0) continue;

                    commissionByOrderId.set(orderId, (commissionByOrderId.get(orderId) ?? 0) + commissionRub);
                }
            }
        } catch (error) {
            console.warn('Trade P/L commission fetch failed:', {
                accountId,
                error: error instanceof Error ? error.message : String(error)
            });
        }
    }));

    const fallback = await buildFallbackCommissionByOrderId(accountIds, rowsWithOrderKeys, commissionByOrderId);
    for (const [key, value] of fallback.entries()) {
        if (!commissionByOrderId.has(key)) commissionByOrderId.set(key, value);
    }

    return commissionByOrderId;
};

const commissionForTrade = (
    row: Record<string, unknown>,
    commissionByOrderId: Map<string, number>
) => {
    for (const key of getOrderKeys(row)) {
        const commission = commissionByOrderId.get(key);
        if (commission !== undefined) return commission;
    }

    return 0;
};

const summarize = <T extends Record<string, unknown>>(rows: T[], key: (row: T) => string) => {
    const groups = new Map<string, {
        key: string;
        count: number;
        wins: number;
        losses: number;
        pnlRub: number;
        averagePnlRub?: number;
        winRate?: number;
    }>();

    for (const row of rows) {
        const pnl = Number(row.pnlRub);
        if (!Number.isFinite(pnl)) continue;
        const groupKey = key(row);
        const group = groups.get(groupKey) ?? {
            key: groupKey,
            count: 0,
            wins: 0,
            losses: 0,
            pnlRub: 0
        };

        group.count += 1;
        group.pnlRub += pnl;
        if (pnl > 0) group.wins += 1;
        if (pnl < 0) group.losses += 1;
        groups.set(groupKey, group);
    }

    return [...groups.values()]
        .map(group => ({
            ...group,
            averagePnlRub: group.count > 0 ? group.pnlRub / group.count : undefined,
            winRate: group.count > 0 ? group.wins / group.count * 100 : undefined
        }))
        .sort((a, b) => Math.abs(b.pnlRub) - Math.abs(a.pnlRub));
};

const diagnoseRoundTrip = (row: Record<string, unknown>) => {
    const pnlRub = Number(row.netPnlRub ?? row.pnlRub);
    const entrySignal = sourceLabel(row.entrySignalSource);
    const exitSignal = sourceLabel(row.exitSignalSource);
    const entryScore = parseScore(row.entryDecisionReason);
    const holdMinutes = minutesBetween(row.entryAt, row.exitAt);
    const kind = exitKind(row.exitSignalSource, row.exitDecisionReason);
    const diagnoses = [];

    if (Number.isFinite(pnlRub)) {
        diagnoses.push(pnlRub >= 0 ? 'net-profit' : 'net-loss');
    }

    if (entrySignal === 'unknown') diagnoses.push('missing-entry-signal');
    if (exitSignal === 'unknown') diagnoses.push('missing-exit-signal');
    if (kind !== 'unknown') diagnoses.push(`exit:${kind}`);
    diagnoses.push(Number(row.commissionRub ?? 0) > 0 ? 'execution:net' : 'execution:gross-only');

    return {
        id: row.id,
        ticker: row.ticker,
        name: row.name,
        pnlRub: row.pnlRub,
        grossPnlRub: row.grossPnlRub,
        commissionRub: row.commissionRub,
        netPnlRub: row.netPnlRub,
        pnlPercent: row.pnlPercent,
        netPnlPercent: row.netPnlPercent,
        entrySignalSource: row.entrySignalSource,
        exitSignalSource: row.exitSignalSource,
        entryScore,
        exitKind: kind,
        holdMinutes,
        entryAt: row.entryAt,
        exitAt: row.exitAt,
        diagnoses,
        executionAccounting: Number(row.commissionRub ?? 0) > 0 ? 'net' : 'gross',
        note: Number(row.commissionRub ?? 0) > 0
            ? 'Net P/L subtracts broker, exchange, and clearing commissions matched by broker report orderId.'
            : 'No matched commission was found for this round-trip.'
    };
};

const summarizeDiagnostics = (diagnostics: Record<string, unknown>[]) => {
    const expanded = diagnostics.flatMap(row => {
        const diagnoses = Array.isArray(row.diagnoses) ? row.diagnoses : [];
        return diagnoses.map(diagnosis => ({
            ...row,
            diagnosis: String(diagnosis)
        }));
    });

    return summarize(expanded, row => sourceLabel(row.diagnosis));
};

const flattenOpenLots = (openBuys: Map<string, OpenBuy[]>, config: RobotConfig): OpenLot[] => [...openBuys.values()]
    .flat()
    .filter(buy => buy.remainingLots > 0)
    .map(buy => {
        const accountId = String(buy.row.accountId || '');
        const entryAmount = buy.unitAmount * buy.remainingLots;
        const entryCommissionRub = buy.unitCommission * buy.remainingLots;

        return {
            accountId,
            accountAlias: config.accountAliases[accountId],
            ticker: buy.row.ticker,
            name: buy.row.name,
            lots: buy.remainingLots,
            entryAt: tradeTime(buy.row),
            entryAmount,
            entryCommissionRub,
            entryPrice: buy.unitAmount,
            entrySignalSource: buy.row.signalSource,
            entryDecisionReason: buy.row.decisionReason,
            entryTradeId: buy.row.id
        };
    })
    .sort((a, b) => new Date(b.entryAt).getTime() - new Date(a.entryAt).getTime());

const CASH_IN_OPERATION_TYPES = new Set<OperationType>([
    OperationType.OPERATION_TYPE_INPUT,
    OperationType.OPERATION_TYPE_INPUT_SECURITIES,
    OperationType.OPERATION_TYPE_INPUT_SWIFT,
    OperationType.OPERATION_TYPE_INPUT_ACQUIRING
]);

const CASH_OUT_OPERATION_TYPES = new Set<OperationType>([
    OperationType.OPERATION_TYPE_OUTPUT,
    OperationType.OPERATION_TYPE_OUTPUT_SECURITIES,
    OperationType.OPERATION_TYPE_OUTPUT_SWIFT,
    OperationType.OPERATION_TYPE_OUTPUT_ACQUIRING,
    OperationType.OPERATION_TYPE_OUTPUT_PENALTY
]);

const cashPaymentRub = (operation: OperationItem) => moneyValueToRub(operation.payment);

const cashflowTypes = () => [...CASH_IN_OPERATION_TYPES, ...CASH_OUT_OPERATION_TYPES];

const summarizeCashflows = async (accountIds: string[], from: Date | undefined, to: Date | undefined, includeCashflows: boolean) => {
    if (!includeCashflows || !from || !to || accountIds.length === 0) {
        return {
            cashInRub: 0,
            cashOutRub: 0,
            netCashflowRub: 0,
            operations: 0,
            available: Boolean(includeCashflows && from && to && accountIds.length)
        };
    }

    let cashInRub = 0;
    let cashOutRub = 0;
    let operationsCount = 0;

    await Promise.all(accountIds.map(async accountId => {
        try {
            const operations = await OperationsService.getOperationsByCursorItems(accountId, from, to, {
                operationTypes: cashflowTypes(),
                state: OperationState.OPERATION_STATE_EXECUTED,
                withoutCommissions: true,
                withoutTrades: true,
                withoutOvernights: true
            });

            for (const operation of operations) {
                const amount = cashPaymentRub(operation);
                if (amount <= 0) continue;

                if (CASH_IN_OPERATION_TYPES.has(operation.type)) {
                    cashInRub += amount;
                    operationsCount += 1;
                } else if (CASH_OUT_OPERATION_TYPES.has(operation.type)) {
                    cashOutRub += amount;
                    operationsCount += 1;
                }
            }
        } catch (error) {
            console.warn('P/L reconciliation cashflow fetch failed:', {
                accountId,
                error: error instanceof Error ? error.message : String(error)
            });
        }
    }));

    return {
        cashInRub,
        cashOutRub,
        netCashflowRub: cashInRub - cashOutRub,
        operations: operationsCount,
        available: true
    };
};

export default class TradePnlService {
    static async getPnlReconciliation(config: RobotConfig, options: PnlReconciliationOptions = {}) {
        const limit = Math.min(Math.max(Number.isFinite(options.limit) ? Number(options.limit) : 500, 2), 2_000);
        const [pnl, ledger, audit, snapshotModels] = await Promise.all([
            this.getRoundTripPnl(config, limit),
            RobotPositionLedgerService.getLedger(config),
            AccountingAuditService.getLedgerBrokerAudit(config),
            PortfolioSnapshotModel.findAll({
                where: {
                    accountId: { [Op.in]: config.accountIds }
                } as any,
                order: [['createdAt', 'DESC']],
                limit
            })
        ]);
        const snapshots = snapshotModels
            .map(snapshot => snapshot.get({ plain: true }) as Record<string, unknown>)
            .sort((a, b) => new Date(String(a.createdAt || '')).getTime() - new Date(String(b.createdAt || '')).getTime());
        const firstSnapshot = snapshots[0];
        const lastSnapshot = snapshots[snapshots.length - 1];
        const firstTotalRub = firstSnapshot ? Number(firstSnapshot.totalRub) : undefined;
        const lastTotalRub = lastSnapshot ? Number(lastSnapshot.totalRub) : undefined;
        const firstCashRub = firstSnapshot ? Number(firstSnapshot.cashRub) : undefined;
        const lastCashRub = lastSnapshot ? Number(lastSnapshot.cashRub) : undefined;
        const brokerAccountTotalDeltaRub = firstTotalRub !== undefined && lastTotalRub !== undefined
            ? lastTotalRub - firstTotalRub
            : undefined;
        const brokerCashDeltaRub = firstCashRub !== undefined && lastCashRub !== undefined
            ? lastCashRub - firstCashRub
            : undefined;
        const from = firstSnapshot?.createdAt ? new Date(String(firstSnapshot.createdAt)) : undefined;
        const to = lastSnapshot?.createdAt ? new Date(String(lastSnapshot.createdAt)) : undefined;
        const cashflows = await summarizeCashflows(config.accountIds, from, to, options.includeCashflows !== false);
        const realizedGrossPnlRub = Number(pnl.summary.realizedGrossPnlRub ?? pnl.summary.realizedPnlRub ?? 0);
        const commissionRub = Number(pnl.summary.commissionRub ?? 0);
        const realizedNetPnlRub = Number(pnl.summary.realizedNetPnlRub ?? pnl.summary.realizedPnlRub ?? 0);
        const unrealizedPnlRub = Number(ledger.summary.unrealizedPnl ?? 0);
        const robotOwnedDeltaRub = realizedNetPnlRub + unrealizedPnlRub;
        const brokerTradingLikeDeltaRub = brokerAccountTotalDeltaRub !== undefined
            ? brokerAccountTotalDeltaRub - cashflows.netCashflowRub
            : undefined;

        return {
            generatedAt: new Date().toISOString(),
            window: {
                from: firstSnapshot?.createdAt,
                to: lastSnapshot?.createdAt,
                snapshots: snapshots.length,
                trades: pnl.summary.scannedTrades,
                note: 'Snapshot deltas are broker account movement over the loaded window, not pure trading profit.'
            },
            headline: {
                primaryMetric: 'realizedNetPnlRub',
                realizedNetPnlRub,
                realizedGrossPnlRub,
                commissionRub,
                unrealizedPnlRub,
                robotOwnedDeltaRub,
                brokerAccountTotalDeltaRub,
                brokerTradingLikeDeltaRub
            },
            cashflows,
            brokerAccount: {
                firstTotalRub,
                lastTotalRub,
                totalDeltaRub: brokerAccountTotalDeltaRub,
                firstCashRub,
                lastCashRub,
                cashDeltaRub: brokerCashDeltaRub,
                totalDeltaMinusCashflowRub: brokerTradingLikeDeltaRub
            },
            robotOwned: {
                realizedNetPnlRub,
                realizedGrossPnlRub,
                commissionRub,
                unrealizedPnlRub,
                deltaRub: robotOwnedDeltaRub,
                openLots: pnl.summary.openLots,
                openPositions: pnl.summary.openPositions,
                ledgerMarketValueRub: ledger.summary.marketValue,
                ledgerPositions: ledger.summary.positions
            },
            quality: {
                accounting: pnl.summary.accounting,
                closedRoundTrips: pnl.summary.closed,
                unmatchedSells: pnl.summary.unmatchedSells,
                matchingQuality: pnl.summary.matchingQuality,
                accountingIssues: audit.summary.issues,
                ledgerGhosts: audit.summary.ghosts,
                quantityMismatches: audit.summary.quantityMismatches,
                note: 'Realized net P/L is the main trading result for closed robot round-trips. Broker deltas also include open mark-to-market, cashflows, manual activity, dividends, taxes, and non-robot positions.'
            },
            recentClosedRoundTrips: pnl.closedRoundTrips.slice(0, 10),
            unmatchedSells: pnl.unmatchedSells.slice(0, 10),
            accountingIssues: audit.issues.slice(0, 10)
        };
    }

    static async getRoundTripPnl(config: RobotConfig, limit = 500, options: RoundTripPnlOptions = {}) {
        const includeCommissions = options.includeCommissions !== false;
        const safeLimit = Math.min(Math.max(Number.isFinite(limit) ? limit : 500, 1), 2_000);
        const trades = await TradesModel.findAll({
            where: {
                accountId: { [Op.in]: config.accountIds },
                direction: { [Op.in]: [BUY_DIRECTION, SELL_DIRECTION] }
            } as any,
            order: [['createdAt', 'DESC']],
            limit: safeLimit
        });
        const rows = trades
            .map(trade => trade.get({ plain: true }) as Record<string, unknown>)
            .sort((a, b) => tradeTimestamp(a) - tradeTimestamp(b));
        const tickerSet = [...new Set(rows.map(row => String(row.ticker || '')).filter(Boolean))];
        const timeWindow = decisionTimeWindow(rows);
        const decisions = await TradeDecisionModel.findAll({
            where: {
                accountId: { [Op.in]: config.accountIds },
                ...(tickerSet.length ? { ticker: { [Op.in]: tickerSet } } : {}),
                ...(timeWindow ? { createdAt: { [Op.between]: [timeWindow.from, timeWindow.to] } } : {})
            } as any,
            order: [['createdAt', 'ASC']],
            limit: 20_000
        });
        const decisionIndex = buildDecisionIndex(decisions.map(decision => decision.get({ plain: true }) as Record<string, unknown>));
        const commissionByOrderId = includeCommissions
            ? await buildCommissionByOrderId(config.accountIds, rows)
            : new Map<string, number>();
        const openBuys = new Map<string, OpenBuy[]>();
        const roundTrips = [];
        let ignoredTrades = 0;

        for (const row of rows) {
            const status = row.status ? String(row.status) : undefined;
            if (isIgnoredAccountingOrderStatus(status)) {
                ignoredTrades += 1;
                continue;
            }

            const direction = directionFromTrade(row);
            const lots = lotsFromTrade(row);
            const amount = tradeAmount(row, lots);
            const tradeCommissionRub = commissionForTrade(row, commissionByOrderId);
            const key = queueKeyFromTrade(row);

            if (!key || lots <= 0 || amount === undefined || amount <= 0) {
                ignoredTrades += 1;
                continue;
            }

            if (direction === BUY_DIRECTION) {
                const entryDecision = findNearestDecision(decisionIndex, row);
                const queue = openBuys.get(key) ?? [];
                queue.push({
                    row: {
                        ...row,
                        decisionId: entryDecision?.id,
                        signalSource: entryDecision?.signalSource,
                        decisionReason: entryDecision?.reason,
                        decisionAt: entryDecision?.createdAt
                    },
                    remainingLots: lots,
                    unitAmount: amount / lots,
                    unitCommission: tradeCommissionRub / lots
                });
                openBuys.set(key, queue);
                continue;
            }

            if (direction !== SELL_DIRECTION) {
                ignoredTrades += 1;
                continue;
            }

            let remainingSellLots = lots;
            let matchedLots = 0;
            let entryAmount = 0;
            let entryCommissionRub = 0;
            const entries: Record<string, unknown>[] = [];
            const queue = openBuys.get(key) ?? [];

            while (remainingSellLots > 0 && queue.length > 0) {
                const buy = queue[0];
                const matched = Math.min(remainingSellLots, buy.remainingLots);
                matchedLots += matched;
                entryAmount += buy.unitAmount * matched;
                entryCommissionRub += buy.unitCommission * matched;
                entries.push(buy.row);
                buy.remainingLots -= matched;
                remainingSellLots -= matched;

                if (buy.remainingLots <= 0) queue.shift();
            }

            openBuys.set(key, queue);

            const accountId = String(row.accountId || '');
            const exitPrice = priceFromTrade(row);
            const exitDecision = findNearestDecision(decisionIndex, row);
            if (matchedLots <= 0 || entryAmount <= 0) {
                roundTrips.push({
                    id: `unmatched-${row.id}`,
                    accountId,
                    accountAlias: config.accountAliases[accountId],
                    ticker: row.ticker,
                    name: row.name,
                    lots,
                    entryAt: undefined,
                    exitAt: tradeTime(row),
                    entryPrice: undefined,
                    exitPrice,
                    entryAmount: undefined,
                    exitAmount: amount,
                    grossPnlRub: undefined,
                    commissionRub: tradeCommissionRub,
                    netPnlRub: undefined,
                    pnlRub: undefined,
                    pnlPercent: undefined,
                    status: 'unmatched',
                    reason: 'No matching buy found in scanned trade window.',
                    entrySignalSource: undefined,
                    exitSignalSource: exitDecision?.signalSource,
                    exitDecisionReason: exitDecision?.reason,
                    exitDecisionId: exitDecision?.id,
                    entryTradeIds: [],
                    exitTradeId: row.id
                });
                continue;
            }

            const matchedExitAmount = amount * (matchedLots / lots);
            const grossPnlRub = matchedExitAmount - entryAmount;
            const exitCommissionRub = tradeCommissionRub * (matchedLots / lots);
            const commissionRub = entryCommissionRub + exitCommissionRub;
            const netPnlRub = grossPnlRub - commissionRub;
            const pnlPercent = entryAmount > 0 ? grossPnlRub / entryAmount * 100 : undefined;
            const netPnlPercent = entryAmount > 0 ? netPnlRub / entryAmount * 100 : undefined;
            const matchedExitDecision = exitDecision ?? inferBrokerExitDecision(config, pnlPercent);

            roundTrips.push({
                id: `round-${row.id}`,
                accountId,
                accountAlias: config.accountAliases[accountId],
                ticker: row.ticker || entries[0]?.ticker,
                name: row.name || entries[0]?.name,
                figi: row.figi || entries[0]?.figi,
                instrumentId: row.instrumentId || row.uid || entries[0]?.instrumentId || entries[0]?.uid,
                lots: matchedLots,
                entryAt: tradeTime(entries[0]),
                exitAt: tradeTime(row),
                entryPrice: entryAmount / matchedLots,
                exitPrice: matchedExitAmount / matchedLots,
                entryAmount,
                exitAmount: matchedExitAmount,
                grossPnlRub,
                commissionRub,
                netPnlRub,
                pnlRub: grossPnlRub,
                pnlPercent,
                netPnlPercent,
                status: remainingSellLots > 0 ? 'partial' : 'closed',
                reason: entries.length > 1 ? `Matched ${entries.length} buy trades by FIFO.` : 'Matched buy -> sell by FIFO.',
                entrySignalSource: entries[0]?.signalSource,
                exitSignalSource: matchedExitDecision?.signalSource,
                entryDecisionReason: entries[0]?.decisionReason,
                exitDecisionReason: matchedExitDecision?.reason,
                entryDecisionId: entries[0]?.decisionId,
                exitDecisionId: matchedExitDecision?.id,
                entryTradeIds: entries.map(entry => entry.id),
                exitTradeId: row.id
            });
        }

        const openLots = flattenOpenLots(openBuys, config);
        const closedRoundTrips = roundTrips.filter(row => Number.isFinite(Number(row.pnlRub)));
        const unmatchedSells = roundTrips.filter(row => row.status === 'unmatched');
        const realizedGrossPnlRub = closedRoundTrips.reduce((sum, row) => sum + Number(row.grossPnlRub ?? row.pnlRub), 0);
        const commissionRub = closedRoundTrips.reduce((sum, row) => sum + Number(row.commissionRub ?? 0), 0);
        const realizedNetPnlRub = closedRoundTrips.reduce((sum, row) => sum + Number(row.netPnlRub ?? row.pnlRub), 0);
        const wins = closedRoundTrips.filter(row => Number(row.netPnlRub ?? row.pnlRub) > 0).length;
        const losses = closedRoundTrips.filter(row => Number(row.netPnlRub ?? row.pnlRub) < 0).length;
        const diagnostics = closedRoundTrips.map(diagnoseRoundTrip);
        const matchingQuality = roundTrips.length > 0
            ? closedRoundTrips.length / roundTrips.length * 100
            : undefined;

        return {
            generatedAt: new Date().toISOString(),
            summary: {
                scannedTrades: rows.length,
                ignoredTrades,
                closed: closedRoundTrips.length,
                unmatchedSells: unmatchedSells.length,
                openLots: openLots.reduce((sum, row) => sum + row.lots, 0),
                openPositions: new Set(openLots.map(row => `${row.accountId}:${row.ticker}`)).size,
                matchingQuality,
                realizedPnlRub: realizedGrossPnlRub,
                realizedGrossPnlRub,
                commissionRub,
                realizedNetPnlRub,
                wins,
                losses,
                winRate: closedRoundTrips.length > 0 ? wins / closedRoundTrips.length * 100 : undefined,
                averagePnlRub: closedRoundTrips.length > 0 ? realizedNetPnlRub / closedRoundTrips.length : undefined,
                averageGrossPnlRub: closedRoundTrips.length > 0 ? realizedGrossPnlRub / closedRoundTrips.length : undefined,
                averageNetPnlRub: closedRoundTrips.length > 0 ? realizedNetPnlRub / closedRoundTrips.length : undefined,
                accounting: commissionByOrderId.size > 0 ? 'net' : 'gross',
                note: unmatchedSells.length > 0
                    ? 'Unmatched sells usually mean the matching window did not include the original buy, or the sell came from a non-robot/manual position.'
                    : undefined
            },
            roundTrips: roundTrips.reverse(),
            closedRoundTrips: closedRoundTrips.slice().reverse(),
            unmatchedSells: unmatchedSells.slice().reverse(),
            openLots,
            breakdowns: {
                byDate: summarize(closedRoundTrips, row => dateLabel(row.exitAt)),
                byEntrySignal: summarize(closedRoundTrips, row => sourceLabel(row.entrySignalSource)),
                byExitSignal: summarize(closedRoundTrips, row => sourceLabel(row.exitSignalSource)),
                byTicker: summarize(closedRoundTrips, row => sourceLabel(row.ticker)),
                byDiagnosis: summarizeDiagnostics(diagnostics)
            },
            diagnostics
        };
    }
}
