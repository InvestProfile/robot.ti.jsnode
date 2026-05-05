import sequelize from '../config/database';
import { getRobotConfig } from '../config/robot.config';
import DatabaseService from '../services/database.service';
import SellBrainService from '../services/sell-brain.service';

const format = (value: number | undefined | null, digits = 2) => {
    if (value === undefined || value === null || !Number.isFinite(value)) return '-';
    return value.toFixed(digits);
};

const main = async () => {
    const config = getRobotConfig();
    await DatabaseService.init();

    const result = await SellBrainService.evaluate(config);

    console.log('Sell Brain');
    console.log('==========');
    console.log(`Generated: ${result.generatedAt}`);
    console.log(`Positions: ${result.summary.positions}`);
    console.log(`Sell: ${result.summary.sell}`);
    console.log(`Hold: ${result.summary.hold}`);
    console.log(`Blocked: ${result.summary.blocked}`);
    console.log('');
    console.log('Account           Ticker  Action  Source         P/L       Lots   Reason');
    console.log('----------------  ------  ------  -------------  --------  -----  ----------------------------------------');

    for (const item of result.items) {
        console.log([
            String(item.accountAlias || item.accountId).padEnd(16),
            String(item.ticker || item.figi || '-').padEnd(6),
            String(item.action).padEnd(6),
            String(item.source || '-').padEnd(13),
            `${format(item.profitPercent)}%`.padStart(8),
            String(item.orderLots ?? item.signalLots ?? item.quantityLots ?? '-').padStart(5),
            item.reason
        ].join('  '));
    }
};

void main()
    .catch(error => {
        console.error('Sell brain report failed:', error);
        process.exitCode = 1;
    })
    .finally(async () => {
        await sequelize.close().catch(() => undefined);
    });
