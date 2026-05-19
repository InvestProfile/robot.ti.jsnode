import { Op } from 'sequelize';
import { RobotConfig } from '../config/robot.config';
import { TradeDecisionModel } from '../models/trade-decision.model';
import { TradesModel } from '../models/trades.model';
import TradesService from './trades.service';

const BUY_DIRECTION = '1';
const SELL_DIRECTION = '2';
const IGNORED_STATUSES = new Set([
    'LOCAL_PENDING_SUBMIT',
    'LOCAL_SUBMIT_UNKNOWN',
    'EXECUTION_REPORT_STATUS_NEW',
    'EXECUTION_REPORT_STATUS_REJECTED',
    'EXECUTION_REPORT_STATUS_CANCELLED'
]);

interface OpenBuy {
    row: Record<string, unknown>;
    remainingLots: number;
    unitAmount: number;
}

interface OpenLot {
    accountId: string;
    accountAlias?: string;
    ticker?: unknown;
    name?: unknown;
    lots: number;
    entryAt: string;
    entryAmount: number;
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
    if (status && IGNORED_STATUSES.has(status)) return 0;

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
    const pnlRub = Number(row.pnlRub);
    const entrySignal = sourceLabel(row.entrySignalSource);
    const exitSignal = sourceLabel(row.exitSignalSource);
    const entryScore = parseScore(row.entryDecisionReason);
    const holdMinutes = minutesBetween(row.entryAt, row.exitAt);
    const kind = exitKind(row.exitSignalSource, row.exitDecisionReason);
    const diagnoses = [];

    if (Number.isFinite(pnlRub)) {
        diagnoses.push(pnlRub >= 0 ? 'gross-profit' : 'gross-loss');
    }

    if (entrySignal === 'unknown') diagnoses.push('missing-entry-signal');
    if (exitSignal === 'unknown') diagnoses.push('missing-exit-signal');
    if (kind !== 'unknown') diagnoses.push(`exit:${kind}`);
    diagnoses.push('execution:gross-only');

    return {
        id: row.id,
        ticker: row.ticker,
        name: row.name,
        pnlRub: row.pnlRub,
        pnlPercent: row.pnlPercent,
        entrySignalSource: row.entrySignalSource,
        exitSignalSource: row.exitSignalSource,
        entryScore,
        exitKind: kind,
        holdMinutes,
        entryAt: row.entryAt,
        exitAt: row.exitAt,
        diagnoses,
        executionAccounting: 'gross-only',
        note: 'No separate commission/slippage fields are available in this report yet.'
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

        return {
            accountId,
            accountAlias: config.accountAliases[accountId],
            ticker: buy.row.ticker,
            name: buy.row.name,
            lots: buy.remainingLots,
            entryAt: tradeTime(buy.row),
            entryAmount,
            entryPrice: buy.unitAmount,
            entrySignalSource: buy.row.signalSource,
            entryDecisionReason: buy.row.decisionReason,
            entryTradeId: buy.row.id
        };
    })
    .sort((a, b) => new Date(b.entryAt).getTime() - new Date(a.entryAt).getTime());

export default class TradePnlService {
    static async getRoundTripPnl(config: RobotConfig, limit = 500) {
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
            .reverse();
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
        const openBuys = new Map<string, OpenBuy[]>();
        const roundTrips = [];
        let ignoredTrades = 0;

        for (const row of rows) {
            const status = row.status ? String(row.status) : undefined;
            if (status && IGNORED_STATUSES.has(status)) {
                ignoredTrades += 1;
                continue;
            }

            const direction = directionFromTrade(row);
            const lots = lotsFromTrade(row);
            const amount = tradeAmount(row, lots);
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
                    unitAmount: amount / lots
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
            const entries: Record<string, unknown>[] = [];
            const queue = openBuys.get(key) ?? [];

            while (remainingSellLots > 0 && queue.length > 0) {
                const buy = queue[0];
                const matched = Math.min(remainingSellLots, buy.remainingLots);
                matchedLots += matched;
                entryAmount += buy.unitAmount * matched;
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
            const pnlRub = matchedExitAmount - entryAmount;
            const pnlPercent = entryAmount > 0 ? pnlRub / entryAmount * 100 : undefined;

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
                pnlRub,
                pnlPercent,
                status: remainingSellLots > 0 ? 'partial' : 'closed',
                reason: entries.length > 1 ? `Matched ${entries.length} buy trades by FIFO.` : 'Matched buy -> sell by FIFO.',
                entrySignalSource: entries[0]?.signalSource,
                exitSignalSource: exitDecision?.signalSource,
                entryDecisionReason: entries[0]?.decisionReason,
                exitDecisionReason: exitDecision?.reason,
                entryDecisionId: entries[0]?.decisionId,
                exitDecisionId: exitDecision?.id,
                entryTradeIds: entries.map(entry => entry.id),
                exitTradeId: row.id
            });
        }

        const openLots = flattenOpenLots(openBuys, config);
        const closedRoundTrips = roundTrips.filter(row => Number.isFinite(Number(row.pnlRub)));
        const unmatchedSells = roundTrips.filter(row => row.status === 'unmatched');
        const realizedPnlRub = closedRoundTrips.reduce((sum, row) => sum + Number(row.pnlRub), 0);
        const wins = closedRoundTrips.filter(row => Number(row.pnlRub) > 0).length;
        const losses = closedRoundTrips.filter(row => Number(row.pnlRub) < 0).length;
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
                realizedPnlRub,
                wins,
                losses,
                winRate: closedRoundTrips.length > 0 ? wins / closedRoundTrips.length * 100 : undefined,
                averagePnlRub: closedRoundTrips.length > 0 ? realizedPnlRub / closedRoundTrips.length : undefined,
                accounting: 'gross',
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
