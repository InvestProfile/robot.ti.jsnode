import { RobotConfig } from '../config/robot.config';
import MarketDataService from '../services/marketData.service';
import PositionStateService from '../services/position-state.service';
import { PositionStrategyInput, TradeSignal } from './trade-signal';

export default class TrailingStopStrategy {
    private static async getAverageDailyRangePercent(input: PositionStrategyInput, config: RobotConfig) {
        if (config.trailingStopVolatilityMultiplier <= 0) return undefined;

        try {
            const candles = await MarketDataService.getDailyCandles(input.instrumentUid, config.trailingStopVolatilityDays);
            const ranges = candles
                .map(candle => {
                    if (!Number.isFinite(candle.high) || !Number.isFinite(candle.low) || !Number.isFinite(candle.close) || candle.close <= 0) {
                        return undefined;
                    }

                    return ((candle.high - candle.low) / candle.close) * 100;
                })
                .filter((value): value is number => value !== undefined && Number.isFinite(value) && value >= 0);

            if (ranges.length === 0) return undefined;

            return ranges.reduce((sum, value) => sum + value, 0) / ranges.length;
        } catch (error) {
            console.warn('Unable to load trailing-stop volatility window:', {
                accountId: input.accountId,
                ticker: input.ticker,
                instrumentUid: input.instrumentUid,
                error
            });
            return undefined;
        }
    }

    static async evaluate(input: PositionStrategyInput, config: RobotConfig): Promise<TradeSignal | undefined> {
        if (!Number.isFinite(input.currentPrice) || input.currentPrice <= 0) return undefined;

        const state = await PositionStateService.updateHighWaterMark({
            accountId: input.accountId,
            figi: input.figi,
            instrumentUid: input.instrumentUid,
            ticker: input.ticker,
            name: input.name,
            currentPrice: input.currentPrice,
            trailingBaseline: config.trailingBaseline
        });

        if (state.highestPrice <= 0) return undefined;

        const drawdownPercent = ((state.highestPrice - input.currentPrice) / state.highestPrice) * 100;
        const averageDailyRangePercent = await this.getAverageDailyRangePercent(input, config);
        const volatilityStopPercent = averageDailyRangePercent !== undefined
            ? averageDailyRangePercent * config.trailingStopVolatilityMultiplier
            : undefined;
        const effectiveStopPercent = Math.max(config.trailingStopPercent, volatilityStopPercent ?? 0);

        if (drawdownPercent < effectiveStopPercent) return undefined;

        if (!Number.isFinite(input.averagePrice) || input.averagePrice <= 0) return undefined;

        const profitPercent = ((input.currentPrice - input.averagePrice) / input.averagePrice) * 100;
        if (profitPercent < config.trailingStopMinProfitPercent) return undefined;

        const availableLots = Math.trunc(input.quantityLots ?? 0);
        if (availableLots <= 0) return undefined;

        return {
            action: 'sell',
            source: 'trailing-stop',
            confidence: 1,
            reason: `current price is ${drawdownPercent.toFixed(2)}% below ${config.trailingBaseline} high ${state.highestPrice.toFixed(2)}, adaptive stop ${effectiveStopPercent.toFixed(2)}% (base ${config.trailingStopPercent.toFixed(2)}%, avg range ${averageDailyRangePercent?.toFixed(2) ?? '-'}%), profit ${profitPercent.toFixed(2)}% >= trailing min ${config.trailingStopMinProfitPercent.toFixed(2)}%`,
            quantityLots: Math.min(availableLots, config.maxLotsPerOrder),
            profitPercent,
            factors: {
                highestPrice: state.highestPrice,
                drawdownPercent,
                effectiveStopPercent,
                averageDailyRangePercent: averageDailyRangePercent ?? 0,
                trailingStopVolatilityMultiplier: config.trailingStopVolatilityMultiplier,
                trailingStopMinProfitPercent: config.trailingStopMinProfitPercent
            }
        };
    }
}
