import sequelize from '../config/database';
import { getRobotConfig } from '../config/robot.config';
import MarketRegimeService from '../services/market-regime.service';

const format = (value: number | undefined, digits = 2) => {
    if (value === undefined || !Number.isFinite(value)) return '-';
    return value.toFixed(digits);
};

const main = async () => {
    const config = getRobotConfig();
    const result = await MarketRegimeService.evaluate(config);

    console.log('Market Regime');
    console.log('=============');
    console.log(`Enabled: ${result.enabled}`);
    console.log(`Passed: ${result.passed}`);
    console.log(`Reason: ${result.reason}`);
    console.log(`Health: ${format(result.healthPercent, 0)}%`);
    console.log(`Avg trend: ${format(result.avgTrendPercent)}%`);
    console.log('');
    console.log('Ticker  Trend    Passed  Reason');
    console.log('------  -------  ------  ------------------------------');

    for (const item of result.items) {
        console.log([
            item.ticker.padEnd(6),
            format(item.trendPercent).padStart(7),
            String(item.passed).padEnd(6),
            item.reason
        ].join('  '));
    }
};

void main()
    .catch(error => {
        console.error('Market regime report failed:', error);
        process.exitCode = 1;
    })
    .finally(async () => {
        await sequelize.close().catch(() => undefined);
    });
