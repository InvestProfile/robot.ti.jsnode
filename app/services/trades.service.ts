
// tradeService.ts
import { TradesModel } from '../models/trades.model';

export default class TradesService {
    static async createTrades() {
        try {
            await TradesModel.sync();
            // Здесь можно добавить создание записи, если это необходимо
            // const newTrade = await TradesModel.create({
            //   // ... данные для создания новой записи
            // });
            // console.log(newTrade); // Вывод данных новой записи
            console.log("Trade created successfully.");
        } catch (error) {
            console.error('Unable to create trade:', error);
        }
    }
    static async findTradeById(id: number) {
        try {
            const trade = await TradesModel.findByPk(id);
            if (trade) {
                console.log('Trade found:', trade);
                return trade; // Возвращаем найденную запись
            } else {
                console.log('Trade not found.');
                return null; // Возвращаем null, если запись не найдена
            }
        } catch (error) {
            console.error('Error finding trade:', error);
            throw error; // Перебрасываем ошибку дальше
        }
    }
    static async createTrade(
        figi: string | undefined,
        quantity: string | undefined,
        direction: string | undefined,
        price_units: number | undefined,
        price_nano: number | undefined,
        instrumentUid: string | undefined,
        accountId: string | undefined,
        ticker: string | undefined,
        name: string | undefined
    ) {
        try {
            // Создаём новую запись с полем ticker
            const newTrade = await TradesModel.create({
                figi,
                quantity,
                direction,
                price_units,
                price_nano,
                instrumentUid,
                accountId,
                ticker,
                name
            });

            console.log("New trade created successfully.", newTrade);
            return newTrade;
        } catch (error) {
            console.error('Unable to create new trade:', error);
            throw error; // Выбрасываем ошибку для дальнейшей обработки
        }
    }
}
