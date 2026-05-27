import {
    GetTechAnalysisRequest_IndicatorType
} from 'tinkoff-sdk-grpc-js/dist/generated/marketdata';
import { RobotConfig } from '../config/robot.config';
import { quotationToNumber } from '../utils/money';
import InstrumentsService from './instruments.service';
import MarketDataService from './marketData.service';

type SharesResponse = Awaited<ReturnType<typeof InstrumentsService.getShares>>;
type ShareInstrument = NonNullable<NonNullable<SharesResponse>['instruments']>[number];

const latest = <T extends { timestamp?: Date }>(items: T[] | undefined) =>
    [...(items ?? [])]
        .filter(item => item.timestamp)
        .sort((a, b) => Number(b.timestamp) - Number(a.timestamp))[0];

const findInstrument = (instruments: ShareInstrument[], ticker: string) =>
    instruments.find(instrument => instrument.ticker?.toUpperCase() === ticker.toUpperCase());

const getSignal = (item: { signal?: unknown } | undefined) => quotationToNumber(item?.signal as any);
const getMacd = (item: { macd?: unknown } | undefined) => quotationToNumber(item?.macd as any);

const classifyRsi = (rsi: number | undefined) => {
    if (rsi === undefined) return 'unknown';
    if (rsi >= 70) return 'overbought';
    if (rsi <= 30) return 'oversold';
    return 'neutral';
};

type TechnicalSummaryItem = {
    ticker: string;
    name?: string;
    figi?: string;
    instrumentUid?: string;
    rsi14?: number;
    rsiState?: string;
    sma20?: number;
    ema20?: number;
    macd?: number;
    macdSignal?: number;
    macdState?: string;
    bbUpper?: number;
    bbMiddle?: number;
    bbLower?: number;
    updatedAt?: Date;
    cacheState?: 'fresh' | 'cached' | 'stale' | 'error';
    cachedAt?: string;
    reason?: string;
};

const summaryCache = new Map<string, { expiresAt: number; item: TechnicalSummaryItem }>();

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

export default class TechnicalAnalysisService {
    static async getSummary(config: RobotConfig, tickers = config.buyTickers) {
        const shares = await InstrumentsService.getShares();
        const instruments = shares?.instruments ?? [];
        const normalizedTickers = tickers.map(ticker => ticker.trim().toUpperCase()).filter(Boolean);
        const maxTickers = Math.max(1, config.technicalAnalysisMaxTickers ?? 40);
        const requestedTickers = normalizedTickers.slice(0, maxTickers);
        const skipped = normalizedTickers.slice(maxTickers);
        const items: TechnicalSummaryItem[] = [];
        const missing = [];
        const now = Date.now();
        const cacheTtlMs = Math.max(0, config.technicalAnalysisCacheTtlMs ?? 15 * 60 * 1000);

        for (const ticker of requestedTickers) {
            const instrument = findInstrument(instruments, ticker);

            if (!instrument?.uid) {
                missing.push(ticker);
                continue;
            }

            const cached = summaryCache.get(instrument.uid);

            try {
                if (cached && cached.expiresAt > now) {
                    items.push({
                        ...cached.item,
                        cacheState: 'cached'
                    });
                    continue;
                }

                const [rsi, sma, ema, macd, bb] = await Promise.all([
                    MarketDataService.getTechAnalysis(instrument.uid, GetTechAnalysisRequest_IndicatorType.INDICATOR_TYPE_RSI, 14, 90),
                    MarketDataService.getTechAnalysis(instrument.uid, GetTechAnalysisRequest_IndicatorType.INDICATOR_TYPE_SMA, 20, 90),
                    MarketDataService.getTechAnalysis(instrument.uid, GetTechAnalysisRequest_IndicatorType.INDICATOR_TYPE_EMA, 20, 90),
                    MarketDataService.getTechAnalysis(instrument.uid, GetTechAnalysisRequest_IndicatorType.INDICATOR_TYPE_MACD, 26, 120),
                    MarketDataService.getTechAnalysis(instrument.uid, GetTechAnalysisRequest_IndicatorType.INDICATOR_TYPE_BB, 20, 90)
                ]);
                const rsiLatest = latest(rsi.technicalIndicators);
                const smaLatest = latest(sma.technicalIndicators);
                const emaLatest = latest(ema.technicalIndicators);
                const macdLatest = latest(macd.technicalIndicators);
                const bbLatest = latest(bb.technicalIndicators);
                const rsiValue = getSignal(rsiLatest);
                const macdValue = getMacd(macdLatest);
                const macdSignal = getSignal(macdLatest);

                const item = {
                    ticker: instrument.ticker,
                    name: instrument.name,
                    figi: instrument.figi,
                    instrumentUid: instrument.uid,
                    rsi14: rsiValue,
                    rsiState: classifyRsi(rsiValue),
                    sma20: getSignal(smaLatest),
                    ema20: getSignal(emaLatest),
                    macd: macdValue,
                    macdSignal,
                    macdState: macdValue !== undefined && macdSignal !== undefined
                        ? macdValue >= macdSignal ? 'bullish' : 'bearish'
                        : 'unknown',
                    bbUpper: quotationToNumber(bbLatest?.upperBand),
                    bbMiddle: quotationToNumber(bbLatest?.middleBand),
                    bbLower: quotationToNumber(bbLatest?.lowerBand),
                    updatedAt: rsiLatest?.timestamp ?? smaLatest?.timestamp ?? emaLatest?.timestamp,
                    cacheState: 'fresh' as const,
                    cachedAt: new Date(now).toISOString()
                };

                if (cacheTtlMs > 0) {
                    summaryCache.set(instrument.uid, {
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
                        reason: `stale technical analysis cache after API rate limit: ${error instanceof Error ? error.message : String(error)}`
                    });
                    continue;
                }

                items.push({
                    ticker: instrument.ticker,
                    name: instrument.name,
                    figi: instrument.figi,
                    instrumentUid: instrument.uid,
                    rsiState: 'error',
                    macdState: 'error',
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
