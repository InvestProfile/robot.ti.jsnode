import sequelize from '../config/database';
import { getRobotConfig } from '../config/robot.config';
import TradePnlService from '../services/trade-pnl.service';

const BUY_MIN_SCORES = [75, 80, 82];
const TRAILING_MIN_PROFITS = [1.0, 1.5];

interface RoundTrip {
    accountId?: unknown;
    ticker?: unknown;
    entryAt?: unknown;
    exitAt?: unknown;
    pnlRub?: unknown;
    pnlPercent?: unknown;
    entryDecisionReason?: unknown;
    exitSignalSource?: unknown;
}

interface Scenario {
    buyMinScore: number;
    trailingStopMinProfitPercent: number;
    blockSameTickerDay: boolean;
    blockAfterStopLossDay: boolean;
}

interface Metrics {
    kept: number;
    filteredByScore: number;
    filteredBySameTickerDay: number;
    filteredByStopLossDay: number;
    deferredTrailing: number;
    grossPnlRub: number;
    wins: number;
    losses: number;
    winRate?: number;
    averagePnlRub?: number;
    averageWinRub?: number;
    averageLossRub?: number;
}

const toNumber = (value: unknown) => {
    const number = Number(value);
    return Number.isFinite(number) ? number : undefined;
};

const format = (value: number | undefined, digits = 2) =>
    value === undefined || !Number.isFinite(value) ? '-' : value.toFixed(digits);

const sourceLabel = (value: unknown) => String(value || 'unknown');

const parseScore = (reason: unknown) => {
    const match = String(reason || '').match(/score\s+(-?\d+(?:\.\d+)?)(?:\/\d+)?/i);
    if (!match) return undefined;

    return toNumber(match[1]);
};

const timestamp = (value: unknown) => {
    const time = new Date(String(value || '')).getTime();
    return Number.isFinite(time) ? time : 0;
};

const moscowDay = (value: unknown) => {
    const date = new Date(String(value || ''));
    if (Number.isNaN(date.getTime())) return 'unknown';

    return new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Europe/Moscow',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    }).format(date);
};

const roundKey = (row: RoundTrip) =>
    [
        String(row.accountId || ''),
        String(row.ticker || '').toUpperCase(),
        moscowDay(row.entryAt)
    ].join(':');

const evaluateScenario = (roundTrips: RoundTrip[], scenario: Scenario): Metrics => {
    const entrySeen = new Set<string>();
    const stopLossBlocked = new Set<string>();
    const keptRows: RoundTrip[] = [];
    let filteredByScore = 0;
    let filteredBySameTickerDay = 0;
    let filteredByStopLossDay = 0;
    let deferredTrailing = 0;

    for (const row of roundTrips.slice().sort((a, b) => timestamp(a.entryAt) - timestamp(b.entryAt))) {
        const key = roundKey(row);
        const score = parseScore(row.entryDecisionReason);

        if (score !== undefined && score < scenario.buyMinScore) {
            filteredByScore += 1;
            continue;
        }

        if (scenario.blockAfterStopLossDay && stopLossBlocked.has(key)) {
            filteredByStopLossDay += 1;
            continue;
        }

        if (scenario.blockSameTickerDay && entrySeen.has(key)) {
            filteredBySameTickerDay += 1;
            continue;
        }

        entrySeen.add(key);

        const exitSource = sourceLabel(row.exitSignalSource);
        const pnlPercent = toNumber(row.pnlPercent);
        if (
            exitSource === 'trailing-stop'
            && pnlPercent !== undefined
            && pnlPercent < scenario.trailingStopMinProfitPercent
        ) {
            deferredTrailing += 1;
            continue;
        }

        keptRows.push(row);

        if (exitSource === 'stop-loss') {
            stopLossBlocked.add(key);
        }
    }

    const pnlValues = keptRows
        .map(row => toNumber(row.pnlRub))
        .filter((value): value is number => value !== undefined);
    const wins = pnlValues.filter(value => value > 0);
    const losses = pnlValues.filter(value => value < 0);
    const grossPnlRub = pnlValues.reduce((sum, value) => sum + value, 0);

    return {
        kept: pnlValues.length,
        filteredByScore,
        filteredBySameTickerDay,
        filteredByStopLossDay,
        deferredTrailing,
        grossPnlRub,
        wins: wins.length,
        losses: losses.length,
        winRate: pnlValues.length > 0 ? wins.length / pnlValues.length * 100 : undefined,
        averagePnlRub: pnlValues.length > 0 ? grossPnlRub / pnlValues.length : undefined,
        averageWinRub: wins.length > 0 ? wins.reduce((sum, value) => sum + value, 0) / wins.length : undefined,
        averageLossRub: losses.length > 0 ? losses.reduce((sum, value) => sum + value, 0) / losses.length : undefined
    };
};

const scenarios = (): Scenario[] => {
    const rows: Scenario[] = [];

    for (const buyMinScore of BUY_MIN_SCORES) {
        for (const trailingStopMinProfitPercent of TRAILING_MIN_PROFITS) {
            for (const blockSameTickerDay of [false, true]) {
                for (const blockAfterStopLossDay of [false, true]) {
                    rows.push({
                        buyMinScore,
                        trailingStopMinProfitPercent,
                        blockSameTickerDay,
                        blockAfterStopLossDay
                    });
                }
            }
        }
    }

    return rows;
};

const printScenario = (scenario: Scenario, metrics: Metrics, baselineCount: number) => {
    console.log([
        String(scenario.buyMinScore).padStart(3),
        format(scenario.trailingStopMinProfitPercent, 1).padStart(5),
        String(scenario.blockSameTickerDay ? 'yes' : 'no').padStart(6),
        String(scenario.blockAfterStopLossDay ? 'yes' : 'no').padStart(9),
        String(metrics.kept).padStart(4),
        String(baselineCount - metrics.kept).padStart(7),
        String(metrics.filteredByScore).padStart(5),
        String(metrics.filteredBySameTickerDay).padStart(8),
        String(metrics.filteredByStopLossDay).padStart(9),
        String(metrics.deferredTrailing).padStart(8),
        format(metrics.grossPnlRub).padStart(9),
        format(metrics.winRate, 0).padStart(4),
        format(metrics.averagePnlRub).padStart(8),
        format(metrics.averageWinRub).padStart(8),
        format(metrics.averageLossRub).padStart(9)
    ].join('  '));
};

const main = async () => {
    const config = getRobotConfig();
    const report = await TradePnlService.getRoundTripPnl(config, 2_000);
    const roundTrips = report.closedRoundTrips as RoundTrip[];
    const baseline = evaluateScenario(roundTrips, {
        buyMinScore: 0,
        trailingStopMinProfitPercent: Number.NEGATIVE_INFINITY,
        blockSameTickerDay: false,
        blockAfterStopLossDay: false
    });

    console.log('Round-trip What-if');
    console.log('==================');
    console.log(`Generated: ${report.generatedAt}`);
    console.log(`Closed round-trips: ${roundTrips.length}`);
    console.log(`Baseline gross P/L: ${format(baseline.grossPnlRub)} RUB`);
    console.log(`Baseline win-rate: ${format(baseline.winRate, 0)}%`);
    console.log(`Baseline avg win/loss: ${format(baseline.averageWinRub)} / ${format(baseline.averageLossRub)} RUB`);
    console.log('');
    console.log('min  trail  sameD  afterSLd  kept  cut     score  sameDay  stopDay  trailDef  grossPnl  WR%   avgPnl  avgWin  avgLoss');
    console.log('---  -----  ------  --------  ----  ------  -----  -------  -------  --------  --------  ----  ------  ------  -------');

    const evaluated = scenarios()
        .map(scenario => ({
            scenario,
            metrics: evaluateScenario(roundTrips, scenario)
        }))
        .sort((a, b) => b.metrics.grossPnlRub - a.metrics.grossPnlRub);

    for (const row of evaluated) {
        printScenario(row.scenario, row.metrics, roundTrips.length);
    }
};

void main()
    .catch(error => {
        console.error('Round-trip what-if failed:', error);
        process.exitCode = 1;
    })
    .finally(async () => {
        await sequelize.close().catch(() => undefined);
    });
