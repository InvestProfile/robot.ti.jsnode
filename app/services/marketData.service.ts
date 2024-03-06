
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
}
