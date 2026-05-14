
import { getEnv } from '../config/env.config';
// import { createSdk } from 'tinkoff-sdk-grpc-js';
import {getSdk} from './get-sdk';
import {
    CandleInterval,
    GetTechAnalysisRequest_IndicatorInterval,
    GetTechAnalysisRequest_IndicatorType,
    GetTechAnalysisRequest_TypeOfPrice,
    GetTradingStatusResponse,
    MarketValueType
} from 'tinkoff-sdk-grpc-js/dist/generated/marketdata';
import { quotationToNumber } from '../utils/money';
import { DailyCandle } from '../strategies/trade-signal';
import TInvestApiCacheService from './tinvest-api-cache.service';

const envVariables = getEnv();

const sortedKey = (items: string[]) => [...new Set(items.filter(Boolean))].sort().join(',');
const dayBucket = () => new Date().toISOString().slice(0, 10);

export default class MarketDataService {
    static async getStatus(
        figi: string,
        instrumentId: string
    ): Promise<GetTradingStatusResponse | undefined> {
        if (envVariables.INVEST_TOKEN) {
            try {
                const statuses = await this.getStatuses([instrumentId]);
                return statuses.get(instrumentId) ?? statuses.get(figi);
            } catch (error) {
                console.error('Error while getting trading status:', error);
                const grpcError = error as { code?: string };
                if (grpcError.code === 'UNAVAILABLE') {
                    throw new Error('Сервер недоступен. Пожалуйста, проверьте ваше соединение и попробуйте снова.');
                }
                throw error;
            }
        } else {
            throw new Error('INVEST_TOKEN is not defined.');
        }
    }

    static async getStatuses(instrumentIds: string[]): Promise<Map<string, GetTradingStatusResponse>> {
        if (!envVariables.INVEST_TOKEN) {
            throw new Error('INVEST_TOKEN is not defined.');
        }

        const ids = [...new Set(instrumentIds.filter(Boolean))];
        if (ids.length === 0) return new Map<string, GetTradingStatusResponse>();

        const {marketData} = getSdk(envVariables.INVEST_TOKEN);
        const response = await TInvestApiCacheService.cached(
            `market:statuses:${sortedKey(ids)}`,
            15_000,
            () => marketData.getTradingStatuses({ instrumentId: ids })
        );

        const statuses = new Map<string, GetTradingStatusResponse>();
        for (const status of response.tradingStatuses ?? []) {
            if (status.instrumentUid) statuses.set(status.instrumentUid, status);
            if (status.figi) statuses.set(status.figi, status);
        }

        return statuses;
    }

    static async getHighestDailyCandlePrice(
        instrumentId: string,
        days: number
    ) {
        if (!envVariables.INVEST_TOKEN) {
            throw new Error('INVEST_TOKEN is not defined.');
        }

        const candles = await this.getDailyCandles(instrumentId, days);
        const highs = candles
            .map(candle => candle.high)
            .filter((value): value is number => value !== undefined && Number.isFinite(value));

        if (!highs?.length) return undefined;

        return Math.max(...highs);
    }

    static async getDailyClosePrices(
        instrumentId: string,
        days: number
    ) {
        if (!envVariables.INVEST_TOKEN) {
            throw new Error('INVEST_TOKEN is not defined.');
        }

        const candles = await this.getDailyCandles(instrumentId, days);
        return candles
            .map(candle => candle.close)
            .filter((value): value is number => value !== undefined && Number.isFinite(value));
    }

    static async getDailyCandles(
        instrumentId: string,
        days: number
    ): Promise<DailyCandle[]> {
        if (!envVariables.INVEST_TOKEN) {
            throw new Error('INVEST_TOKEN is not defined.');
        }

        const {marketData} = getSdk(envVariables.INVEST_TOKEN);
        const response = await TInvestApiCacheService.cached(
            `market:candles:day:${instrumentId}:${days}:${dayBucket()}`,
            10 * 60 * 1000,
            () => {
                const to = new Date();
                const from = new Date(to.getTime() - Math.max(days + 10, days) * 24 * 60 * 60 * 1000);

                return marketData.getCandles({
                    instrumentId,
                    from,
                    to,
                    interval: CandleInterval.CANDLE_INTERVAL_DAY
                });
            }
        );

        return response.candles?.flatMap(candle => {
            const close = quotationToNumber(candle.close);
            const high = quotationToNumber(candle.high);
            const low = quotationToNumber(candle.low);
            const volume = Number(candle.volume ?? 0);

            if (close === undefined || high === undefined || low === undefined || !Number.isFinite(volume)) {
                return [];
            }

            return [{
                close,
                high,
                low,
                volume,
                time: candle.time
            }];
        }) ?? [];
    }

    static async getLastPrices(instrumentIds: string[]) {
        if (!envVariables.INVEST_TOKEN) {
            throw new Error('INVEST_TOKEN is not defined.');
        }

        if (instrumentIds.length === 0) return new Map<string, number>();

        const ids = [...new Set(instrumentIds.filter(Boolean))];
        const {marketData} = getSdk(envVariables.INVEST_TOKEN);
        const response = await TInvestApiCacheService.cached(
            `market:last-prices:${sortedKey(ids)}`,
            10_000,
            () => marketData.getLastPrices({
                instrumentId: ids
            })
        );

        return new Map(
            response.lastPrices
                ?.map(lastPrice => [lastPrice.instrumentUid, quotationToNumber(lastPrice.price)] as const)
                .filter((entry): entry is readonly [string, number] => Boolean(entry[0]) && entry[1] !== undefined && Number.isFinite(entry[1]))
        );
    }

    static async getMarketValues(
        instrumentIds: string[],
        values: MarketValueType[] = [MarketValueType.INSTRUMENT_VALUE_LAST_PRICE, MarketValueType.INSTRUMENT_VALUE_CLOSE_PRICE]
    ) {
        if (!envVariables.INVEST_TOKEN) {
            throw new Error('INVEST_TOKEN is not defined.');
        }

        const ids = [...new Set(instrumentIds.filter(Boolean))];
        if (ids.length === 0) return { instruments: [] };

        const {marketData} = getSdk(envVariables.INVEST_TOKEN);
        return await TInvestApiCacheService.cached(
            `market:values:${sortedKey(ids)}:${values.join(',')}`,
            30_000,
            () => marketData.getMarketValues({
                instrumentId: ids,
                values
            })
        );
    }

    static async getOrderBookMetrics(instrumentId: string, lot = 1, depth = 10) {
        if (!envVariables.INVEST_TOKEN) {
            throw new Error('INVEST_TOKEN is not defined.');
        }

        if (!instrumentId) return undefined;

        const {marketData} = getSdk(envVariables.INVEST_TOKEN);
        const orderBook = await TInvestApiCacheService.cached(
            `market:orderbook:${instrumentId}:${depth}`,
            10_000,
            () => marketData.getOrderBook({
                instrumentId,
                depth
            })
        );
        const bestBid = quotationToNumber(orderBook.bids?.[0]?.price);
        const bestAsk = quotationToNumber(orderBook.asks?.[0]?.price);
        const safeLot = Math.max(1, lot);
        const sumRub = (orders: typeof orderBook.asks) => orders.reduce((sum, order) => {
            const price = quotationToNumber(order.price);
            const quantity = Number(order.quantity ?? 0);
            if (!price || !Number.isFinite(quantity) || quantity <= 0) return sum;
            return sum + price * quantity * safeLot;
        }, 0);
        const mid = bestBid && bestAsk ? (bestBid + bestAsk) / 2 : undefined;

        return {
            bestBid,
            bestAsk,
            spreadPercent: mid && mid > 0 && bestAsk !== undefined && bestBid !== undefined
                ? (bestAsk - bestBid) / mid * 100
                : undefined,
            bidLiquidityRub: sumRub(orderBook.bids ?? []),
            askLiquidityRub: sumRub(orderBook.asks ?? []),
            depth: orderBook.depth,
            orderbookTs: orderBook.orderbookTs
        };
    }

    static async getTechAnalysis(
        instrumentUid: string,
        indicatorType: GetTechAnalysisRequest_IndicatorType,
        length: number,
        days = Math.max(length * 3, 60)
    ) {
        if (!envVariables.INVEST_TOKEN) {
            throw new Error('INVEST_TOKEN is not defined.');
        }

        const {marketData} = getSdk(envVariables.INVEST_TOKEN);
        return await TInvestApiCacheService.cached(
            `market:tech:${instrumentUid}:${indicatorType}:${length}:${days}:${dayBucket()}`,
            30 * 60 * 1000,
            () => {
                const to = new Date();
                const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);

                return marketData.getTechAnalysis({
                    indicatorType,
                    instrumentUid,
                    from,
                    to,
                    interval: GetTechAnalysisRequest_IndicatorInterval.INDICATOR_INTERVAL_ONE_DAY,
                    typeOfPrice: GetTechAnalysisRequest_TypeOfPrice.TYPE_OF_PRICE_CLOSE,
                    length,
                    deviation: indicatorType === GetTechAnalysisRequest_IndicatorType.INDICATOR_TYPE_BB
                        ? {
                            deviationMultiplier: {
                                units: 2,
                                nano: 0
                            }
                        }
                        : undefined,
                    smoothing: indicatorType === GetTechAnalysisRequest_IndicatorType.INDICATOR_TYPE_MACD
                        ? {
                            fastLength: 12,
                            slowLength: 26,
                            signalSmoothing: 9
                        }
                        : undefined
                });
            }
        );
    }
}
