import sequelize from '../config/database';
import { getRobotConfig } from '../config/robot.config';
import BuyOptimizerService from '../services/buy-optimizer.service';

const format = (value: number | undefined, digits = 2) => {
    if (value === undefined || !Number.isFinite(value)) return '-';
    return value.toFixed(digits);
};

const getArgValue = (args: string[], name: string) => {
    const index = args.findIndex(arg => arg === name);
    return index === -1 ? undefined : args[index + 1];
};

const parseDays = (args: string[]) => {
    const value = Number(getArgValue(args, '--days'));
    return Number.isFinite(value) && value > 0 ? Math.trunc(value) : 180;
};

const parseLimit = (args: string[]) => {
    const value = Number(getArgValue(args, '--limit'));
    return Number.isFinite(value) && value > 0 ? Math.trunc(value) : 20;
};

const parseTickers = (args: string[]) => {
    const optionNames = new Set(['--days', '--windows', '--thresholds', '--horizons', '--limit']);
    const skipIndexes = new Set<number>();

    args.forEach((arg, index) => {
        if (optionNames.has(arg)) {
            skipIndexes.add(index);
            skipIndexes.add(index + 1);
        }
    });

    return args
        .filter((_, index) => !skipIndexes.has(index))
        .map(ticker => ticker.toUpperCase());
};

const main = async () => {
    const args = process.argv.slice(2);
    const config = getRobotConfig();
    const days = parseDays(args);
    const limit = parseLimit(args);
    const windows = BuyOptimizerService.parseWindows(getArgValue(args, '--windows'));
    const thresholds = BuyOptimizerService.parseThresholds(getArgValue(args, '--thresholds'));
    const horizons = BuyOptimizerService.parseHorizons(getArgValue(args, '--horizons'));
    const tickers = parseTickers(args);
    const result = await BuyOptimizerService.optimize(
        config,
        tickers.length > 0 ? tickers : config.scanTickers,
        days,
        windows,
        thresholds,
        horizons
    );

    console.log('Buy Optimize');
    console.log('============');
    console.log(`Days: ${result.days}`);
    console.log(`Windows: ${result.windows.join(', ')}`);
    console.log(`Thresholds: ${result.thresholds.join(', ')}`);
    console.log(`Horizons: ${result.horizons.join(', ')}`);
    console.log(`Missing: ${result.missing.join(', ') || '-'}`);
    console.log('');
    console.log('Ticker  Window  Score  Signals  3d Avg/WR      5d Avg/WR      10d Avg/WR');
    console.log('------  ------  -----  -------  ------------   ------------   ------------');

    for (const item of result.items.slice(0, limit)) {
        const stat = (horizon: number) => {
            const stats = item.horizons[String(horizon)];
            return `${format(stats?.averageReturnPercent)}%/${format(stats?.winRatePercent, 0)}%`.padStart(12);
        };

        console.log([
            item.ticker.padEnd(6),
            String(item.window).padStart(6),
            String(item.threshold).padStart(5),
            String(item.signals).padStart(7),
            stat(3),
            stat(5),
            stat(10)
        ].join('  '));
    }
};

void main()
    .catch(error => {
        console.error('Buy optimize failed:', error);
        process.exitCode = 1;
    })
    .finally(async () => {
        await sequelize.close().catch(() => undefined);
    });
