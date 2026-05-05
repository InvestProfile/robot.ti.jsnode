
import { getEnv } from '../config/env.config';
// import { createSdk } from 'tinkoff-sdk-grpc-js';
import {getSdk} from './get-sdk';
import { CandleInterval } from 'tinkoff-sdk-grpc-js/dist/generated/marketdata';
import { quotationToNumber } from '../utils/money';

const envVariables = getEnv();

export default class MarketDataService {
    static async getStatus(
        figi: string,
        instrumentId: string
    ) {
        if (envVariables.INVEST_TOKEN) {
            const {marketData} = getSdk(envVariables.INVEST_TOKEN);
            try {
                return await marketData.getTradingStatus({
                    figi,
                    instrumentId
                })
            } catch (error) {
                console.error('Error while getting trading status:', error);
                // Используем утверждение типа для error
                const grpcError = error as { code?: string };
                if (grpcError.code === 'UNAVAILABLE') {
                    // Обработка ошибки отсутствия соединения
                    throw new Error('Сервер недоступен. Пожалуйста, проверьте ваше соединение и попробуйте снова.');
                }
                throw error; // Перебрасываем ошибку для дальнейшей обработки
            }
        } else {
            throw new Error('INVEST_TOKEN is not defined.'); // Выброс исключения, если токен не определен
        }
    }

    static async getHighestDailyCandlePrice(
        instrumentId: string,
        days: number
    ) {
        if (!envVariables.INVEST_TOKEN) {
            throw new Error('INVEST_TOKEN is not defined.');
        }

        const {marketData} = getSdk(envVariables.INVEST_TOKEN);
        const to = new Date();
        const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);

        const response = await marketData.getCandles({
            instrumentId,
            from,
            to,
            interval: CandleInterval.CANDLE_INTERVAL_DAY
        });

        const highs = response.candles
            ?.map(candle => quotationToNumber(candle.high))
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

        const {marketData} = getSdk(envVariables.INVEST_TOKEN);
        const to = new Date();
        const from = new Date(to.getTime() - Math.max(days + 10, days) * 24 * 60 * 60 * 1000);

        const response = await marketData.getCandles({
            instrumentId,
            from,
            to,
            interval: CandleInterval.CANDLE_INTERVAL_DAY
        });

        return response.candles
            ?.map(candle => quotationToNumber(candle.close))
            .filter((value): value is number => value !== undefined && Number.isFinite(value)) ?? [];
    }

    static async getLastPrices(instrumentIds: string[]) {
        if (!envVariables.INVEST_TOKEN) {
            throw new Error('INVEST_TOKEN is not defined.');
        }

        if (instrumentIds.length === 0) return new Map<string, number>();

        const {marketData} = getSdk(envVariables.INVEST_TOKEN);
        const response = await marketData.getLastPrices({
            instrumentId: instrumentIds
        });

        return new Map(
            response.lastPrices
                ?.map(lastPrice => [lastPrice.instrumentUid, quotationToNumber(lastPrice.price)] as const)
                .filter((entry): entry is readonly [string, number] => Boolean(entry[0]) && entry[1] !== undefined && Number.isFinite(entry[1]))
        );
    }
}
