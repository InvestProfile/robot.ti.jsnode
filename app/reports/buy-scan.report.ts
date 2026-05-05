import sequelize from '../config/database';
import { getRobotConfig } from '../config/robot.config';
import BuyScannerService from '../services/buy-scanner.service';
import ScanTargetsService from '../services/scan-targets.service';

const formatNumber = (value: number | undefined, digits = 2) => {
    if (value === undefined || !Number.isFinite(value)) return '-';
    return value.toFixed(digits);
};

const main = async () => {
    const config = getRobotConfig();
    const tickers = process.argv.slice(2).map(ticker => ticker.toUpperCase()).filter(Boolean);
    const targets = await ScanTargetsService.resolve(config, tickers);
    const result = await BuyScannerService.scan(config, targets.tickers);

    console.log('Buy Scan');
    console.log('========');
    console.log(`Targets: ${targets.mode}, ${targets.tickers.length} tickers`);
    console.log(`Min score: ${result.minScore}`);
    console.log(`Trend days: ${result.trendDays}`);
    console.log(`Missing: ${result.missing.join(', ') || '-'}`);
    console.log('');
    console.log('Ticker  Profile  Score  Price       Amount      Trend    Momentum  HighGap  Vol      Result');
    console.log('------  -------  -----  ----------  ----------  -------  --------  -------  -------  ------');

    for (const item of result.items) {
        const factors = item.analysis?.factors;
        console.log([
            item.ticker.padEnd(6),
            `${item.profile?.trendDays ?? result.trendDays}/${item.profile?.minScore ?? result.minScore}`.padStart(7),
            String(item.score ?? '-').padStart(5),
            formatNumber(item.lastPrice).padStart(10),
            formatNumber(item.estimatedOrderRub).padStart(10),
            formatNumber(factors?.trendPercent).padStart(7),
            formatNumber(factors?.momentumPercent).padStart(8),
            formatNumber(factors?.belowHighPercent).padStart(7),
            formatNumber(factors?.volatilityPercent).padStart(7),
            item.passed ? 'PASS' : item.reason
        ].join('  '));
    }
};

void main()
    .catch(error => {
        console.error('Buy scan failed:', error);
        process.exitCode = 1;
    })
    .finally(async () => {
        await sequelize.close().catch(() => undefined);
    });
