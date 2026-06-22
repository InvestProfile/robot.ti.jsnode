import { RobotConfig } from '../config/robot.config';
import { BuyStrategyInput, TradeSignal } from './trade-signal';

const average = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;

export default class TrendFollowBuyStrategy {
    static evaluate(input: BuyStrategyInput, config: RobotConfig): TradeSignal | undefined {
        if (!config.enabledStrategies.includes('trend-follow-buy')) return undefined;
        if (!config.buyTickers.includes(input.ticker.toUpperCase())) return undefined;
        if (!Number.isFinite(input.lastPrice) || input.lastPrice <= 0) return undefined;

        const closes = input.dailyCloses
            ?.filter(value => Number.isFinite(value) && value > 0)
            .slice(-config.buyTrendDays);

        if (!closes || closes.length < config.buyTrendDays) return undefined;

        const movingAverage = average(closes);
        const previousClose = closes[closes.length - 2];
        const trendPercent = movingAverage > 0 ? (input.lastPrice / movingAverage - 1) * 100 : 0;
        const momentumPercent = previousClose > 0 ? (input.lastPrice / previousClose - 1) * 100 : 0;

        if (trendPercent < config.buyMinTrendPercent) return undefined;
        if (momentumPercent < config.buyMinMomentumPercent) return undefined;

        const estimatedLotRub = input.lastPrice * Math.max(1, input.lot);
        if (config.maxOrderRub > 0 && estimatedLotRub > config.maxOrderRub) return undefined;
        if (estimatedLotRub > input.availableCashRub) return undefined;

        return {
            action: 'buy',
            source: 'trend-follow-buy',
            confidence: Math.min(1, Math.max(0.1, (trendPercent + Math.max(0, momentumPercent)) / 10)),
            reason: `price is ${trendPercent.toFixed(2)}% above ${config.buyTrendDays}d average and momentum is ${momentumPercent.toFixed(2)}%`,
            quantityLots: 1,
            profitPercent: 0,
            estimatedOrderRub: estimatedLotRub
        };
    }
}
