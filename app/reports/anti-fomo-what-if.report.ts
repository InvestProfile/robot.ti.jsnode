import sequelize from '../config/database';
import { getRobotConfig } from '../config/robot.config';
import DatabaseService from '../services/database.service';
import TradePnlService from '../services/trade-pnl.service';

interface RoundTrip {
    ticker?: unknown;
    name?: unknown;
    instrumentId?: unknown;
    figi?: unknown;
    entryAt?: unknown;
    exitAt?: unknown;
    entrySignalSource?: unknown;
    exitSignalSource?: unknown;
    entryDecisionReason?: unknown;
    grossPnlRub?: unknown;
    netPnlRub?: unknown;
    pnlRub?: unknown;
    pnlPercent?: unknown;
    netPnlPercent?: unknown;
}

interface FomoDecision {
    row: RoundTrip;
    ticker: string;
    momentumPercent?: number;
    belowHighPercent?: number;
    volatilityProxyPercent?: number;
    rangeExtensionLimitPercent?: number;
    oldBlocked: boolean;
    rangeBlocked: boolean;
    newBlocked: boolean;
    reason: string;
}

interface ScenarioMetrics {
    multiplier: number;
    cut: number;
    kept: number;
    keptPnlRub: number;
    blockedLosers: number;
    savedLossRub: number;
    blockedWinners: number;
    missedProfitRub: number;
    netEffectRub: number;
}

const SCENARIO_MULTIPLIERS = [0.8, 1.0, 1.2, 1.5, 2.0];
const toNumber = (value: unknown) => {
    const number = Number(value);
    return Number.isFinite(number) ? number : undefined;
};

const format = (value: number | undefined, digits = 2) =>
    value === undefined || !Number.isFinite(value) ? '-' : value.toFixed(digits);

const formatRub = (value: number | undefined) => `${format(value)} RUB`;

const tickerLabel = (row: RoundTrip) => String(row.ticker || 'UNKNOWN').toUpperCase();

const sourceLabel = (value: unknown) => String(value || 'unknown');

const parsePercentAfter = (reason: unknown, label: string) => {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = String(reason || '').match(new RegExp(`${escaped}\\s+(-?\\d+(?:\\.\\d+)?)%`, 'i'));
    return match ? toNumber(match[1]) : undefined;
};

const entryDate = (value: unknown) => {
    const date = new Date(String(value || ''));
    return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : '-';
};

const pnlRub = (row: RoundTrip) =>
    toNumber(row.netPnlRub ?? row.grossPnlRub ?? row.pnlRub);

const pnlPercent = (row: RoundTrip) =>
    toNumber(row.netPnlPercent ?? row.pnlPercent);

const evaluate = (row: RoundTrip, config = getRobotConfig(), multiplier = config.buyAntiFomoMaxRangeMultiplier): FomoDecision => {
    const momentumPercent = parsePercentAfter(row.entryDecisionReason, 'momentum');
    const belowHighPercent = parsePercentAfter(row.entryDecisionReason, 'below high');
    const volatilityProxyPercent = parsePercentAfter(row.entryDecisionReason, 'volatility');
    const rangeExtensionLimitPercent = volatilityProxyPercent !== undefined
        ? volatilityProxyPercent * multiplier
        : undefined;
    const tooCloseToHigh = belowHighPercent !== undefined
        && belowHighPercent <= config.buyAntiFomoMinBelowHighPercent;
    const oldBlocked = Boolean(
        tooCloseToHigh
        && momentumPercent !== undefined
        && momentumPercent > config.buyAntiFomoMaxMomentumPercent
    );
    const rangeBlocked = Boolean(
        tooCloseToHigh
        && momentumPercent !== undefined
        && rangeExtensionLimitPercent !== undefined
        && momentumPercent > rangeExtensionLimitPercent
    );
    const newBlocked = oldBlocked || rangeBlocked;
    const reason = [
        oldBlocked ? 'old momentum/high' : undefined,
        rangeBlocked ? 'range extension' : undefined
    ].filter(Boolean).join(', ') || 'pass';

    return {
        row,
        ticker: tickerLabel(row),
        momentumPercent,
        belowHighPercent,
        volatilityProxyPercent,
        rangeExtensionLimitPercent,
        oldBlocked,
        rangeBlocked,
        newBlocked,
        reason
    };
};

const sumPnl = (rows: FomoDecision[]) =>
    rows.reduce((sum, item) => sum + (pnlRub(item.row) ?? 0), 0);

const scenarioMetrics = (roundTrips: RoundTrip[], multiplier: number, config = getRobotConfig()): ScenarioMetrics => {
    const decisions = roundTrips.map(row => evaluate(row, config, multiplier));
    const blocked = decisions.filter(item => item.newBlocked);
    const kept = decisions.filter(item => !item.newBlocked);
    const blockedLosers = blocked.filter(item => (pnlRub(item.row) ?? 0) < 0);
    const blockedWinners = blocked.filter(item => (pnlRub(item.row) ?? 0) > 0);
    const savedLossRub = blockedLosers.reduce((sum, item) => sum + Math.abs(pnlRub(item.row) ?? 0), 0);
    const missedProfitRub = blockedWinners.reduce((sum, item) => sum + (pnlRub(item.row) ?? 0), 0);

    return {
        multiplier,
        cut: blocked.length,
        kept: kept.length,
        keptPnlRub: sumPnl(kept),
        blockedLosers: blockedLosers.length,
        savedLossRub,
        blockedWinners: blockedWinners.length,
        missedProfitRub,
        netEffectRub: savedLossRub - missedProfitRub
    };
};

const printScenarioTable = (rows: ScenarioMetrics[]) => {
    console.log('Range Multiplier Scenarios');
    console.log('--------------------------');
    console.log('mult  cut  kept  keptPnl   losers  savedLoss  winners  missedWin  netEffect');
    for (const row of rows) {
        console.log([
            format(row.multiplier, 1).padStart(4),
            String(row.cut).padStart(3),
            String(row.kept).padStart(5),
            format(row.keptPnlRub).padStart(8),
            String(row.blockedLosers).padStart(6),
            format(row.savedLossRub).padStart(9),
            String(row.blockedWinners).padStart(7),
            format(row.missedProfitRub).padStart(9),
            format(row.netEffectRub).padStart(9)
        ].join('  '));
    }
    console.log('');
};

const printRows = (title: string, rows: FomoDecision[], limit: number) => {
    console.log(title);
    console.log('-'.repeat(title.length));
    console.log('date        ticker  exit              pnlRub    pnl%   mom%  high%  vol%  lim%  reason');
    for (const item of rows.slice(0, limit)) {
        console.log([
            entryDate(item.row.entryAt).padEnd(10),
            item.ticker.padEnd(6),
            sourceLabel(item.row.exitSignalSource).padEnd(16),
            format(pnlRub(item.row)).padStart(8),
            format(pnlPercent(item.row)).padStart(6),
            format(item.momentumPercent).padStart(6),
            format(item.belowHighPercent).padStart(6),
            format(item.volatilityProxyPercent).padStart(6),
            format(item.rangeExtensionLimitPercent).padStart(6),
            item.reason
        ].join('  '));
    }
    console.log('');
};

const main = async () => {
    const limitArg = Number(process.argv[2]);
    const limit = Number.isFinite(limitArg) && limitArg > 0 ? Math.min(Math.trunc(limitArg), 2_000) : 500;
    const config = getRobotConfig();

    await DatabaseService.init();
    const report = await TradePnlService.getRoundTripPnl(config, limit, { includeCommissions: false });
    const roundTrips = (report.closedRoundTrips as RoundTrip[])
        .filter(row => sourceLabel(row.entrySignalSource) === 'score-buy')
        .filter(row => parsePercentAfter(row.entryDecisionReason, 'momentum') !== undefined)
        .filter(row => parsePercentAfter(row.entryDecisionReason, 'below high') !== undefined)
        .filter(row => parsePercentAfter(row.entryDecisionReason, 'volatility') !== undefined);
    const decisions = roundTrips.map(row => evaluate(row, config));
    const scenarios = SCENARIO_MULTIPLIERS
        .includes(config.buyAntiFomoMaxRangeMultiplier)
        ? SCENARIO_MULTIPLIERS
        : [...SCENARIO_MULTIPLIERS, config.buyAntiFomoMaxRangeMultiplier].sort((a, b) => a - b);
    const scenarioRows = scenarios.map(multiplier => scenarioMetrics(roundTrips, multiplier, config));
    const blocked = decisions.filter(item => item.newBlocked);
    const newlyBlocked = decisions.filter(item => item.newBlocked && !item.oldBlocked);
    const kept = decisions.filter(item => !item.newBlocked);
    const blockedLosers = blocked.filter(item => (pnlRub(item.row) ?? 0) < 0);
    const blockedWinners = blocked.filter(item => (pnlRub(item.row) ?? 0) > 0);
    const savedLossRub = blockedLosers.reduce((sum, item) => sum + Math.abs(pnlRub(item.row) ?? 0), 0);
    const missedProfitRub = blockedWinners.reduce((sum, item) => sum + (pnlRub(item.row) ?? 0), 0);

    console.log('Anti-FOMO What-if');
    console.log('=================');
    console.log(`Generated: ${report.generatedAt}`);
    console.log(`Scanned trades: ${report.summary.scannedTrades}`);
    console.log(`Closed score-buy round-trips with stored entry factors: ${decisions.length}`);
    console.log(`Config: momentum > ${format(config.buyAntiFomoMaxMomentumPercent)}%, below high <= ${format(config.buyAntiFomoMinBelowHighPercent)}%, range days ${config.buyAntiFomoRangeDays}, range multiplier ${format(config.buyAntiFomoMaxRangeMultiplier)}`);
    console.log('This fast what-if uses stored entry volatility as a proxy for normal range; it does not call T-Invest candle APIs.');
    console.log('');
    console.log(`Baseline gross P/L: ${formatRub(sumPnl(decisions))}`);
    console.log(`If anti-FOMO blocked: cut ${blocked.length}, kept ${kept.length}, kept gross P/L ${formatRub(sumPnl(kept))}`);
    console.log(`New range-only cuts: ${newlyBlocked.length}`);
    console.log(`Blocked losers: ${blockedLosers.length}, saved gross loss ${formatRub(savedLossRub)}`);
    console.log(`Blocked winners: ${blockedWinners.length}, missed gross profit ${formatRub(missedProfitRub)}`);
    console.log(`Net effect estimate: ${formatRub(savedLossRub - missedProfitRub)}`);
    console.log('');

    printScenarioTable(scenarioRows);
    printRows('Newly blocked by range extension', newlyBlocked.sort((a, b) => (pnlRub(a.row) ?? 0) - (pnlRub(b.row) ?? 0)), 20);
    printRows('Worst blocked entries', blocked.sort((a, b) => (pnlRub(a.row) ?? 0) - (pnlRub(b.row) ?? 0)), 20);

    console.log('Notes');
    console.log('-----');
    console.log('- This report is read-only and does not change trading thresholds.');
    console.log('- Range estimates use stored entry volatility as a proxy because daily range was not stored at entry time before this guard existed.');
    console.log('- A positive net effect means the blocked losers outweighed missed winners in the scanned sample.');
};

void main()
    .catch(error => {
        console.error('Anti-FOMO what-if failed:', error);
        process.exitCode = 1;
    })
    .finally(async () => {
        await sequelize.close().catch(() => undefined);
    });
