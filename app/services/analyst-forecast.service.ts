import { Recommendation } from 'tinkoff-sdk-grpc-js/dist/generated/instruments';
import { RobotConfig } from '../config/robot.config';
import { quotationToNumber } from '../utils/money';
import InstrumentsService from './instruments.service';

type SharesResponse = Awaited<ReturnType<typeof InstrumentsService.getShares>>;
type ShareInstrument = NonNullable<NonNullable<SharesResponse>['instruments']>[number];

const recommendationLabel = (recommendation: Recommendation | undefined) => {
    switch (recommendation) {
        case Recommendation.RECOMMENDATION_BUY:
            return 'buy';
        case Recommendation.RECOMMENDATION_HOLD:
            return 'hold';
        case Recommendation.RECOMMENDATION_SELL:
            return 'sell';
        default:
            return 'unspecified';
    }
};

const toPercent = (value: number | undefined) => {
    if (value === undefined || !Number.isFinite(value)) return undefined;
    return Math.abs(value) <= 1 ? value * 100 : value;
};

const findInstrument = (instruments: ShareInstrument[], ticker: string) =>
    instruments.find(instrument => instrument.ticker?.toUpperCase() === ticker.toUpperCase());

type ForecastCacheState = 'fresh' | 'cached' | 'stale' | 'error';

type AnalystForecastItem = {
    ticker: string;
    name?: string;
    figi?: string;
    instrumentUid?: string;
    currency?: string;
    recommendation: string;
    currentPrice?: number;
    targetPrice?: number;
    minTarget?: number;
    maxTarget?: number;
    priceChange?: number;
    priceChangePercent?: number;
    targetCount: number;
    buyCount?: number;
    holdCount?: number;
    sellCount?: number;
    prognosisDate?: Date;
    targets?: {
        company?: string;
        recommendation: string;
        recommendationDate?: Date;
        currentPrice?: number;
        targetPrice?: number;
        priceChange?: number;
        priceChangePercent?: number;
    }[];
    cacheState?: ForecastCacheState;
    cachedAt?: string;
    reason?: string;
};

const forecastCache = new Map<string, { expiresAt: number; item: AnalystForecastItem }>();

const isResourceExhausted = (error: unknown) => {
    const data = error as { code?: string | number; message?: string; details?: string };
    const text = [
        data?.code,
        data?.message,
        data?.details,
        error
    ].map(value => String(value ?? '').toLowerCase()).join(' ');

    return text.includes('resource_exhausted')
        || text.includes('rate limit')
        || text.includes('too many requests')
        || text.includes('middleware returned void')
        || text.includes('code: 8');
};

const buildForecastItem = (
    instrument: ShareInstrument,
    forecast: Awaited<ReturnType<typeof InstrumentsService.getForecastBy>>,
    cachedAt: string
): AnalystForecastItem => {
    const consensus = forecast?.consensus;
    const currentPrice = quotationToNumber(consensus?.currentPrice);
    const targetPrice = quotationToNumber(consensus?.consensus);
    const priceChange = quotationToNumber(consensus?.priceChange);
    const priceChangePercent = toPercent(quotationToNumber(consensus?.priceChangeRel));
    const targets = forecast?.targets ?? [];

    return {
        ticker: instrument.ticker,
        name: instrument.name,
        figi: instrument.figi,
        instrumentUid: instrument.uid,
        currency: consensus?.currency || instrument.currency,
        recommendation: recommendationLabel(consensus?.recommendation),
        currentPrice,
        targetPrice,
        minTarget: quotationToNumber(consensus?.minTarget),
        maxTarget: quotationToNumber(consensus?.maxTarget),
        priceChange,
        priceChangePercent,
        targetCount: targets.length,
        buyCount: targets.filter(target => target.recommendation === Recommendation.RECOMMENDATION_BUY).length,
        holdCount: targets.filter(target => target.recommendation === Recommendation.RECOMMENDATION_HOLD).length,
        sellCount: targets.filter(target => target.recommendation === Recommendation.RECOMMENDATION_SELL).length,
        prognosisDate: targets
            .map(target => target.recommendationDate)
            .filter((date): date is Date => Boolean(date))
            .sort((a, b) => b.getTime() - a.getTime())[0],
        targets: targets.map(target => ({
            company: target.company,
            recommendation: recommendationLabel(target.recommendation),
            recommendationDate: target.recommendationDate,
            currentPrice: quotationToNumber(target.currentPrice),
            targetPrice: quotationToNumber(target.targetPrice),
            priceChange: quotationToNumber(target.priceChange),
            priceChangePercent: toPercent(quotationToNumber(target.priceChangeRel))
        })),
        cacheState: 'fresh',
        cachedAt
    };
};

export default class AnalystForecastService {
    static async getForecasts(config: RobotConfig, tickers = config.buyTickers) {
        const shares = await InstrumentsService.getShares();
        const instruments = shares?.instruments ?? [];
        const normalizedTickers = tickers.map(ticker => ticker.trim().toUpperCase()).filter(Boolean);
        const maxTickers = Math.max(1, config.analystForecastMaxTickers ?? 40);
        const requestedTickers = normalizedTickers.slice(0, maxTickers);
        const skipped = normalizedTickers.slice(maxTickers);
        const items: AnalystForecastItem[] = [];
        const missing = [];
        const now = Date.now();
        const cacheTtlMs = Math.max(0, config.analystForecastCacheTtlMs ?? 6 * 60 * 60 * 1000);

        for (const ticker of requestedTickers) {
            const instrument = findInstrument(instruments, ticker);

            if (!instrument?.uid) {
                missing.push(ticker);
                continue;
            }

            const cached = forecastCache.get(instrument.uid);

            try {
                if (cached && cached.expiresAt > now) {
                    items.push({
                        ...cached.item,
                        cacheState: 'cached'
                    });
                    continue;
                }

                const forecast = await InstrumentsService.getForecastBy(instrument.uid);
                const item = buildForecastItem(instrument, forecast, new Date(now).toISOString());

                if (cacheTtlMs > 0) {
                    forecastCache.set(instrument.uid, {
                        expiresAt: now + cacheTtlMs,
                        item
                    });
                }

                items.push(item);
            } catch (error) {
                if (cached && isResourceExhausted(error)) {
                    items.push({
                        ...cached.item,
                        cacheState: 'stale',
                        reason: `stale analyst forecast cache after API rate limit: ${error instanceof Error ? error.message : String(error)}`
                    });
                    continue;
                }

                items.push({
                    ticker: instrument.ticker,
                    name: instrument.name,
                    figi: instrument.figi,
                    instrumentUid: instrument.uid,
                    recommendation: 'error',
                    targetCount: 0,
                    cacheState: 'error',
                    reason: error instanceof Error ? error.message : String(error)
                });
            }
        }

        return {
            generatedAt: new Date().toISOString(),
            tickers: normalizedTickers,
            skipped,
            maxTickers,
            cacheTtlMs,
            missing,
            items
        };
    }
}
