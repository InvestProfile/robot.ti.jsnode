import sequelize from '../config/database';
import { getRobotConfig } from '../config/robot.config';
import DatabaseService from '../services/database.service';
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
    pnlPercent?: unknown;
    netPnlPercent?: unknown;
    entryDecisionReason?: unknown;
    exitSignalSource?: unknown;
    exitDecisionReason?: unknown;
}

interface ExitGroup {
    key: string;
    count: number;
    wins: number;
    losses: number;
    grossPnlRub: number;
    commissionRub: number;
    netPnlRub: number;
    netPercents: number[];
    stopPercents: number[];
    avgRanges: number[];
    trailingDrawdowns: number[];
    trailingProfits: number[];
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

const parsePercentAfter = (reason: unknown, label: string) => {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = String(reason || '').match(new RegExp(`${escaped}\\s+(-?\\d+(?:\\.\\d+)?)%`, 'i'));
    return match ? toNumber(match[1]) : undefined;
};

const average = (values: number[]) =>
    values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : undefined;

const percentile = (values: number[], p: number) => {
    if (values.length === 0) return undefined;
    const sorted = values.slice().sort((a, b) => a - b);
    const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1));
    return sorted[index];
};

const createGroup = (key: string): ExitGroup => ({
    key,
    count: 0,
    wins: 0,
    losses: 0,
    grossPnlRub: 0,
    commissionRub: 0,
    netPnlRub: 0,
    netPercents: [],
    stopPercents: [],
    avgRanges: [],
    trailingDrawdowns: [],
    trailingProfits: []
});

const addToGroup = (group: ExitGroup, row: RoundTrip) => {
    const netPnlRub = toNumber(row.netPnlRub ?? row.grossPnlRub) ?? 0;
    const grossPnlRub = toNumber(row.grossPnlRub) ?? 0;
    const commissionRub = toNumber(row.commissionRub) ?? 0;
    const netPnlPercent = toNumber(row.netPnlPercent ?? row.pnlPercent);
    const reason = row.exitDecisionReason;

    group.count += 1;
    group.grossPnlRub += grossPnlRub;
    group.commissionRub += commissionRub;
    group.netPnlRub += netPnlRub;
    if (netPnlRub > 0) group.wins += 1;
    if (netPnlRub < 0) group.losses += 1;
    if (netPnlPercent !== undefined) group.netPercents.push(netPnlPercent);

    const adaptiveStop = parsePercentAfter(reason, 'adaptive stop');
    const avgRange = parsePercentAfter(reason, 'avg range');
    const drawdown = parsePercentAfter(reason, 'current price is');
    const profit = parsePercentAfter(reason, 'profit');

    if (adaptiveStop !== undefined) group.stopPercents.push(adaptiveStop);
    if (avgRange !== undefined) group.avgRanges.push(avgRange);
    if (drawdown !== undefined) group.trailingDrawdowns.push(drawdown);
    if (profit !== undefined) group.trailingProfits.push(profit);
};

const groupBy = (rows: RoundTrip[], key: (row: RoundTrip) => string) => {
    const groups = new Map<string, ExitGroup>();
    for (const row of rows) {
        const groupKey = key(row);
        const group = groups.get(groupKey) ?? createGroup(groupKey);
        addToGroup(group, row);
        groups.set(groupKey, group);
    }

    return [...groups.values()].sort((a, b) => a.netPnlRub - b.netPnlRub);
};

const diagnosis = (group: ExitGroup) => {
    const avgNetPercent = average(group.netPercents);
    const avgStop = average(group.stopPercents);
    const avgRange = average(group.avgRanges);
    const avgTrailingProfit = average(group.trailingProfits);

    if (group.key === 'stop-loss' || group.key.endsWith(':stop-loss')) {
        if (group.count >= 3 && group.netPnlRub < 0 && avgStop !== undefined && avgRange !== undefined && avgRange > avgStop * 0.75) {
            return 'watch: stop is close to normal daily range';
        }
        if (group.count >= 3 && group.netPnlRub < 0) return 'watch entries before widening stop';
        return 'sample';
    }

    if (group.key === 'trailing-stop' || group.key.endsWith(':trailing-stop')) {
        if (avgTrailingProfit !== undefined && avgTrailingProfit < 1) return 'too early: profit before trail is small';
        if (avgNetPercent !== undefined && avgNetPercent < 0) return 'bad trail: closes below net breakeven';
        return 'sample';
    }

    if (group.key === 'profit-take' || group.key.endsWith(':profit-take')) {
        return group.netPnlRub > 0 ? 'working' : 'watch';
    }

    return 'sample';
};

const printGroup = (group: ExitGroup) => {
    const winRate = group.count > 0 ? group.wins / group.count * 100 : undefined;
    console.log([
        group.key.padEnd(22),
        String(group.count).padStart(4),
        `${format(winRate, 0)}%`.padStart(5),
        formatRub(group.netPnlRub).padStart(12),
        formatRub(group.grossPnlRub).padStart(12),
        format(group.commissionRub).padStart(7),
        `${format(average(group.netPercents))}%`.padStart(8),
        `${format(percentile(group.netPercents, 0.25))}%`.padStart(8),
        `${format(average(group.stopPercents))}%`.padStart(8),
        `${format(average(group.avgRanges))}%`.padStart(8),
        diagnosis(group)
    ].join('  '));
};

const printSection = (title: string, groups: ExitGroup[]) => {
    console.log(title);
    console.log('-'.repeat(title.length));
    console.log('Key                     N    WR          Net        Gross     Fees   Avg%     P25%   Stop%   Range%  Diagnosis');
    console.log('----------------------  ----  -----  ----------  ----------  -------  --------  --------  -------  -------  -------------------------------');
    for (const group of groups) printGroup(group);
    console.log('');
};

const printWorstTrades = (rows: RoundTrip[]) => {
    console.log('Worst Recent Exits');
    console.log('------------------');
    console.log('Exit time             Ticker  Source         Net RUB   Net%     Fees    Reason');
    console.log('-------------------  ------  -------------  --------  -------  ------  ----------------------------------------');
    for (const row of rows
        .slice()
        .sort((a, b) => (toNumber(a.netPnlRub ?? a.grossPnlRub) ?? 0) - (toNumber(b.netPnlRub ?? b.grossPnlRub) ?? 0))
        .slice(0, 12)) {
        console.log([
            String(row.exitAt || '-').slice(0, 19).replace('T', ' ').padEnd(19),
            tickerLabel(row).padEnd(6),
            sourceLabel(row.exitSignalSource).padEnd(13),
            format(toNumber(row.netPnlRub ?? row.grossPnlRub)).padStart(8),
            `${format(toNumber(row.netPnlPercent ?? row.pnlPercent))}%`.padStart(7),
            format(toNumber(row.commissionRub)).padStart(6),
            String(row.exitDecisionReason || '-').slice(0, 80)
        ].join('  '));
    }
    console.log('');
};

const main = async () => {
    const limitArg = Number(process.argv[2]);
    const limit = Number.isFinite(limitArg) && limitArg > 0 ? Math.min(Math.trunc(limitArg), 2_000) : 500;
    const includeCommissions = process.argv.includes('--net');
    const config = getRobotConfig();

    await DatabaseService.init();
    const report = await TradePnlService.getRoundTripPnl(config, limit, { includeCommissions });
    const roundTrips = report.closedRoundTrips as RoundTrip[];

    console.log('Exit / Stops Lab');
    console.log('================');
    console.log(`Generated: ${report.generatedAt}`);
    console.log(`Scanned trades: ${report.summary.scannedTrades}`);
    console.log(`Closed round-trips: ${roundTrips.length}`);
    console.log(`Accounting: ${includeCommissions ? report.summary.accounting : 'gross-fast'}${includeCommissions ? '' : ' (use --net to fetch/match commissions)'}`);
    console.log(`Gross P/L: ${formatRub(report.summary.realizedGrossPnlRub)}`);
    console.log(`Fees: ${formatRub(report.summary.commissionRub)}`);
    console.log(`Net P/L: ${formatRub(report.summary.realizedNetPnlRub)}`);
    console.log(`Win-rate: ${format(report.summary.winRate, 0)}%`);
    console.log('');

    printSection('By Exit Source', groupBy(roundTrips, row => sourceLabel(row.exitSignalSource)));
    printSection('Worst Ticker + Exit Source', groupBy(roundTrips, row => `${tickerLabel(row)}:${sourceLabel(row.exitSignalSource)}`).slice(0, 18));
    printWorstTrades(roundTrips);

    console.log('Notes');
    console.log('-----');
    console.log('- This report is read-only and does not change trading thresholds.');
    console.log('- Default mode is fast and avoids broker commission API calls; pass --net for exact net P/L.');
    console.log('- Stop% and Range% are parsed from sell decision reasons when available.');
    console.log('- If stop-loss losses cluster where daily range is close to stop, that ticker may need a wider volatility stop or a stricter entry filter.');
    console.log('- If trailing-stop exits with tiny Avg%, trailing min profit is probably too low for that ticker.');
};

void main()
    .catch(error => {
        console.error('Exit/stops lab failed:', error);
        process.exitCode = 1;
    })
    .finally(async () => {
        await sequelize.close().catch(() => undefined);
    });
