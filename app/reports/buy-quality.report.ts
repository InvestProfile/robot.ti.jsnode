import sequelize from '../config/database';
import { getRobotConfig } from '../config/robot.config';
import DatabaseService from '../services/database.service';
import TradePnlService from '../services/trade-pnl.service';
import {
    analyzeBuyQualityRow,
    BuyQualityDecision,
    BuyQualityRow,
    pnlRub
} from '../utils/buy-quality-analysis';

interface RoundTrip extends BuyQualityRow {
    ticker?: unknown;
    name?: unknown;
    entryAt?: unknown;
    exitAt?: unknown;
    entrySignalSource?: unknown;
    exitSignalSource?: unknown;
    pnlPercent?: unknown;
    netPnlPercent?: unknown;
}

interface AnalyzedRoundTrip {
    row: RoundTrip;
    decision: BuyQualityDecision;
}

const toNumber = (value: unknown) => {
    const number = Number(value);
    return Number.isFinite(number) ? number : undefined;
};

const format = (value: number | undefined, digits = 2) =>
    value === undefined || !Number.isFinite(value) ? '-' : value.toFixed(digits);

const formatRub = (value: number | undefined) => `${format(value)} RUB`;

const sourceLabel = (value: unknown) => String(value || 'unknown');

const tickerLabel = (row: RoundTrip) => String(row.ticker || 'UNKNOWN').toUpperCase();

const entryTime = (value: unknown) => {
    const date = new Date(String(value || ''));
    return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 16) : '-';
};

const sumPnl = (rows: AnalyzedRoundTrip[]) =>
    rows.reduce((sum, item) => sum + (pnlRub(item.row) ?? 0), 0);

const printRows = (title: string, rows: AnalyzedRoundTrip[], limit: number) => {
    console.log(title);
    console.log('-'.repeat(title.length));
    console.log('entry             ticker  exit              pnlRub    pnl%   score  adj  tech   mom%  high%  vol%  filter');

    for (const item of rows.slice(0, limit)) {
        const factors = item.decision.factors;
        console.log([
            entryTime(item.row.entryAt).padEnd(16),
            tickerLabel(item.row).padEnd(6),
            sourceLabel(item.row.exitSignalSource).padEnd(16),
            format(pnlRub(item.row)).padStart(8),
            format(toNumber(item.row.netPnlPercent ?? item.row.pnlPercent)).padStart(6),
            format(factors.score, 0).padStart(5),
            format(factors.totalAdjustment, 0).padStart(4),
            format(factors.technicalScoreAdjustment, 0).padStart(5),
            format(factors.momentumPercent).padStart(6),
            format(factors.belowHighPercent).padStart(6),
            format(factors.volatilityPercent).padStart(6),
            item.decision.candidateFilters.join(', ') || 'pass'
        ].join('  '));
    }

    console.log('');
};

const main = async () => {
    const limitArg = Number(process.argv.find(arg => /^\d+$/.test(arg)));
    const limit = Number.isFinite(limitArg) && limitArg > 0 ? Math.min(Math.trunc(limitArg), 2_000) : 500;
    const config = getRobotConfig();

    await DatabaseService.init();
    const report = await TradePnlService.getRoundTripPnl(config, limit, { includeCommissions: false });
    const roundTrips = (report.closedRoundTrips as RoundTrip[])
        .filter(row => sourceLabel(row.entrySignalSource) === 'score-buy')
        .map(row => ({
            row,
            decision: analyzeBuyQualityRow(row, config)
        }))
        .filter(item => item.decision.factors.momentumPercent !== undefined)
        .filter(item => item.decision.factors.belowHighPercent !== undefined);
    const nearPeak = roundTrips.filter(item => item.decision.nearPeak);
    const nearPeakStop = nearPeak.filter(item => item.decision.stopExit);
    const nearPeakLosers = nearPeak.filter(item => item.decision.losing);
    const currentAntiFomo = nearPeak.filter(item => item.decision.currentAntiFomoBlocked);
    const tightRange = nearPeak.filter(item => item.decision.tightRangeBlocked);
    const pullbackConfirmation = nearPeak.filter(item => item.decision.pullbackConfirmationBlocked);

    console.log('Buy Quality / Anti-Peak Entries');
    console.log('================================');
    console.log(`Generated: ${report.generatedAt}`);
    console.log(`Scanned trades: ${report.summary.scannedTrades}`);
    console.log(`Closed score-buy round-trips with stored entry factors: ${roundTrips.length}`);
    console.log(`Near-peak threshold: below high <= ${format(config.buyAntiFomoMinBelowHighPercent)}%`);
    console.log(`Current anti-FOMO: momentum > ${format(config.buyAntiFomoMaxMomentumPercent)}% or > volatility x${format(config.buyAntiFomoMaxRangeMultiplier)}`);
    console.log('This report is read-only and uses factors stored in the original entry decision reason.');
    console.log('');
    console.log(`Near-peak entries: ${nearPeak.length}, P/L ${formatRub(sumPnl(nearPeak))}`);
    console.log(`Near-peak losers: ${nearPeakLosers.length}, P/L ${formatRub(sumPnl(nearPeakLosers))}`);
    console.log(`Near-peak stop exits: ${nearPeakStop.length}, P/L ${formatRub(sumPnl(nearPeakStop))}`);
    console.log(`Would be blocked by current anti-FOMO: ${currentAntiFomo.length}, P/L ${formatRub(sumPnl(currentAntiFomo))}`);
    console.log(`Would be blocked by tighter range x1.0: ${tightRange.length}, P/L ${formatRub(sumPnl(tightRange))}`);
    console.log(`Would be blocked by pullback/confirmation after any positive near-high momentum: ${pullbackConfirmation.length}, P/L ${formatRub(sumPnl(pullbackConfirmation))}`);
    console.log('');

    printRows(
        'Recent near-peak entries',
        nearPeak.sort((a, b) => new Date(String(b.row.entryAt || '')).getTime() - new Date(String(a.row.entryAt || '')).getTime()),
        30
    );
    printRows(
        'Near-peak stop-loss exits',
        nearPeakStop.sort((a, b) => (pnlRub(a.row) ?? 0) - (pnlRub(b.row) ?? 0)),
        30
    );
    printRows(
        'Near-peak losers missed by current anti-FOMO',
        nearPeakLosers
            .filter(item => !item.decision.currentAntiFomoBlocked)
            .sort((a, b) => (pnlRub(a.row) ?? 0) - (pnlRub(b.row) ?? 0)),
        30
    );

    console.log('Notes');
    console.log('-----');
    console.log('- score/social/analyst/technical adjustments are parsed from the saved score-buy reason when present.');
    console.log('- range x1.0 is a diagnostic candidate, not a live strategy change.');
    console.log('- pullback/confirmation is intentionally broad here so it can show the upper bound of what a stricter anti-peak rule would cut.');
};

void main()
    .catch(error => {
        console.error('Buy quality report failed:', error);
        process.exitCode = 1;
    })
    .finally(async () => {
        await sequelize.close().catch(() => undefined);
    });
