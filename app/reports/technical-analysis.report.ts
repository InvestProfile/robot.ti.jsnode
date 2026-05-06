import sequelize from '../config/database';
import { getRobotConfig } from '../config/robot.config';
import TechnicalAnalysisService from '../services/technical-analysis.service';

const formatNumber = (value: number | undefined, digits = 2) => {
    if (value === undefined || !Number.isFinite(value)) return '-';
    return value.toFixed(digits);
};

const main = async () => {
    const config = getRobotConfig();
    const tickers = process.argv.slice(2).map(ticker => ticker.toUpperCase()).filter(Boolean);
    const result = await TechnicalAnalysisService.getSummary(config, tickers.length ? tickers : config.buyTickers);

    console.log('Technical Analysis');
    console.log('==================');
    console.log(`Tickers: ${result.tickers.join(', ') || '-'}`);
    console.log(`Missing: ${result.missing.join(', ') || '-'}`);
    console.log('');
    console.log('Ticker  RSI14     RSI state   SMA20       EMA20       MACD       MACD state');
    console.log('------  --------  ----------  ----------  ----------  ---------  ----------');

    for (const item of result.items) {
        console.log([
            item.ticker.padEnd(6),
            formatNumber(item.rsi14).padStart(8),
            String(item.rsiState).padEnd(10),
            formatNumber(item.sma20).padStart(10),
            formatNumber(item.ema20).padStart(10),
            formatNumber(item.macd, 4).padStart(9),
            String(item.macdState).padEnd(10)
        ].join('  '));
    }
};

void main()
    .catch(error => {
        console.error('Failed to build technical analysis report:', error);
        process.exitCode = 1;
    })
    .finally(async () => {
        await sequelize.close().catch(() => undefined);
    });
