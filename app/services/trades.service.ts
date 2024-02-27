
// tradeService.ts
import { TradesModel } from '../models/trades.model';

export class TradesService {
    async createTrades() {
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
    async findTradeById(id: number) {
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
}
