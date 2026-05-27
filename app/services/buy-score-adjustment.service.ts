import { RobotConfig } from '../config/robot.config';
import AnalystForecastService from './analyst-forecast.service';
import TechnicalAnalysisService from './technical-analysis.service';

export interface ScoreAdjustment {
    adjustment: number;
    reason: string;
}

interface ScoreAdjustmentOptions {
    includeAnalyst?: boolean;
    includeTechnical?: boolean;
    technicalTickers?: string[];
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
    const cacheNote = item.cacheState === 'stale'
        ? ', stale cache'
        : item.cacheState === 'cached'
            ? ', cached'
            : '';

    if (item.cacheState === 'stale' && adjustment > 0) {
        return {
            adjustment: 0,
            reason: `analyst stale cache ignored positive boost: ${item.recommendation}, target ${finite(item.priceChangePercent) ? item.priceChangePercent.toFixed(2) : '-'}%, votes ${item.buyCount ?? 0}/${item.holdCount ?? 0}/${item.sellCount ?? 0}`
        };
    }

    if (adjustment === 0) return undefined;

    return {
        adjustment,
        reason: `analyst ${item.recommendation}: target ${finite(item.priceChangePercent) ? item.priceChangePercent.toFixed(2) : '-'}%, votes ${item.buyCount ?? 0}/${item.holdCount ?? 0}/${item.sellCount ?? 0}, adjustment ${adjustment}${cacheNote}`
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

    const cacheNote = item.cacheState === 'stale'
        ? ', stale cache'
        : item.cacheState === 'cached'
            ? ', cached'
            : '';

    return {
        adjustment,
        reason: `tech: RSI ${finite(item.rsi14) ? item.rsi14.toFixed(2) : '-'} ${item.rsiState}, MACD ${item.macdState}, adjustment ${adjustment}${cacheNote}`
    };
};

export default class BuyScoreAdjustmentService {
    static async getAdjustments(config: RobotConfig, tickers: string[], options: ScoreAdjustmentOptions = {}) {
        const normalizedTickers = [...new Set(tickers.map(ticker => ticker.toUpperCase()).filter(Boolean))];
        const analyst = new Map<string, ScoreAdjustment>();
        const technical = new Map<string, ScoreAdjustment>();
        const includeAnalyst = options.includeAnalyst ?? true;
        const includeTechnical = options.includeTechnical ?? true;

        if (normalizedTickers.length === 0) {
            return { analyst, technical };
        }

        if (includeAnalyst && config.analystConsensusEnabled) {
            const forecasts = await AnalystForecastService.getForecasts(config, normalizedTickers);
            for (const item of forecasts.items) {
                const adjustment = buildAnalystAdjustment(item, config.analystConsensusMaxScoreAdjustment);
                if (adjustment) analyst.set(item.ticker.toUpperCase(), adjustment);
            }

            for (const ticker of forecasts.skipped ?? []) {
                analyst.set(ticker.toUpperCase(), {
                    adjustment: 0,
                    reason: `analyst skipped: forecast batch limit ${forecasts.maxTickers}`
                });
            }
        }

        if (includeTechnical && config.technicalScoreEnabled) {
            const technicalTickers = options.technicalTickers
                ? [...new Set(options.technicalTickers.map(ticker => ticker.toUpperCase()).filter(Boolean))]
                : normalizedTickers;
            const technicalTickerSet = new Set(technicalTickers);
            const summary = await TechnicalAnalysisService.getSummary(config, technicalTickers);
            for (const item of summary.items) {
                const adjustment = buildTechnicalAdjustment(item, config.technicalMaxScoreAdjustment);
                if (adjustment) technical.set(item.ticker.toUpperCase(), adjustment);
            }

            for (const ticker of summary.skipped ?? []) {
                technical.set(ticker.toUpperCase(), {
                    adjustment: 0,
                    reason: `tech skipped: technical analysis batch limit ${summary.maxTickers}`
                });
            }

            for (const ticker of normalizedTickers) {
                if (!technicalTickerSet.has(ticker) && !technical.has(ticker)) {
                    technical.set(ticker, {
                        adjustment: 0,
                        reason: `tech skipped: technical budget selected ${technicalTickers.length}/${normalizedTickers.length}`
                    });
                }
            }
        }

        return { analyst, technical };
    }
}
