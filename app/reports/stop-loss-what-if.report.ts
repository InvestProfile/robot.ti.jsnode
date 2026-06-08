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
    minAgeMinutes?: number;
    hardMultiplier?: number;
    confirmationBufferPercent?: number;
}

interface ScenarioMetrics {
    label: string;
    thresholdAvg?: number;
    stopRows: number;
    stillStopped: number;
    deferred: number;
    deferredBeforeMinAge: number;
    deferredByConfirmation: number;
    deferredNetPnlRub: number;
    deferredGrossPnlRub: number;
    deferredAvgLossPercent?: number;
    deferredMaxLossPercent?: number;
    stillStoppedNetPnlRub: number;
    stillStoppedAvgLossPercent?: number;
    hardStopped: number;
    score: number;
}

interface TrailingActivationMetrics {
    label: string;
    minProfitPercent: number;
    trailingRows: number;
    wouldExit: number;
    wouldHold: number;
    heldNetPnlRub: number;
    heldAvgProfitPercent?: number;
    exitNetPnlRub: number;
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

const durationMinutes = (entryAt: unknown, exitAt: unknown) => {
    const entry = timestamp(entryAt);
    const exit = timestamp(exitAt);
    if (entry <= 0 || exit <= 0 || exit < entry) return undefined;
    return (exit - entry) / 60_000;
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

const shouldDeferStop = (row: RoundTrip, threshold: number, scenario: Scenario) => {
    const lossPercent = absLossPercent(row);
    if (lossPercent === undefined) return { defer: false, beforeMinAge: false, byConfirmation: false, hardStopped: false };

    const ageMinutes = durationMinutes(row.entryAt, row.exitAt);
    const minAgeMinutes = scenario.minAgeMinutes ?? 0;
    const hardMultiplier = scenario.hardMultiplier ?? 1;
    const hardStop = threshold * hardMultiplier;
    const beforeMinAge = minAgeMinutes > 0
        && ageMinutes !== undefined
        && ageMinutes >= 0
        && ageMinutes < minAgeMinutes
        && lossPercent < hardStop;
    const byConfirmation = (scenario.confirmationBufferPercent ?? 0) > 0
        && lossPercent < threshold + Number(scenario.confirmationBufferPercent ?? 0);

    if (lossPercent < threshold) return { defer: true, beforeMinAge, byConfirmation, hardStopped: false };
    if (beforeMinAge || byConfirmation) return { defer: true, beforeMinAge, byConfirmation, hardStopped: false };

    return { defer: false, beforeMinAge: false, byConfirmation: false, hardStopped: lossPercent >= hardStop };
};

const evaluateScenario = (rows: RoundTrip[], scenario: Scenario): ScenarioMetrics => {
    const thresholds: number[] = [];
    const deferredRows: RoundTrip[] = [];
    const stillStoppedRows: RoundTrip[] = [];
    let deferredBeforeMinAge = 0;
    let deferredByConfirmation = 0;
    let hardStopped = 0;

    for (const row of rows) {
        const lossPercent = absLossPercent(row);
        if (lossPercent === undefined) continue;

        const threshold = stopThresholdFor(row, scenario);
        thresholds.push(threshold);
        const decision = shouldDeferStop(row, threshold, scenario);

        if (decision.defer) {
            deferredRows.push(row);
            if (decision.beforeMinAge) deferredBeforeMinAge += 1;
            if (decision.byConfirmation) deferredByConfirmation += 1;
        } else {
            stillStoppedRows.push(row);
            if (decision.hardStopped) hardStopped += 1;
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
        deferredBeforeMinAge,
        deferredByConfirmation,
        deferredNetPnlRub: deferredRows.reduce((sum, row) => sum + netPnlRub(row), 0),
        deferredGrossPnlRub: deferredRows.reduce((sum, row) => sum + grossPnlRub(row), 0),
        deferredAvgLossPercent: average(deferredLossPercents),
        deferredMaxLossPercent: deferredLossPercents.length > 0 ? Math.max(...deferredLossPercents) : undefined,
        stillStoppedNetPnlRub: stillStoppedRows.reduce((sum, row) => sum + netPnlRub(row), 0),
        stillStoppedAvgLossPercent: average(stillStoppedLossPercents),
        hardStopped,
        score: deferredRows.reduce((sum, row) => sum - Math.min(0, netPnlRub(row)), 0)
            - stillStoppedRows.reduce((sum, row) => sum + Math.max(0, netPnlRub(row)), 0) * 0.25
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
        label: 'soft 30m x1.7',
        baseStopPercent: config.stopLossPercent,
        volatilityMultiplier: config.stopLossVolatilityMultiplier,
        maxStopPercent: config.stopLossMaxPercent,
        minAgeMinutes: 30,
        hardMultiplier: 1.7
    },
    {
        label: 'soft 60m x2',
        baseStopPercent: config.stopLossPercent,
        volatilityMultiplier: config.stopLossVolatilityMultiplier,
        maxStopPercent: config.stopLossMaxPercent,
        minAgeMinutes: 60,
        hardMultiplier: 2
    },
    {
        label: 'confirm +0.7%',
        baseStopPercent: config.stopLossPercent,
        volatilityMultiplier: config.stopLossVolatilityMultiplier,
        maxStopPercent: config.stopLossMaxPercent,
        confirmationBufferPercent: 0.7
    },
    {
        label: 'soft+confirm',
        baseStopPercent: config.stopLossPercent,
        volatilityMultiplier: config.stopLossVolatilityMultiplier,
        maxStopPercent: config.stopLossMaxPercent,
        minAgeMinutes: 30,
        hardMultiplier: 1.7,
        confirmationBufferPercent: 0.7
    },
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
        String(metrics.deferredBeforeMinAge).padStart(6),
        String(metrics.deferredByConfirmation).padStart(7),
        String(metrics.hardStopped).padStart(5),
        format(metrics.deferredNetPnlRub).padStart(12),
        format(metrics.deferredGrossPnlRub).padStart(12),
        `${format(metrics.deferredAvgLossPercent)}%`.padStart(11),
        `${format(metrics.deferredMaxLossPercent)}%`.padStart(11),
        format(metrics.stillStoppedNetPnlRub).padStart(13),
        `${format(metrics.stillStoppedAvgLossPercent)}%`.padStart(13),
        format(metrics.score).padStart(9)
    ].join('  '));
};

const printTopScenarios = (metrics: ScenarioMetrics[]) => {
    console.log('Practical What-if Candidates');
    console.log('----------------------------');
    console.log('Scenario            Deferred  Def net RUB  Sold  Hard  DefLoss  Read');
    console.log('------------------  --------  -----------  ----  ----  -------  -------------------------------');
    for (const row of metrics
        .filter(item => item.label !== 'current adaptive')
        .filter(item => item.stillStopped > 0)
        .slice()
        .sort((a, b) => b.score - a.score)
        .slice(0, 6)) {
        const read = row.deferred === 0
            ? 'no effect on sampled stops'
            : row.hardStopped > 0
                ? 'keeps hard-stop escape'
                : 'defer-only: needs live watch';
        console.log([
            row.label.padEnd(18),
            String(row.deferred).padStart(8),
            format(row.deferredNetPnlRub).padStart(11),
            String(row.stillStopped).padStart(4),
            String(row.hardStopped).padStart(4),
            format(row.score).padStart(7),
            read
        ].join('  '));
    }
    console.log('');
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

const trailingProfitPercent = (row: RoundTrip) =>
    parsePercentAfter(row.exitDecisionReason, 'profit')
        ?? toNumber(row.netPnlPercent ?? row.pnlPercent);

const evaluateTrailingActivation = (rows: RoundTrip[], minProfitPercent: number): TrailingActivationMetrics => {
    const heldRows: RoundTrip[] = [];
    const exitRows: RoundTrip[] = [];

    for (const row of rows) {
        const profit = trailingProfitPercent(row);
        if (profit !== undefined && profit < minProfitPercent) heldRows.push(row);
        else exitRows.push(row);
    }

    const heldProfits = heldRows
        .map(trailingProfitPercent)
        .filter((value): value is number => value !== undefined);

    return {
        label: `trail >= ${minProfitPercent}%`,
        minProfitPercent,
        trailingRows: rows.length,
        wouldExit: exitRows.length,
        wouldHold: heldRows.length,
        heldNetPnlRub: heldRows.reduce((sum, row) => sum + netPnlRub(row), 0),
        heldAvgProfitPercent: average(heldProfits),
        exitNetPnlRub: exitRows.reduce((sum, row) => sum + netPnlRub(row), 0)
    };
};

const printTrailingActivation = (roundTrips: RoundTrip[]) => {
    const trailingRows = roundTrips.filter(row => sourceLabel(row.exitSignalSource) === 'trailing-stop');
    if (trailingRows.length === 0) return;

    console.log('Trailing Activation What-if');
    console.log('---------------------------');
    console.log('Scenario      Rows  Exit  Hold  Held net RUB  Held avg%  Exit net RUB');
    console.log('------------  ----  ----  ----  ------------  ---------  ------------');
    for (const row of [1, 2, 3, 4].map(value => evaluateTrailingActivation(trailingRows, value))) {
        console.log([
            row.label.padEnd(12),
            String(row.trailingRows).padStart(4),
            String(row.wouldExit).padStart(4),
            String(row.wouldHold).padStart(4),
            format(row.heldNetPnlRub).padStart(12),
            `${format(row.heldAvgProfitPercent)}%`.padStart(9),
            format(row.exitNetPnlRub).padStart(12)
        ].join('  '));
    }
    console.log('');
};

const main = async () => {
    const limit = Math.min(Math.max(Number(process.argv[2] || 500), 1), 2_000);
    const includeCommissions = process.argv.includes('--net');
    const config = getRobotConfig();
    const report = await TradePnlService.getRoundTripPnl(config, limit, { includeCommissions });
    const roundTrips = report.closedRoundTrips as RoundTrip[];
    const stopRows = roundTrips.filter(row => STOP_SOURCES.has(sourceLabel(row.exitSignalSource)));
    const scenarioMetrics = scenarios(config).map(row => evaluateScenario(stopRows, row));

    console.log('Stop-loss What-if');
    console.log('=================');
    console.log(`Generated: ${report.generatedAt}`);
    console.log(`Scanned closed round-trips: ${roundTrips.length}`);
    console.log(`Stop exits: ${stopRows.length}`);
    console.log(`Accounting: ${includeCommissions ? report.summary.accounting : 'gross-fast'}${includeCommissions ? '' : ' (pass --net to fetch/match commissions)'}`);
    console.log(`Config: base ${format(config.stopLossPercent)}%, volatility x${format(config.stopLossVolatilityMultiplier)}, max ${format(config.stopLossMaxPercent)}%`);
    console.log('');
    console.log('Important: deferred means the position would not have been sold at that stop trigger.');
    console.log('It is not counted as saved profit because the later price path is unknown.');
    console.log('');
    console.log('Scenario             AvgStop  Stops  Sold  Deferred  <Age  Confirm  Hard  Def net RUB  Def gross   Def avg%   Def max%  Sold net RUB  Sold avg%  Score');
    console.log('------------------  -------  -----  ----  --------  ----  -------  ----  -----------  ----------  ---------  ---------  ------------  ---------  -----');
    for (const scenario of scenarioMetrics) {
        printScenario(scenario);
    }
    console.log('');

    printTopScenarios(scenarioMetrics);
    printTrailingActivation(roundTrips);
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
