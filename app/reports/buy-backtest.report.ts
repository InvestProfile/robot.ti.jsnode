import sequelize from '../config/database';
import { getRobotConfig } from '../config/robot.config';
import BuyBacktestService from '../services/buy-backtest.service';
import ScanTargetsService from '../services/scan-targets.service';

const format = (value: number | undefined, digits = 2) => {
    if (value === undefined || !Number.isFinite(value)) return '-';
    return value.toFixed(digits);
};

const parseDays = (args: string[]) => {
    const index = args.findIndex(arg => arg === '--days');
    if (index === -1) return 180;

    const value = Number(args[index + 1]);
    return Number.isFinite(value) && value > 0 ? Math.trunc(value) : 180;
};

const parseTickers = (args: string[]) => args
    .filter((arg, index) => arg !== '--days' && args[index - 1] !== '--days')
    .map(ticker => ticker.toUpperCase());

const main = async () => {
    const args = process.argv.slice(2);
    const config = getRobotConfig();
    const days = parseDays(args);
    const tickers = parseTickers(args);
    const targets = await ScanTargetsService.resolve(config, tickers);
    const result = await BuyBacktestService.run(config, targets.tickers, days);

    console.log('Buy Backtest');
    console.log('============');
    console.log(`Targets: ${targets.mode}, ${targets.tickers.length} tickers`);
    console.log(`Min score: ${result.minScore}`);
    console.log(`Trend days: ${result.trendDays}`);
    console.log(`History days: ${result.days}`);
    console.log(`Missing: ${result.missing.join(', ') || '-'}`);
    console.log('');
    console.log('Ticker  Profile  Signals  Latest  1d WR/Avg      3d WR/Avg      5d WR/Avg      10d WR/Avg     Latest reason');
    console.log('------  -------  -------  ------  ------------   ------------   ------------   ------------   -------------');

    for (const item of result.results.sort((a, b) => (b.latestScore ?? -1) - (a.latestScore ?? -1))) {
        const row = result.horizons.map(horizon => {
            const stats = item.horizons[String(horizon)];
            return `${format(stats.winRatePercent, 0)}%/${format(stats.averageReturnPercent)}%`.padStart(12);
        });

        console.log([
            item.ticker.padEnd(6),
            `${item.profile?.trendDays ?? result.trendDays}/${item.profile?.minScore ?? result.minScore}`.padStart(7),
            String(item.signals).padStart(7),
            String(item.latestScore ?? '-').padStart(6),
            ...row,
            item.latestReason ?? '-'
        ].join('  '));
    }
};

void main()
    .catch(error => {
        console.error('Buy backtest failed:', error);
        process.exitCode = 1;
    })
    .finally(async () => {
        await sequelize.close().catch(() => undefined);
    });
