import sequelize from '../config/database';
import { TradeDecisionModel } from '../models/trade-decision.model';

const DEFAULT_LIMIT = 30;

const formatDate = (value: unknown) => {
    if (!value) return '-';

    const date = value instanceof Date ? value : new Date(String(value));
    if (Number.isNaN(date.getTime())) return '-';

    return date.toISOString().replace('T', ' ').slice(0, 16);
};

const formatPercent = (value: unknown) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) return '-';
    const prefix = value > 0 ? '+' : '';
    return `${prefix}${value.toFixed(2)}%`;
};

const valueOrDash = (value: unknown) => {
    if (value === null || value === undefined || value === '') return '-';
    return String(value);
};

const pad = (value: string, width: number) => {
    if (value.length >= width) return value.slice(0, width - 1) + '…';
    return value.padEnd(width, ' ');
};

const getLimit = () => {
    const rawLimit = process.argv[2] ?? process.env.DECISIONS_LIMIT;
    const limit = Number(rawLimit);

    return Number.isFinite(limit) && limit > 0 ? Math.trunc(limit) : DEFAULT_LIMIT;
};

const printRows = (rows: TradeDecisionModel[]) => {
    const header = [
        pad('Time', 17),
        pad('Account', 20),
        pad('Mode', 8),
        pad('Ticker', 10),
        pad('Source', 12),
        pad('Status', 10),
        pad('P/L', 9),
        'Reason'
    ].join('  ');

    console.log(header);
    console.log('-'.repeat(header.length));

    for (const row of rows) {
        const data = row.get({ plain: true }) as Record<string, unknown>;
        const line = [
            pad(formatDate(data.createdAt), 17),
            pad(valueOrDash(data.accountAlias ?? data.accountId), 20),
            pad(valueOrDash(data.accountMode), 8),
            pad(valueOrDash(data.ticker ?? data.figi), 10),
            pad(valueOrDash(data.signalSource), 12),
            pad(valueOrDash(data.status), 10),
            pad(formatPercent(data.profitPercent), 9),
            valueOrDash(data.reason)
        ].join('  ');

        console.log(line);
    }
};

const main = async () => {
    const limit = getLimit();
    const rows = await TradeDecisionModel.findAll({
        order: [['createdAt', 'DESC']],
        limit
    });

    console.log(`Last ${rows.length} trade decisions`);
    printRows(rows);
};

void main()
    .catch(error => {
        console.error('Failed to build decisions report:', error);
        process.exitCode = 1;
    })
    .finally(async () => {
        await sequelize.close().catch(() => undefined);
    });
