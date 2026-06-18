import { RobotConfig } from '../config/robot.config';
import TradePnlService from './trade-pnl.service';

type RoundTripRow = Record<string, unknown>;

interface ExitQualityGroup {
    key: string;
    label: string;
    count: number;
    wins: number;
    losses: number;
    grossPnlRub: number;
    commissionRub: number;
    netPnlRub: number;
    averageNetPnlRub?: number;
    winRate?: number;
    worstTicker?: string;
    worstNetPnlRub?: number;
    quality: 'good' | 'watch' | 'bad';
}

const STOP_EXIT_SOURCES = new Set(['stop-loss', 'broker-stop-loss']);

const toNumber = (value: unknown) => {
    const number = Number(value);
    return Number.isFinite(number) ? number : undefined;
};

const sourceLabel = (value: unknown) => String(value || 'unknown');

const tickerLabel = (row: RoundTripRow) => String(row.ticker || 'UNKNOWN').toUpperCase();

const netPnl = (row: RoundTripRow) => toNumber(row.netPnlRub ?? row.pnlRub) ?? 0;

const grossPnl = (row: RoundTripRow) => toNumber(row.grossPnlRub ?? row.pnlRub) ?? 0;

const commission = (row: RoundTripRow) => toNumber(row.commissionRub) ?? 0;

const exitSource = (row: RoundTripRow) => sourceLabel(row.exitSignalSource);

const isStopExit = (row: RoundTripRow) => STOP_EXIT_SOURCES.has(exitSource(row));

const createGroup = (key: string, label = key): ExitQualityGroup => ({
    key,
    label,
    count: 0,
    wins: 0,
    losses: 0,
    grossPnlRub: 0,
    commissionRub: 0,
    netPnlRub: 0,
    quality: 'watch'
});

const addToGroup = (group: ExitQualityGroup, row: RoundTripRow) => {
    const value = netPnl(row);
    group.count += 1;
    group.grossPnlRub += grossPnl(row);
    group.commissionRub += commission(row);
    group.netPnlRub += value;
    if (value > 0) group.wins += 1;
    if (value < 0) group.losses += 1;

    if (group.worstNetPnlRub === undefined || value < group.worstNetPnlRub) {
        group.worstNetPnlRub = value;
        group.worstTicker = tickerLabel(row);
    }
};

const finalizeGroup = (group: ExitQualityGroup) => {
    group.averageNetPnlRub = group.count > 0 ? group.netPnlRub / group.count : undefined;
    group.winRate = group.count > 0 ? group.wins / group.count * 100 : undefined;
    group.quality = group.netPnlRub < 0 && group.losses > group.wins
        ? 'bad'
        : group.netPnlRub < 0
            ? 'watch'
            : 'good';
    return group;
};

const groupBy = (rows: RoundTripRow[], keyFor: (row: RoundTripRow) => string, labelFor?: (key: string) => string) => {
    const groups = new Map<string, ExitQualityGroup>();

    for (const row of rows) {
        const key = keyFor(row);
        const group = groups.get(key) ?? createGroup(key, labelFor?.(key) ?? key);
        addToGroup(group, row);
        groups.set(key, group);
    }

    return [...groups.values()]
        .map(finalizeGroup)
        .sort((a, b) => a.netPnlRub - b.netPnlRub);
};

const buildOperatorText = (summary: {
    realizedNetPnlRub: number;
    stopDamageNetRub: number;
    commissionRub: number;
    openLots: number;
    worstTicker?: string;
    worstTickerNetPnlRub?: number;
}) => {
    if (summary.realizedNetPnlRub >= 0 && summary.stopDamageNetRub >= 0) {
        return 'Закрытые robot-owned пары сейчас в плюсе; стопы не являются главным источником просадки.';
    }

    if (summary.stopDamageNetRub < 0) {
        const tickerPart = summary.worstTicker
            ? ` Хуже всего ${summary.worstTicker}: ${summary.worstTickerNetPnlRub?.toFixed(2)} RUB.`
            : '';
        return `Главный ущерб дают stop-loss / broker-stop-loss: ${summary.stopDamageNetRub.toFixed(2)} RUB net.${tickerPart}`;
    }

    if (summary.commissionRub > Math.abs(summary.realizedNetPnlRub) * 0.4) {
        return `Комиссии заметно давят результат: ${summary.commissionRub.toFixed(2)} RUB при realized net ${summary.realizedNetPnlRub.toFixed(2)} RUB.`;
    }

    return `Realized net P/L отрицательный, но главный источник не стопы. Проверь P/L по сигналам выхода и худшие тикеры.`;
};

export default class ExitQualityService {
    static async getExitQuality(config: RobotConfig, limit = 500) {
        const safeLimit = Math.min(Math.max(Number.isFinite(limit) ? limit : 500, 1), 2_000);
        const pnl = await TradePnlService.getRoundTripPnl(config, safeLimit);
        const closedRows = (pnl.closedRoundTrips || []) as RoundTripRow[];
        const stopRows = closedRows.filter(isStopExit);
        const losingRows = closedRows.filter(row => netPnl(row) < 0);
        const byExitSignal = groupBy(closedRows, exitSource);
        const stopByTicker = groupBy(stopRows, tickerLabel);
        const worstExits = closedRows
            .slice()
            .sort((a, b) => netPnl(a) - netPnl(b))
            .slice(0, 12)
            .map(row => ({
                id: row.id,
                ticker: row.ticker,
                name: row.name,
                accountAlias: row.accountAlias,
                entryAt: row.entryAt,
                exitAt: row.exitAt,
                lots: row.lots,
                entrySignalSource: row.entrySignalSource,
                exitSignalSource: row.exitSignalSource,
                grossPnlRub: row.grossPnlRub,
                commissionRub: row.commissionRub,
                netPnlRub: row.netPnlRub,
                netPnlPercent: row.netPnlPercent,
                exitDecisionReason: row.exitDecisionReason || row.reason
            }));

        const stopDamageNetRub = stopRows.reduce((sum, row) => sum + Math.min(0, netPnl(row)), 0);
        const stopGrossPnlRub = stopRows.reduce((sum, row) => sum + grossPnl(row), 0);
        const stopCommissionRub = stopRows.reduce((sum, row) => sum + commission(row), 0);
        const worstTicker = stopByTicker[0];
        const realizedNetPnlRub = Number(pnl.summary.realizedNetPnlRub ?? pnl.summary.realizedPnlRub ?? 0);
        const commissionRub = Number(pnl.summary.commissionRub ?? 0);
        const unmatchedSells = Number(pnl.summary.unmatchedSells ?? 0);
        const matchingQuality = Number(pnl.summary.matchingQuality ?? 100);
        const quality: 'good' | 'watch' | 'bad' = unmatchedSells > 0 || matchingQuality < 95
            ? 'watch'
            : stopDamageNetRub < realizedNetPnlRub && stopDamageNetRub < 0
                ? 'bad'
                : realizedNetPnlRub < 0
                    ? 'watch'
                    : 'good';

        const summary = {
            scannedTrades: pnl.summary.scannedTrades,
            closedRoundTrips: closedRows.length,
            realizedGrossPnlRub: pnl.summary.realizedGrossPnlRub,
            commissionRub,
            realizedNetPnlRub,
            openLots: pnl.summary.openLots,
            openPositions: pnl.summary.openPositions,
            unmatchedSells,
            matchingQuality,
            accounting: pnl.summary.accounting,
            stopExits: stopRows.length,
            stopLossExits: stopRows.filter(row => exitSource(row) === 'stop-loss').length,
            brokerStopLossExits: stopRows.filter(row => exitSource(row) === 'broker-stop-loss').length,
            stopDamageNetRub,
            stopGrossPnlRub,
            stopCommissionRub,
            losingRoundTrips: losingRows.length,
            worstTicker: worstTicker?.key,
            worstTickerNetPnlRub: worstTicker?.netPnlRub,
            quality,
            topCause: buildOperatorText({
                realizedNetPnlRub,
                stopDamageNetRub,
                commissionRub,
                openLots: Number(pnl.summary.openLots ?? 0),
                worstTicker: worstTicker?.key,
                worstTickerNetPnlRub: worstTicker?.netPnlRub
            })
        };

        return {
            generatedAt: new Date().toISOString(),
            summary,
            breakdowns: {
                byExitSignal,
                stopByTicker,
                byTicker: groupBy(closedRows, tickerLabel)
            },
            worstExits
        };
    }
}
