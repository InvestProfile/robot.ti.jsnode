
import { getEnv } from '../config/env.config';
import { createSdk } from 'tinkoff-sdk-grpc-js';

const envVariables = getEnv();

export default class MarketDataService {
    static async getStatus(
        figi: string,
        instrumentId: string
    ) {
        if (envVariables.INVEST_TOKEN) {
            const {marketData} = createSdk(envVariables.INVEST_TOKEN);
            try {
                return await marketData.getTradingStatus({
                    figi,
                    instrumentId
                })
            } catch (error) {
                console.error('Error while getting trading status:', error);
                throw error; // Перебрасываем ошибку для дальнейшей обработки
            }
        } else {
            throw new Error('INVEST_TOKEN is not defined.'); // Выброс исключения, если токен не определен
        }
    }
}
