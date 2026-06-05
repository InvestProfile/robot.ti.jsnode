import sequelize from '../config/database';
import { getRobotConfig } from '../config/robot.config';
import TradePnlService from '../services/trade-pnl.service';

interface RoundTrip {
    ticker?: unknown;
    name?: unknown;
    entryAt?: unknown;
    exitAt?: unknown;
    lots?: unknown;
    grossPnlRub?: unknown;
    commissionRub?: unknown;
    netPnlRub?: unknown;
    pnlRub?: unknown;
    pnlPercent?: unknown;
    netPnlPercent?: unknown;
    exitSignalSource?: unknown;
    exitDecisionReason?: unknown;
}

interface Scenario {
    label: string;
    fixedStopPercent?: number;
    baseStopPercent?: number;
    volatilityMultiplier?: number;
    maxStopPercent?: number;
}

interface ScenarioMetrics {
    label: string;
    thresholdAvg?: number;
    stopRows: number;
    stillStopped: number;
    deferred: number;
    deferredNetPnlRub: number;
    deferredGrossPnlRub: number;
    deferredAvgLossPercent?: number;
    deferredMaxLossPercent?: number;
    stillStoppedNetPnlRub: number;
    stillStoppedAvgLossPercent?: number;
}

const STOP_SOURCES = new Set(['stop-loss', 'broker-stop-loss']);

const toNumber = (value: unknown) => {
    const number = Number(value);
    return Number.isFinite(number) ? number : undefined;
};

const format = (value: number | undefined, digits = 2) =>
    value === undefined || !Number.isFinite(value) ? '-' : value.toFixed(digits);

const sourceLabel = (value: unknown) => String(value || 'unknown');

const tickerLabel = (row: RoundTrip) => String(row.ticker || 'UNKNOWN').toUpperCase();

const timestamp = (value: unknown) => {
    const time = new Date(String(value || '')).getTime();
    return Number.isFinite(time) ? time : 0;
};

const parsePercentAfter = (reason: unknown, label: string) => {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = String(reason || '').match(new RegExp(`${escaped}\\s+(-?\\d+(?:\\.\\d+)?)%`, 'i'));
    return match ? toNumber(match[1]) : undefined;
};

const average = (values: number[]) =>
    values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : undefined;

const absLossPercent = (row: RoundTrip) => {
    const value = toNumber(row.netPnlPercent ?? row.pnlPercent);
    if (value === undefined) return undefined;
    return Math.max(0, -value);
};

const netPnlRub = (row: RoundTrip) => toNumber(row.netPnlRub ?? row.pnlRub) ?? 0;

const grossPnlRub = (row: RoundTrip) => toNumber(row.grossPnlRub ?? row.pnlRub) ?? 0;

const stopThresholdFor = (row: RoundTrip, scenario: Scenario) => {
    if (scenario.fixedStopPercent !== undefined) return scenario.fixedStopPercent;

    const base = scenario.baseStopPercent ?? 0;
    const avgRange = parsePercentAfter(row.exitDecisionReason, 'avg range');
    const volatilityStop = avgRange !== undefined && scenario.volatilityMultiplier !== undefined
        ? avgRange * scenario.volatilityMultiplier
        : undefined;
    const rawStop = Math.max(base, volatilityStop ?? 0);
    const maxStop = scenario.maxStopPercent;

    if (maxStop !== undefined && maxStop > 0) return Math.min(rawStop, maxStop);
    return rawStop;
};

const evaluateScenario = (rows: RoundTrip[], scenario: Scenario): ScenarioMetrics => {
    const thresholds: number[] = [];
    const deferredRows: RoundTrip[] = [];
    const stillStoppedRows: RoundTrip[] = [];

    for (const row of rows) {
        const lossPercent = absLossPercent(row);
        if (lossPercent === undefined) continue;

        const threshold = stopThresholdFor(row, scenario);
        thresholds.push(threshold);

        if (lossPercent < threshold) {
            deferredRows.push(row);
        } else {
            stillStoppedRows.push(row);
        }
    }

    const deferredLossPercents = deferredRows
        .map(absLossPercent)
        .filter((value): value is number => value !== undefined);
    const stillStoppedLossPercents = stillStoppedRows
        .map(absLossPercent)
        .filter((value): value is number => value !== undefined);

    return {
        label: scenario.label,
        thresholdAvg: average(thresholds),
        stopRows: rows.length,
        stillStopped: stillStoppedRows.length,
        deferred: deferredRows.length,
        deferredNetPnlRub: deferredRows.reduce((sum, row) => sum + netPnlRub(row), 0),
        deferredGrossPnlRub: deferredRows.reduce((sum, row) => sum + grossPnlRub(row), 0),
        deferredAvgLossPercent: average(deferredLossPercents),
        deferredMaxLossPercent: deferredLossPercents.length > 0 ? Math.max(...deferredLossPercents) : undefined,
        stillStoppedNetPnlRub: stillStoppedRows.reduce((sum, row) => sum + netPnlRub(row), 0),
        stillStoppedAvgLossPercent: average(stillStoppedLossPercents)
    };
};

const scenarios = (config: ReturnType<typeof getRobotConfig>): Scenario[] => [
    {
        label: 'current adaptive',
        baseStopPercent: config.stopLossPercent,
        volatilityMultiplier: config.stopLossVolatilityMultiplier,
        maxStopPercent: config.stopLossMaxPercent
    },
    { label: 'fixed 4%', fixedStopPercent: 4 },
    { label: 'fixed 5%', fixedStopPercent: 5 },
    { label: 'fixed 6%', fixedStopPercent: 6 },
    {
        label: 'ATR x1.5 max8',
        baseStopPercent: config.stopLossPercent,
        volatilityMultiplier: 1.5,
        maxStopPercent: 8
    },
    {
        label: 'ATR x2 max10',
        baseStopPercent: config.stopLossPercent,
        volatilityMultiplier: 2,
        maxStopPercent: 10
    }
];

const printScenario = (metrics: ScenarioMetrics) => {
    console.log([
        metrics.label.padEnd(18),
        format(metrics.thresholdAvg).padStart(7),
        String(metrics.stopRows).padStart(5),
        String(metrics.stillStopped).padStart(6),
        String(metrics.deferred).padStart(8),
        format(metrics.deferredNetPnlRub).padStart(12),
        format(metrics.deferredGrossPnlRub).padStart(12),
        `${format(metrics.deferredAvgLossPercent)}%`.padStart(11),
        `${format(metrics.deferredMaxLossPercent)}%`.padStart(11),
        format(metrics.stillStoppedNetPnlRub).padStart(13),
        `${format(metrics.stillStoppedAvgLossPercent)}%`.padStart(13)
    ].join('  '));
};

const printWorstStops = (rows: RoundTrip[]) => {
    console.log('Recent Stop Exits');
    console.log('-----------------');
    console.log('Exit time             Ticker  Source            Net RUB   Net%     Gross    Stop%   Range%  Reason');
    console.log('-------------------  ------  ----------------  --------  -------  -------  ------  ------  ----------------------------------------');
    for (const row of rows
        .slice()
        .sort((a, b) => timestamp(b.exitAt) - timestamp(a.exitAt))
        .slice(0, 16)) {
        console.log([
            String(row.exitAt || '-').slice(0, 19).replace('T', ' ').padEnd(19),
            tickerLabel(row).padEnd(6),
            sourceLabel(row.exitSignalSource).padEnd(16),
            format(netPnlRub(row)).padStart(8),
            `${format(toNumber(row.netPnlPercent ?? row.pnlPercent))}%`.padStart(7),
            format(grossPnlRub(row)).padStart(7),
            `${format(parsePercentAfter(row.exitDecisionReason, 'adaptive stop'))}%`.padStart(6),
            `${format(parsePercentAfter(row.exitDecisionReason, 'avg range'))}%`.padStart(6),
            String(row.exitDecisionReason || '-').slice(0, 90)
        ].join('  '));
    }
    console.log('');
};

const printTickerSummary = (rows: RoundTrip[]) => {
    const groups = new Map<string, { ticker: string; count: number; net: number; gross: number; avgLosses: number[] }>();
    for (const row of rows) {
        const ticker = tickerLabel(row);
        const group = groups.get(ticker) ?? { ticker, count: 0, net: 0, gross: 0, avgLosses: [] };
        group.count += 1;
        group.net += netPnlRub(row);
        group.gross += grossPnlRub(row);
        const lossPercent = absLossPercent(row);
        if (lossPercent !== undefined) group.avgLosses.push(lossPercent);
        groups.set(ticker, group);
    }

    console.log('Stop Loss By Ticker');
    console.log('-------------------');
    console.log('Ticker   N     Net RUB  Gross RUB  Avg loss%');
    console.log('------  ---  ---------  ---------  ---------');
    for (const row of [...groups.values()]
        .sort((a, b) => a.net - b.net)
        .slice(0, 14)) {
        console.log([
            row.ticker.padEnd(6),
            String(row.count).padStart(3),
            format(row.net).padStart(9),
            format(row.gross).padStart(9),
            `${format(average(row.avgLosses))}%`.padStart(9)
        ].join('  '));
    }
    console.log('');
};

const main = async () => {
    const limit = Math.min(Math.max(Number(process.argv[2] || 500), 1), 2_000);
    const config = getRobotConfig();
    const report = await TradePnlService.getRoundTripPnl(config, limit);
    const roundTrips = report.closedRoundTrips as RoundTrip[];
    const stopRows = roundTrips.filter(row => STOP_SOURCES.has(sourceLabel(row.exitSignalSource)));

    console.log('Stop-loss What-if');
    console.log('=================');
    console.log(`Generated: ${report.generatedAt}`);
    console.log(`Scanned closed round-trips: ${roundTrips.length}`);
    console.log(`Stop exits: ${stopRows.length}`);
    console.log(`Config: base ${format(config.stopLossPercent)}%, volatility x${format(config.stopLossVolatilityMultiplier)}, max ${format(config.stopLossMaxPercent)}%`);
    console.log('');
    console.log('Important: deferred means the position would not have been sold at that stop trigger.');
    console.log('It is not counted as saved profit because the later price path is unknown.');
    console.log('');
    console.log('Scenario             AvgStop  Stops  Sold  Deferred  Def net RUB  Def gross   Def avg%   Def max%  Sold net RUB  Sold avg%');
    console.log('------------------  -------  -----  ----  --------  -----------  ----------  ---------  ---------  ------------  ---------');
    for (const scenario of scenarios(config).map(row => evaluateScenario(stopRows, row))) {
        printScenario(scenario);
    }
    console.log('');

    printWorstStops(stopRows);
    printTickerSummary(stopRows);
};

void main()
    .catch(error => {
        console.error('Stop-loss what-if failed:', error);
        process.exitCode = 1;
    })
    .finally(async () => {
        await sequelize.close().catch(() => undefined);
    });
