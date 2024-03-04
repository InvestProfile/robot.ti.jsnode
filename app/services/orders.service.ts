import {getEnv} from '../config/env.config';
import {createSdk} from 'tinkoff-sdk-grpc-js';

import { v4 as uuidv4 } from 'uuid';

import {OrderDirection, OrderType, TimeInForceType} from "tinkoff-sdk-grpc-js/dist/generated/orders";
import {PriceType} from "tinkoff-sdk-grpc-js/dist/generated/common";

const envVariables = getEnv();

interface Price {
    currency: string;
    units: number;
    nano: number;
}

export default class OrdersService {
    static async postOrder(
        accountId: string,
        direction: number,
        quantity: number | undefined,
        price: Price,
        figi: string,
        instrumentId: string
    ) {
        if (envVariables.INVEST_TOKEN) {
            const {orders} = createSdk(envVariables.INVEST_TOKEN);

            try {
                return await orders.postOrder({
                    accountId,
                    orderId: uuidv4(),
                    timeInForce: TimeInForceType.TIME_IN_FORCE_UNSPECIFIED,
                    direction: direction === 2?OrderDirection.ORDER_DIRECTION_SELL:OrderDirection.ORDER_DIRECTION_BUY,
                    orderType: OrderType.ORDER_TYPE_MARKET,
                    quantity,
                    price,
                    figi,
                    instrumentId,
                    priceType: PriceType.PRICE_TYPE_CURRENCY
                })
            } catch (error: any) {
                // Обрабатываем ошибку, если инструмент недоступен для торгов
                if (error?.message?.includes('instrument is not available for trading')) {
                    console.error('Ошибка: Инструмент недоступен для торгов.', error);
                } else {
                    // Обрабатываем другие типы ошибок
                    console.error('Произошла ошибка при размещении ордера', error);
                }
                // Возвращаем null или выбрасываем ошибку в зависимости от логики приложения
                return null;
            }


        }
    }
}
