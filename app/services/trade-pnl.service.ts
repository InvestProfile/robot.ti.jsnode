import { Op } from 'sequelize';
import { RobotConfig } from '../config/robot.config';
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

const toNumber = (value: unknown) => {
    const number = Number(value ?? 0);
    return Number.isFinite(number) ? number : 0;
};

const tradeTime = (row: Record<string, unknown>) => String(row.tradeDateTime || row.createdAt || '');

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

const tradeAmount = (row: Record<string, unknown>, lots: number) => {
    const amount = TradesService.amountFromTrade(row);
    if (amount !== undefined) return amount;

    const price = priceFromTrade(row);
    const lotSize = Math.max(1, toNumber(row.lot) || 1);
    return price ? price * lots * lotSize : undefined;
};

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
                const queue = openBuys.get(key) ?? [];
                queue.push({
                    row,
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
                entryTradeIds: entries.map(entry => entry.id),
                exitTradeId: row.id
            });
        }

        const closedRoundTrips = roundTrips.filter(row => Number.isFinite(Number(row.pnlRub)));
        const realizedPnlRub = closedRoundTrips.reduce((sum, row) => sum + Number(row.pnlRub), 0);
        const wins = closedRoundTrips.filter(row => Number(row.pnlRub) > 0).length;
        const losses = closedRoundTrips.filter(row => Number(row.pnlRub) < 0).length;

        return {
            generatedAt: new Date().toISOString(),
            summary: {
                scannedTrades: rows.length,
                ignoredTrades,
                closed: closedRoundTrips.length,
                unmatchedSells: roundTrips.length - closedRoundTrips.length,
                realizedPnlRub,
                wins,
                losses,
                winRate: closedRoundTrips.length > 0 ? wins / closedRoundTrips.length * 100 : undefined,
                averagePnlRub: closedRoundTrips.length > 0 ? realizedPnlRub / closedRoundTrips.length : undefined,
                accounting: 'gross'
            },
            roundTrips: roundTrips.reverse()
        };
    }
}
