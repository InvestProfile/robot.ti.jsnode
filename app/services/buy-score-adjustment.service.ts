import { RobotConfig } from '../config/robot.config';
import AnalystForecastService from './analyst-forecast.service';
import TechnicalAnalysisService from './technical-analysis.service';

export interface ScoreAdjustment {
    adjustment: number;
    reason: string;
}

type AnalystForecasts = Awaited<ReturnType<typeof AnalystForecastService.getForecasts>>;
type AnalystItem = AnalystForecasts['items'][number];
type TechnicalSummary = Awaited<ReturnType<typeof TechnicalAnalysisService.getSummary>>;
type TechnicalItem = TechnicalSummary['items'][number];

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

const buildAnalystAdjustment = (item: AnalystItem, maxAdjustment: number): ScoreAdjustment | undefined => {
    if (maxAdjustment <= 0 || item.recommendation === 'error') return undefined;

    const targetCount = item.targetCount ?? 0;
    if (targetCount <= 0) return undefined;

    const recommendationWeight = item.recommendation === 'buy'
        ? 1
        : item.recommendation === 'sell'
            ? -1
            : 0;
    const upsideWeight = finite(item.priceChangePercent)
        ? clamp(item.priceChangePercent / 30, -1, 1)
        : 0;
    const voteWeight = targetCount > 0
        ? clamp(((item.buyCount ?? 0) - (item.sellCount ?? 0)) / targetCount, -1, 1)
        : 0;
    const raw = 0.45 * recommendationWeight + 0.35 * upsideWeight + 0.20 * voteWeight;
    const adjustment = Math.round(clamp(raw * maxAdjustment, -maxAdjustment, maxAdjustment));

    if (adjustment === 0) return undefined;

    return {
        adjustment,
        reason: `analyst ${item.recommendation}: target ${finite(item.priceChangePercent) ? item.priceChangePercent.toFixed(2) : '-'}%, votes ${item.buyCount ?? 0}/${item.holdCount ?? 0}/${item.sellCount ?? 0}, adjustment ${adjustment}`
    };
};

const buildTechnicalAdjustment = (item: TechnicalItem, maxAdjustment: number): ScoreAdjustment | undefined => {
    if (maxAdjustment <= 0 || item.rsiState === 'error' || item.macdState === 'error') return undefined;

    let raw = 0;

    if (finite(item.rsi14)) {
        if (item.rsi14 <= 30) raw += 0.50;
        else if (item.rsi14 >= 70) raw -= 0.50;
        else if (item.rsi14 >= 45 && item.rsi14 <= 60) raw += 0.20;
    }

    if (item.macdState === 'bullish') raw += 0.35;
    if (item.macdState === 'bearish') raw -= 0.35;

    if (finite(item.ema20) && finite(item.sma20)) {
        raw += item.ema20 >= item.sma20 ? 0.15 : -0.15;
    }

    const adjustment = Math.round(clamp(raw * maxAdjustment, -maxAdjustment, maxAdjustment));
    if (adjustment === 0) return undefined;

    return {
        adjustment,
        reason: `tech: RSI ${finite(item.rsi14) ? item.rsi14.toFixed(2) : '-'} ${item.rsiState}, MACD ${item.macdState}, adjustment ${adjustment}`
    };
};

export default class BuyScoreAdjustmentService {
    static async getAdjustments(config: RobotConfig, tickers: string[]) {
        const normalizedTickers = [...new Set(tickers.map(ticker => ticker.toUpperCase()).filter(Boolean))];
        const analyst = new Map<string, ScoreAdjustment>();
        const technical = new Map<string, ScoreAdjustment>();

        if (normalizedTickers.length === 0) {
            return { analyst, technical };
        }

        if (config.analystConsensusEnabled) {
            const forecasts = await AnalystForecastService.getForecasts(config, normalizedTickers);
            for (const item of forecasts.items) {
                const adjustment = buildAnalystAdjustment(item, config.analystConsensusMaxScoreAdjustment);
                if (adjustment) analyst.set(item.ticker.toUpperCase(), adjustment);
            }
        }

        if (config.technicalScoreEnabled) {
            const summary = await TechnicalAnalysisService.getSummary(config, normalizedTickers);
            for (const item of summary.items) {
                const adjustment = buildTechnicalAdjustment(item, config.technicalMaxScoreAdjustment);
                if (adjustment) technical.set(item.ticker.toUpperCase(), adjustment);
            }
        }

        return { analyst, technical };
    }
}
