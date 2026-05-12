
// tradeService.ts
import { TradesModel } from '../models/trades.model';
import { Op } from 'sequelize';
import {
    isFinalOrderStatus,
    LOCAL_PENDING_ORDER_STATUS,
    LOCAL_UNKNOWN_ORDER_STATUS
} from '../utils/order-status';

export interface TradeOrderMetadata {
    orderId?: string;
    clientOrderId?: string;
    orderType?: string;
    status?: string;
    tradeDateTime?: string;
    instrumentId?: string;
    lotsRequested?: number;
    lotsExecuted?: number;
    executedPriceUnits?: string | number;
    executedPriceNano?: string | number;
    totalAmountUnits?: string | number;
    totalAmountNano?: string | number;
    orderError?: string;
}

export default class TradesService {
    private static moneyFromParts(units: unknown, nano: unknown) {
        const parsedUnits = Number(units ?? 0);
        const parsedNano = Number(nano ?? 0);
        const amount = parsedUnits + parsedNano * 1e-9;

        return Number.isFinite(amount) && amount > 0 ? amount : undefined;
    }

    static amountFromTrade(data: Record<string, unknown>) {
        const totalAmount = this.moneyFromParts(data.totalAmountUnits, data.totalAmountNano);
        if (totalAmount !== undefined) return totalAmount;

        const executedPrice = this.moneyFromParts(data.executedPriceUnits, data.executedPriceNano)
            ?? this.moneyFromParts(data.price_units, data.price_nano);
        const lots = Number(data.lotsExecuted ?? data.lotsRequested ?? data.quantity ?? 1);
        const lotSize = Number(data.lot ?? 1);

        if (executedPrice === undefined || !Number.isFinite(lots) || !Number.isFinite(lotSize)) return undefined;

        return executedPrice * Math.max(1, lots) * Math.max(1, lotSize);
    }

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
        lot: number | undefined,
        metadata: TradeOrderMetadata = {}
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
                lot,
                orderId: metadata.orderId,
                clientOrderId: metadata.clientOrderId,
                orderType: metadata.orderType,
                status: metadata.status,
                tradeDateTime: metadata.tradeDateTime,
                instrumentId: metadata.instrumentId ?? instrumentUid,
                lotsRequested: metadata.lotsRequested,
                lotsExecuted: metadata.lotsExecuted,
                executedPriceUnits: metadata.executedPriceUnits,
                executedPriceNano: metadata.executedPriceNano,
                totalAmountUnits: metadata.totalAmountUnits,
                totalAmountNano: metadata.totalAmountNano,
                orderError: metadata.orderError
            });

            console.log("New trade created successfully.", newTrade);
            return newTrade;
        } catch (error) {
            console.error('Unable to create new trade:', error);
            throw error; // Выбрасываем ошибку для дальнейшей обработки
        }
    }

    static async createPendingOrder(input: {
        figi?: string;
        quantity?: string;
        direction: string;
        priceUnits?: number;
        priceNano?: number;
        uid?: string;
        instrumentUid?: string;
        accountId?: string;
        ticker?: string;
        name?: string;
        lot?: number;
        clientOrderId: string;
        lotsRequested?: number;
    }) {
        return await this.createTrade(
            input.figi,
            input.quantity,
            input.direction,
            input.priceUnits,
            input.priceNano,
            input.uid,
            input.instrumentUid,
            input.accountId,
            input.ticker,
            input.name,
            input.lot,
            {
                orderId: input.clientOrderId,
                clientOrderId: input.clientOrderId,
                status: LOCAL_PENDING_ORDER_STATUS,
                tradeDateTime: new Date().toISOString(),
                instrumentId: input.instrumentUid,
                lotsRequested: input.lotsRequested
            }
        );
    }

    static async updateOrderMetadata(trade: TradesModel, metadata: TradeOrderMetadata) {
        await trade.update({
            orderId: metadata.orderId ?? metadata.clientOrderId ?? trade.orderId,
            clientOrderId: metadata.clientOrderId ?? trade.clientOrderId,
            orderType: metadata.orderType ?? trade.orderType,
            status: metadata.status ?? trade.status,
            tradeDateTime: metadata.tradeDateTime ?? trade.tradeDateTime,
            instrumentId: metadata.instrumentId ?? trade.instrumentId,
            lotsRequested: metadata.lotsRequested ?? trade.lotsRequested,
            lotsExecuted: metadata.lotsExecuted ?? trade.lotsExecuted,
            executedPriceUnits: metadata.executedPriceUnits ?? trade.executedPriceUnits,
            executedPriceNano: metadata.executedPriceNano ?? trade.executedPriceNano,
            totalAmountUnits: metadata.totalAmountUnits ?? trade.totalAmountUnits,
            totalAmountNano: metadata.totalAmountNano ?? trade.totalAmountNano,
            orderError: metadata.orderError ?? null
        });

        return trade;
    }

    static async markOrderUnknown(trade: TradesModel, error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        await trade.update({
            status: LOCAL_UNKNOWN_ORDER_STATUS,
            orderError: message
        });

        return trade;
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
            const amount = this.amountFromTrade(data);

            return amount !== undefined ? sum + amount : sum;
        }, 0);
    }

    static async hasOpenOrderForInstrument(
        accountId: string | undefined,
        figi: string | undefined,
        instrumentUid: string | undefined,
        direction?: string
    ) {
        if (!accountId || (!figi && !instrumentUid)) return false;

        const trades = await TradesModel.findAll({
            where: {
                accountId,
                ...(direction ? { direction } : {})
            } as any,
            order: [['createdAt', 'DESC']],
            limit: 100
        });

        return trades.some(trade => {
            const data = trade.get({ plain: true }) as Record<string, unknown>;
            const sameInstrument = Boolean(
                (instrumentUid && (data.instrumentUid === instrumentUid || data.instrumentId === instrumentUid || data.uid === instrumentUid))
                || (figi && data.figi === figi)
            );
            const orderId = data.orderId ? String(data.orderId) : undefined;
            const clientOrderId = data.clientOrderId ? String(data.clientOrderId) : undefined;
            const status = data.status ? String(data.status) : undefined;

            return sameInstrument && Boolean(orderId || clientOrderId) && !isFinalOrderStatus(status);
        });
    }
}
