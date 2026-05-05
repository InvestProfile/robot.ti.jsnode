import sequelize from '../config/database';
import { getRobotConfig } from '../config/robot.config';
import DatabaseService from '../services/database.service';
import PaperTradingService from '../services/paper-trading.service';

const format = (value: number | undefined | null, digits = 2) => {
    if (value === undefined || value === null || !Number.isFinite(value)) return '-';
    return value.toFixed(digits);
};

const main = async () => {
    const args = process.argv.slice(2);
    const config = getRobotConfig();

    await DatabaseService.init();

    if (args.includes('--tick')) {
        const result = await PaperTradingService.tick(config);
        console.log(`Paper tick complete. opened=${result.opened} updated=${result.updated} closed=${result.closed}`);
    }

    const report = await PaperTradingService.list(100);

    console.log('Paper Portfolio');
    console.log('===============');
    console.log(`Open: ${report.summary.open}`);
    console.log(`Closed: ${report.summary.closed}`);
    console.log(`Open P/L RUB: ${format(report.summary.openProfitRub)}`);
    console.log(`Closed P/L RUB: ${format(report.summary.closedProfitRub)}`);
    console.log(`Total P/L RUB: ${format(report.summary.totalProfitRub)}`);
    console.log('');
    console.log('Status  Ticker  Score  Entry      Current    P/L %    P/L RUB   Reason');
    console.log('------  ------  -----  ---------  ---------  -------  --------  ------------------------------');

    for (const position of report.positions) {
        console.log([
            String(position.status ?? '-').padEnd(6),
            String(position.ticker ?? '-').padEnd(6),
            String(position.entryScore ?? '-').padStart(5),
            format(position.entryPrice).padStart(9),
            format(position.currentPrice ?? position.exitPrice).padStart(9),
            format(position.profitPercent).padStart(7),
            format(position.profitRub).padStart(8),
            position.exitReason ?? position.entryReason ?? '-'
        ].join('  '));
    }
};

void main()
    .catch(error => {
        console.error('Paper portfolio report failed:', error);
        process.exitCode = 1;
    })
    .finally(async () => {
        await sequelize.close().catch(() => undefined);
    });
