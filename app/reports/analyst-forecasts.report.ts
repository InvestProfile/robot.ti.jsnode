import sequelize from '../config/database';
import { getRobotConfig } from '../config/robot.config';
import AnalystForecastService from '../services/analyst-forecast.service';

const formatNumber = (value: number | undefined, digits = 2) => {
    if (value === undefined || !Number.isFinite(value)) return '-';
    return value.toFixed(digits);
};

const main = async () => {
    const config = getRobotConfig();
    const tickers = process.argv.slice(2).map(ticker => ticker.toUpperCase()).filter(Boolean);
    const result = await AnalystForecastService.getForecasts(config, tickers.length ? tickers : config.buyTickers);

    console.log('Analyst Forecasts');
    console.log('=================');
    console.log(`Tickers: ${result.tickers.join(', ') || '-'}`);
    console.log(`Missing: ${result.missing.join(', ') || '-'}`);
    console.log('');
    console.log('Ticker  Rec   Price       Target      Upside    Analysts  Buy/Hold/Sell  Date');
    console.log('------  ----  ----------  ----------  --------  --------  -------------  ----------');

    for (const item of result.items) {
        console.log([
            item.ticker.padEnd(6),
            item.recommendation.padEnd(4),
            formatNumber(item.currentPrice).padStart(10),
            formatNumber(item.targetPrice).padStart(10),
            `${formatNumber(item.priceChangePercent)}%`.padStart(8),
            String(item.targetCount ?? 0).padStart(8),
            `${item.buyCount ?? 0}/${item.holdCount ?? 0}/${item.sellCount ?? 0}`.padStart(13),
            item.prognosisDate ? item.prognosisDate.toISOString().slice(0, 10) : '-'
        ].join('  '));
    }
};

void main()
    .catch(error => {
        console.error('Failed to build analyst forecasts report:', error);
        process.exitCode = 1;
    })
    .finally(async () => {
        await sequelize.close().catch(() => undefined);
    });
