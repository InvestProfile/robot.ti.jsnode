import { RobotConfig } from '../config/robot.config';
import InstrumentsService from './instruments.service';
import MarketDataService from './marketData.service';

interface MarketRegimeItem {
    ticker: string;
    name?: string;
    trendPercent?: number;
    passed: boolean;
    reason: string;
}

const average = (values: number[]) => values.length > 0
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : undefined;

export default class MarketRegimeService {
    static async evaluate(config: RobotConfig) {
        if (!config.marketRegimeEnabled) {
            return {
                enabled: false,
                passed: true,
                reason: 'market regime filter disabled',
                items: [] as MarketRegimeItem[]
            };
        }

        const shares = await InstrumentsService.getShares();
        const instruments = shares?.instruments ?? [];
        const items: MarketRegimeItem[] = [];

        for (const ticker of config.marketRegimeTickers) {
            const instrument = instruments.find(item => item.ticker?.toUpperCase() === ticker);

            if (!instrument?.uid) {
                items.push({
                    ticker,
                    passed: false,
                    reason: 'instrument not found'
                });
                continue;
            }

            const candles = await MarketDataService.getDailyCandles(instrument.uid, config.marketRegimeDays);
            const closes = candles
                .map(candle => candle.close)
                .filter(value => Number.isFinite(value) && value > 0);
            const current = closes[closes.length - 1];
            const avg = average(closes);
            const trendPercent = current && avg ? (current / avg - 1) * 100 : undefined;
            const passed = trendPercent !== undefined && trendPercent >= config.marketRegimeMinAvgTrendPercent;

            items.push({
                ticker,
                name: instrument.name,
                trendPercent,
                passed,
                reason: trendPercent === undefined
                    ? 'not enough candles'
                    : `trend ${trendPercent.toFixed(2)}% vs ${config.marketRegimeDays}d average`
            });
        }

        const measured = items.filter(item => item.trendPercent !== undefined);
        const passedCount = measured.filter(item => item.passed).length;
        const healthPercent = measured.length > 0 ? passedCount / measured.length * 100 : 0;
        const avgTrendPercent = average(
            measured
                .map(item => item.trendPercent)
                .filter((value): value is number => value !== undefined)
        );
        const passed = measured.length > 0 && healthPercent >= config.marketRegimeMinHealthPercent;

        return {
            enabled: true,
            passed,
            reason: passed
                ? `market health ${healthPercent.toFixed(0)}% (${passedCount}/${measured.length}), avg trend ${(avgTrendPercent ?? 0).toFixed(2)}%`
                : `market regime blocked: health ${healthPercent.toFixed(0)}% (${passedCount}/${measured.length}) below ${config.marketRegimeMinHealthPercent}%`,
            healthPercent,
            avgTrendPercent,
            passedCount,
            measuredCount: measured.length,
            items
        };
    }
}
