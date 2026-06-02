import { RobotConfig } from '../config/robot.config';
import MarketDataService from '../services/marketData.service';
import { PositionStrategyInput, TradeSignal } from './trade-signal';

const getAgeMs = (value: Date | string | undefined) => {
    if (!value) return undefined;

    const time = value instanceof Date ? value.getTime() : new Date(value).getTime();
    if (!Number.isFinite(time)) return undefined;

    return Date.now() - time;
};

export default class StopLossStrategy {
    private static async getAverageDailyRangePercent(input: {
        accountId?: string;
        ticker?: string;
        instrumentUid: string;
    }, config: RobotConfig) {
        if (config.stopLossVolatilityMultiplier <= 0) return undefined;

        try {
            const candles = await MarketDataService.getDailyCandles(input.instrumentUid, config.stopLossVolatilityDays);
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
            console.warn('Unable to load stop-loss volatility window:', {
                accountId: input.accountId,
                ticker: input.ticker,
                instrumentUid: input.instrumentUid,
                error
            });
            return undefined;
        }
    }

    static async calculateEffectiveStop(input: {
        accountId?: string;
        ticker?: string;
        instrumentUid: string;
    }, config: RobotConfig) {
        const averageDailyRangePercent = await this.getAverageDailyRangePercent(input, config);
        const volatilityStopPercent = averageDailyRangePercent !== undefined
            ? averageDailyRangePercent * config.stopLossVolatilityMultiplier
            : undefined;
        const uncappedStopPercent = Math.max(config.stopLossPercent, volatilityStopPercent ?? 0);
        const effectiveStopPercent = config.stopLossMaxPercent > 0
            ? Math.min(config.stopLossMaxPercent, uncappedStopPercent)
            : uncappedStopPercent;

        return {
            effectiveStopPercent,
            averageDailyRangePercent,
            volatilityStopPercent
        };
    }

    static async evaluate(input: PositionStrategyInput, config: RobotConfig): Promise<TradeSignal | undefined> {
        if (!Number.isFinite(input.averagePrice) || input.averagePrice <= 0) return undefined;
        if (!Number.isFinite(input.currentPrice) || input.currentPrice <= 0) return undefined;

        const lossPercent = ((input.averagePrice - input.currentPrice) / input.averagePrice) * 100;
        const { effectiveStopPercent, averageDailyRangePercent } = await this.calculateEffectiveStop(input, config);

        if (lossPercent < effectiveStopPercent) return undefined;

        const positionAgeMs = getAgeMs(input.lastTradeAt);
        const hardStopPercent = effectiveStopPercent * config.stopLossGraceHardMultiplier;
        if (
            positionAgeMs !== undefined
            && positionAgeMs >= 0
            && config.stopLossGracePeriodMs > 0
            && positionAgeMs < config.stopLossGracePeriodMs
            && lossPercent < hardStopPercent
        ) {
            return {
                action: 'hold',
                source: 'stop-loss',
                confidence: 0.5,
                reason: `soft stop grace: loss ${lossPercent.toFixed(2)}% reached adaptive stop ${effectiveStopPercent.toFixed(2)}%, but position age ${(positionAgeMs / 60000).toFixed(1)}m < ${(config.stopLossGracePeriodMs / 60000).toFixed(0)}m and hard stop ${hardStopPercent.toFixed(2)}% is not reached`,
                quantityLots: 0,
                profitPercent: -lossPercent,
                factors: {
                    effectiveStopPercent,
                    hardStopPercent,
                    positionAgeMinutes: positionAgeMs / 60000,
                    stopLossGracePeriodMinutes: config.stopLossGracePeriodMs / 60000,
                    averageDailyRangePercent: averageDailyRangePercent ?? 0,
                    stopLossVolatilityMultiplier: config.stopLossVolatilityMultiplier,
                    stopLossMaxPercent: config.stopLossMaxPercent
                }
            };
        }

        const availableLots = Math.trunc(input.quantityLots ?? 0);
        if (availableLots <= 0) return undefined;

        return {
            action: 'sell',
            source: 'stop-loss',
            confidence: 1,
            reason: `current price is below average price by ${lossPercent.toFixed(2)}%, adaptive stop ${effectiveStopPercent.toFixed(2)}% (base ${config.stopLossPercent.toFixed(2)}%, avg range ${averageDailyRangePercent?.toFixed(2) ?? '-'}%, max ${config.stopLossMaxPercent > 0 ? config.stopLossMaxPercent.toFixed(2) : 'off'}%)`,
            quantityLots: Math.min(availableLots, config.maxLotsPerOrder),
            profitPercent: -lossPercent,
            factors: {
                effectiveStopPercent,
                averageDailyRangePercent: averageDailyRangePercent ?? 0,
                stopLossVolatilityMultiplier: config.stopLossVolatilityMultiplier,
                stopLossMaxPercent: config.stopLossMaxPercent
            }
        };
    }
}
