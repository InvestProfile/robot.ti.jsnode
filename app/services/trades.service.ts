
// tradeService.ts
import { TradesModel } from '../models/trades.model';
import { Op } from 'sequelize';

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
        uid: string | undefined,
        instrumentUid: string | undefined,
        accountId: string | undefined,
        ticker: string | undefined,
        name: string | undefined,
        lot: number | undefined
    ) {
        try {
            // Создаём новую запись с полем ticker
            const newTrade = await TradesModel.create({
                figi,
                quantity,
                direction,
                price_units,
                price_nano,
                uid,
                instrumentUid,
                accountId,
                ticker,
                name,
                lot
            });

            console.log("New trade created successfully.", newTrade);
            return newTrade;
        } catch (error) {
            console.error('Unable to create new trade:', error);
            throw error; // Выбрасываем ошибку для дальнейшей обработки
        }
    }

    static async countTodayTrades(accountId: string | undefined) {
        if (!accountId) return 0;

        const startOfDay = new Date();
        startOfDay.setHours(0, 0, 0, 0);

        return await TradesModel.count({
            where: {
                accountId,
                createdAt: {
                    [Op.gte]: startOfDay
                }
            } as any
        });
    }

    static async sumTodayBuyTradesRub(accountId: string | undefined) {
        if (!accountId) return 0;

        const startOfDay = new Date();
        startOfDay.setHours(0, 0, 0, 0);

        const trades = await TradesModel.findAll({
            where: {
                accountId,
                direction: '1',
                createdAt: {
                    [Op.gte]: startOfDay
                }
            } as any
        });

        return trades.reduce((sum, trade) => {
            const data = trade.get({ plain: true }) as Record<string, unknown>;
            const units = Number(data.price_units ?? 0);
            const nano = Number(data.price_nano ?? 0);
            const lot = Number(data.lot ?? data.quantity ?? 1);
            const price = units + nano * 1e-9;

            return Number.isFinite(price) && Number.isFinite(lot) ? sum + price * Math.max(1, lot) : sum;
        }, 0);
    }
}
