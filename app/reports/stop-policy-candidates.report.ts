import sequelize from '../config/database';
import { getRobotConfig } from '../config/robot.config';
import DatabaseService from '../services/database.service';
import InstrumentsService from '../services/instruments.service';
import TradePnlService from '../services/trade-pnl.service';

interface RoundTrip {
    ticker?: unknown;
    name?: unknown;
    entryAt?: unknown;
    exitAt?: unknown;
    grossPnlRub?: unknown;
    commissionRub?: unknown;
    netPnlRub?: unknown;
    pnlRub?: unknown;
    pnlPercent?: unknown;
    netPnlPercent?: unknown;
    exitSignalSource?: unknown;
    exitDecisionReason?: unknown;
    figi?: unknown;
    instrumentId?: unknown;
}

interface CandidateGroup {
    key: string;
    label: string;
    count: number;
    stopCount: number;
    wins: number;
    losses: number;
    netPnlRub: number;
    grossPnlRub: number;
    commissionRub: number;
    netPercents: number[];
    stopPercents: number[];
    avgRanges: number[];
    heldMinutes: number[];
    tickers: Set<string>;
    stopSources: Map<string, number>;
}

const STOP_SOURCES = new Set(['stop-loss', 'broker-stop-loss']);

const toNumber = (value: unknown) => {
    const number = Number(value);
    return Number.isFinite(number) ? number : undefined;
};

const format = (value: number | undefined, digits = 2) =>
    value === undefined || !Number.isFinite(value) ? '-' : value.toFixed(digits);

const formatRub = (value: number | undefined) => `${format(value)} RUB`;

const average = (values: number[]) =>
    values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : undefined;

const percentile = (values: number[], p: number) => {
    if (values.length === 0) return undefined;
    const sorted = values.slice().sort((a, b) => a - b);
    const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1));
    return sorted[index];
};

const tickerLabel = (row: RoundTrip) => String(row.ticker || 'UNKNOWN').toUpperCase();

const sourceLabel = (row: RoundTrip) => String(row.exitSignalSource || 'unknown');

const netPnlRub = (row: RoundTrip) => toNumber(row.netPnlRub ?? row.pnlRub ?? row.grossPnlRub) ?? 0;

const grossPnlRub = (row: RoundTrip) => toNumber(row.grossPnlRub ?? row.pnlRub) ?? 0;

const commissionRub = (row: RoundTrip) => toNumber(row.commissionRub) ?? 0;

const netPnlPercent = (row: RoundTrip) => toNumber(row.netPnlPercent ?? row.pnlPercent);

const parsePercentAfter = (reason: unknown, label: string) => {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = String(reason || '').match(new RegExp(`${escaped}\\s+(-?\\d+(?:\\.\\d+)?)%`, 'i'));
    return match ? toNumber(match[1]) : undefined;
};

const heldMinutes = (row: RoundTrip) => {
    const entry = new Date(String(row.entryAt || '')).getTime();
    const exit = new Date(String(row.exitAt || '')).getTime();
    if (!Number.isFinite(entry) || !Number.isFinite(exit) || exit < entry) return undefined;
    return (exit - entry) / 60_000;
};

const createGroup = (key: string, label = key): CandidateGroup => ({
    key,
    label,
    count: 0,
    stopCount: 0,
    wins: 0,
    losses: 0,
    netPnlRub: 0,
    grossPnlRub: 0,
    commissionRub: 0,
    netPercents: [],
    stopPercents: [],
    avgRanges: [],
    heldMinutes: [],
    tickers: new Set(),
    stopSources: new Map()
});

const addToGroup = (group: CandidateGroup, row: RoundTrip) => {
    const net = netPnlRub(row);
    const gross = grossPnlRub(row);
    const commission = commissionRub(row);
    const percent = netPnlPercent(row);
    const stopPercent = parsePercentAfter(row.exitDecisionReason, 'adaptive stop');
    const avgRange = parsePercentAfter(row.exitDecisionReason, 'avg range');
    const minutes = heldMinutes(row);
    const source = sourceLabel(row);

    group.count += 1;
    group.netPnlRub += net;
    group.grossPnlRub += gross;
    group.commissionRub += commission;
    if (STOP_SOURCES.has(source)) group.stopCount += 1;
    if (net > 0) group.wins += 1;
    if (net < 0) group.losses += 1;
    if (percent !== undefined) group.netPercents.push(percent);
    if (stopPercent !== undefined) group.stopPercents.push(stopPercent);
    if (avgRange !== undefined) group.avgRanges.push(avgRange);
    if (minutes !== undefined) group.heldMinutes.push(minutes);
    group.tickers.add(tickerLabel(row));
    group.stopSources.set(source, (group.stopSources.get(source) ?? 0) + 1);
};

const getSectorLookup = async () => {
    const shares = await InstrumentsService.getShares();
    const lookup = new Map<string, string>();

    for (const instrument of shares?.instruments ?? []) {
        const sector = String(instrument.sector || 'unknown-sector');
        if (instrument.uid) lookup.set(String(instrument.uid), sector);
        if (instrument.figi) lookup.set(String(instrument.figi), sector);
        if (instrument.ticker) lookup.set(String(instrument.ticker).toUpperCase(), sector);
    }

    return lookup;
};

const sectorLabel = (row: RoundTrip, sectors: Map<string, string>) =>
    sectors.get(String(row.instrumentId || ''))
    ?? sectors.get(String(row.figi || ''))
    ?? sectors.get(tickerLabel(row))
    ?? 'unknown-sector';

const groupBy = (rows: RoundTrip[], keyFn: (row: RoundTrip) => string, labelFn: (row: RoundTrip) => string = keyFn) => {
    const groups = new Map<string, CandidateGroup>();

    for (const row of rows) {
        const key = keyFn(row);
        const group = groups.get(key) ?? createGroup(key, labelFn(row));
        addToGroup(group, row);
        groups.set(key, group);
    }

    return [...groups.values()];
};

const stopRangeRatio = (group: CandidateGroup) => {
    const avgStop = average(group.stopPercents);
    const avgRange = average(group.avgRanges);
    if (avgStop === undefined || avgStop <= 0 || avgRange === undefined) return undefined;
    return avgRange / avgStop;
};

const riskScore = (group: CandidateGroup) => {
    const stopShare = group.count > 0 ? group.stopCount / group.count : 0;
    const lossShare = group.count > 0 ? group.losses / group.count : 0;
    const lossRub = Math.max(0, -group.netPnlRub);
    const rangeRatio = stopRangeRatio(group) ?? 0;
    return lossRub + group.stopCount * 20 + stopShare * 75 + lossShare * 50 + rangeRatio * 50;
};

const diagnosis = (group: CandidateGroup) => {
    const ratio = stopRangeRatio(group);
    const stopShare = group.count > 0 ? group.stopCount / group.count : 0;
    const avgNetPercent = average(group.netPercents);

    if (group.stopCount >= 3 && group.netPnlRub < 0 && ratio !== undefined && ratio >= 0.75) {
        return 'candidate: volatility-aware wider stop or stricter entry';
    }
    if (group.stopCount >= 3 && stopShare >= 0.7 && group.netPnlRub < 0) {
        return 'candidate: stop-heavy loser cluster';
    }
    if (group.count >= 5 && group.netPnlRub < 0 && stopShare >= 0.5) {
        return 'watch: losses mostly exit through stops';
    }
    if (group.count >= 5 && avgNetPercent !== undefined && avgNetPercent < 0 && group.netPnlRub < 0) {
        return 'watch: negative average exit quality';
    }
    return 'sample';
};

const sourceSummary = (group: CandidateGroup) =>
    [...group.stopSources.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([source, count]) => `${source}:${count}`)
        .join(', ');

const printGroups = (title: string, groups: CandidateGroup[], limit: number) => {
    console.log(title);
    console.log('-'.repeat(title.length));
    console.log('Key                     N  Stops  WR      Net        Avg%   P25%   Stop%  Range%  R/Stop  HoldH  Score   Diagnosis');
    console.log('----------------------  -  -----  -----  ---------  -----  -----  -----  ------  ------  -----  ------  ---------------------------------------------');

    for (const group of groups
        .filter(group => group.count > 0)
        .sort((a, b) => riskScore(b) - riskScore(a))
        .slice(0, limit)) {
        const winRate = group.count > 0 ? group.wins / group.count * 100 : undefined;
        const ratio = stopRangeRatio(group);
        const avgHeldMinutes = average(group.heldMinutes);
        const holdHours = avgHeldMinutes === undefined ? undefined : avgHeldMinutes / 60;

        console.log([
            group.label.slice(0, 22).padEnd(22),
            String(group.count).padStart(2),
            String(group.stopCount).padStart(5),
            `${format(winRate, 0)}%`.padStart(5),
            formatRub(group.netPnlRub).padStart(10),
            `${format(average(group.netPercents))}%`.padStart(6),
            `${format(percentile(group.netPercents, 0.25))}%`.padStart(6),
            `${format(average(group.stopPercents))}%`.padStart(6),
            `${format(average(group.avgRanges))}%`.padStart(7),
            format(ratio).padStart(7),
            format(holdHours, 1).padStart(6),
            format(riskScore(group), 0).padStart(7),
            diagnosis(group)
        ].join('  '));
    }
    console.log('');
};

const printDetails = (groups: CandidateGroup[], limit: number) => {
    console.log('Candidate Details');
    console.log('-----------------');
    console.log('Key                     Tickers                 Sources                       Read');
    console.log('----------------------  ----------------------  ----------------------------  ---------------------------------------------');
    for (const group of groups
        .filter(group => diagnosis(group) !== 'sample')
        .sort((a, b) => riskScore(b) - riskScore(a))
        .slice(0, limit)) {
        console.log([
            group.label.slice(0, 22).padEnd(22),
            [...group.tickers].slice(0, 5).join(', ').slice(0, 22).padEnd(22),
            sourceSummary(group).slice(0, 28).padEnd(28),
            diagnosis(group)
        ].join('  '));
    }
    console.log('');
};

const parseLimit = () => {
    const positional = process.argv.find((arg, index) => index > 1 && /^\d+$/.test(arg));
    const value = Number(positional ?? 500);
    return Number.isFinite(value) && value > 0 ? value : 500;
};

const main = async () => {
    const limit = parseLimit();
    const includeBrokerCommissions = process.argv.includes('--net');
    const config = getRobotConfig();
    const sectors = await getSectorLookup();
    const report = await TradePnlService.getRoundTripPnl(config, limit, { includeCommissions: includeBrokerCommissions });
    const rows = ((report.closedRoundTrips ?? report.roundTrips ?? []) as RoundTrip[]);
    const stopRows = rows.filter(row => STOP_SOURCES.has(sourceLabel(row)));

    const tickerGroups = groupBy(stopRows, tickerLabel);
    const sectorGroups = groupBy(stopRows, row => sectorLabel(row, sectors));
    const sourceGroups = groupBy(rows, sourceLabel);
    const sectorTickerGroups = groupBy(stopRows, row => `${sectorLabel(row, sectors)}:${tickerLabel(row)}`);

    console.log('Stop Policy Candidates');
    console.log('======================');
    console.log(`Generated: ${new Date().toISOString()}`);
    console.log(`Closed round-trips: ${rows.length}`);
    console.log(`Stop exits: ${stopRows.length}`);
    console.log(`Accounting: ${includeBrokerCommissions ? 'net' : 'gross/recorded'}`);
    console.log(`Current stop config: base ${format(config.stopLossPercent)}%, volatility x${format(config.stopLossVolatilityMultiplier)}, max ${format(config.stopLossMaxPercent)}%`);
    console.log('');
    console.log('Interpretation');
    console.log('--------------');
    console.log('- High R/Stop means the parsed average daily range is close to the active stop distance.');
    console.log('- Candidate rows are not live policy changes; they identify where to test wider stops, confirmation, or stricter entry filters.');
    console.log('- Broker-stop-loss rows often lack stored stop/range details, so use ticker/sector clustering together with stop what-if.');
    console.log('');

    printGroups('By Ticker Stop Clusters', tickerGroups, 18);
    printGroups('By Sector Stop Clusters', sectorGroups, 12);
    printGroups('By Exit Source', sourceGroups, 10);
    printGroups('By Sector + Ticker', sectorTickerGroups, 20);
    printDetails([...tickerGroups, ...sectorGroups, ...sectorTickerGroups], 20);
};

DatabaseService.init()
    .then(main)
    .catch(error => {
        console.error(error);
        process.exitCode = 1;
    })
    .finally(async () => {
        await sequelize.close();
    });
