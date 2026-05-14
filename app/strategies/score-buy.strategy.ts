import { RobotConfig } from '../config/robot.config';
import { BuyStrategyInput, DailyCandle, TradeSignal } from './trade-signal';

const average = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

const getReturns = (closes: number[]) => closes
    .slice(1)
    .map((close, index) => closes[index] > 0 ? (close / closes[index] - 1) * 100 : 0);

const getStandardDeviation = (values: number[]) => {
    if (values.length === 0) return 0;

    const mean = average(values);
    const variance = average(values.map(value => (value - mean) ** 2));
    return Math.sqrt(variance);
};

export interface BuyScoreAnalysis {
    score: number;
    passed: boolean;
    reason: string;
    estimatedOrderRub?: number;
    factors: Record<string, number>;
}

export default class ScoreBuyStrategy {
    static analyze(input: BuyStrategyInput, config: RobotConfig): BuyScoreAnalysis | undefined {
        if (!config.buyTickers.includes(input.ticker.toUpperCase())) return undefined;
        if (!Number.isFinite(input.lastPrice) || input.lastPrice <= 0) return undefined;

        const candles = input.dailyCandles
            ?.filter((candle): candle is DailyCandle =>
                Number.isFinite(candle.close)
                && Number.isFinite(candle.high)
                && Number.isFinite(candle.low)
                && Number.isFinite(candle.volume)
                && candle.close > 0
                && candle.high > 0
                && candle.low > 0
            )
            .slice(-config.buyTrendDays);

        if (!candles || candles.length < config.buyTrendDays) {
            return {
                score: 0,
                passed: false,
                reason: `not enough daily candles: ${candles?.length ?? 0}/${config.buyTrendDays}`,
                factors: {}
            };
        }

        const closes = candles.map(candle => candle.close);
        const highs = candles.map(candle => candle.high);
        const volumes = candles.map(candle => candle.volume);
        const movingAverage = average(closes);
        const previousClose = closes[closes.length - 2];
        const recentHigh = Math.max(...highs);
        const returns = getReturns(closes);
        const volatilityPercent = getStandardDeviation(returns);
        const averageVolume = average(volumes);
        const trendPercent = movingAverage > 0 ? (input.lastPrice / movingAverage - 1) * 100 : 0;
        const momentumPercent = previousClose > 0 ? (input.lastPrice / previousClose - 1) * 100 : 0;
        const belowHighPercent = recentHigh > 0 ? (recentHigh / input.lastPrice - 1) * 100 : 0;

        const trendScore = clamp((trendPercent / 4) * 30, 0, 30);
        const momentumScore = clamp((momentumPercent / 2) * 20, 0, 20);
        const pullbackScore = belowHighPercent < 0
            ? 0
            : belowHighPercent <= 1
                ? 8
                : belowHighPercent <= 6
                    ? 20
                    : belowHighPercent <= 12
                        ? 10
                        : 0;
        const volatilityScore = volatilityPercent <= 1.5
            ? 15
            : volatilityPercent <= 3
                ? 10
                : volatilityPercent <= 5
                    ? 5
                    : 0;
        const volumeScore = averageVolume > 0 ? 15 : 0;
        const baseScore = Math.round(trendScore + momentumScore + pullbackScore + volatilityScore + volumeScore);
        const socialScoreAdjustment = Number.isFinite(input.socialScoreAdjustment)
            ? Math.round(input.socialScoreAdjustment ?? 0)
            : 0;
        const analystScoreAdjustment = Number.isFinite(input.analystScoreAdjustment)
            ? Math.round(input.analystScoreAdjustment ?? 0)
            : 0;
        const technicalScoreAdjustment = Number.isFinite(input.technicalScoreAdjustment)
            ? Math.round(input.technicalScoreAdjustment ?? 0)
            : 0;
        const totalAdjustment = socialScoreAdjustment + analystScoreAdjustment + technicalScoreAdjustment;
        const score = Math.round(clamp(baseScore + totalAdjustment, 0, 100));
        const estimatedLotRub = input.lastPrice * Math.max(1, input.lot);
        const factors = {
            baseScore,
            trendScore,
            momentumScore,
            pullbackScore,
            volatilityScore,
            volumeScore,
            socialScoreAdjustment,
            socialScore: input.socialScore ?? 0,
            analystScoreAdjustment,
            technicalScoreAdjustment,
            totalAdjustment,
            trendPercent,
            momentumPercent,
            belowHighPercent,
            volatilityPercent,
            averageVolume
        };
        const externalReasons = [
            input.socialReason,
            input.analystReason,
            input.technicalReason
        ].filter(Boolean).join(', ');
        const reason = `score ${score}/${config.buyMinScore}: base ${baseScore}, adj ${totalAdjustment}, social ${socialScoreAdjustment}, analyst ${analystScoreAdjustment}, tech ${technicalScoreAdjustment}, trend ${trendPercent.toFixed(2)}%, momentum ${momentumPercent.toFixed(2)}%, below high ${belowHighPercent.toFixed(2)}%, volatility ${volatilityPercent.toFixed(2)}%${externalReasons ? `, ${externalReasons}` : ''}`;

        if (score < config.buyMinScore) {
            return {
                score,
                passed: false,
                reason,
                estimatedOrderRub: estimatedLotRub,
                factors
            };
        }

        if (estimatedLotRub > config.maxOrderRub) {
            return {
                score,
                passed: false,
                reason: 'estimated lot is above max order RUB',
                estimatedOrderRub: estimatedLotRub,
                factors
            };
        }

        if (estimatedLotRub > input.availableCashRub) {
            return {
                score,
                passed: false,
                reason: 'not enough cash for estimated lot',
                estimatedOrderRub: estimatedLotRub,
                factors
            };
        }

        return {
            score,
            passed: true,
            reason,
            estimatedOrderRub: estimatedLotRub,
            factors
        };
    }

    static evaluate(input: BuyStrategyInput, config: RobotConfig): TradeSignal | undefined {
        if (!config.enabledStrategies.includes('score-buy')) return undefined;

        const analysis = this.analyze(input, config);
        if (!analysis?.passed || analysis.estimatedOrderRub === undefined) return undefined;

        return {
            action: 'buy',
            source: 'score-buy',
            confidence: clamp(analysis.score / 100, 0.1, 1),
            reason: analysis.reason,
            quantityLots: 1,
            profitPercent: 0,
            estimatedOrderRub: analysis.estimatedOrderRub,
            score: analysis.score,
            factors: analysis.factors
        };
    }
}
