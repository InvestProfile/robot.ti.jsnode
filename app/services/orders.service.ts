import {getEnv} from '../config/env.config';
// import {createSdk} from 'tinkoff-sdk-grpc-js';
import {getSdk} from './get-sdk';

import { v4 as uuidv4 } from 'uuid';

import {OrderDirection, OrderIdType, OrderType, TimeInForceType} from "tinkoff-sdk-grpc-js/dist/generated/orders";
import {PriceType} from "tinkoff-sdk-grpc-js/dist/generated/common";
import TInvestApiCacheService from './tinvest-api-cache.service';

const envVariables = getEnv();

interface Price {
    currency: string;
    units: number;
    nano: number;
}

const normalizeDirection = (direction: number) => {
    if (direction === OrderDirection.ORDER_DIRECTION_BUY || direction === 1) {
        return OrderDirection.ORDER_DIRECTION_BUY;
    }

    if (direction === OrderDirection.ORDER_DIRECTION_SELL || direction === 2) {
        return OrderDirection.ORDER_DIRECTION_SELL;
    }

    throw new Error(`Unsupported order direction: ${direction}`);
};

const validateOrderInput = (input: {
    accountId: string;
    direction: number;
    quantity: number | undefined;
    price: Price;
    figi: string;
    instrumentId: string;
}) => {
    if (!envVariables.INVEST_TOKEN) throw new Error('INVEST_TOKEN is not defined.');
    if (!input.accountId) throw new Error('accountId is required for order placement');
    if (!input.figi) throw new Error('figi is required for order placement');
    if (!input.instrumentId) throw new Error('instrumentId is required for order placement');

    normalizeDirection(input.direction);

    const quantity = Number(input.quantity);
    if (!Number.isInteger(quantity) || quantity <= 0) {
        throw new Error(`Order quantity must be a positive integer, got ${input.quantity}`);
    }

    const price = Number(input.price?.units ?? 0) + Number(input.price?.nano ?? 0) * 1e-9;
    if (!Number.isFinite(price) || price <= 0) {
        throw new Error('Order price must be positive');
    }
};

export default class OrdersService {
    static createClientOrderId() {
        return uuidv4();
    }

    static async postOrder(
        accountId: string,
        direction: number,
        quantity: number | undefined,
        price: Price,
        figi: string,
        instrumentId: string,
        clientOrderId = OrdersService.createClientOrderId()
    ) {
        validateOrderInput({ accountId, direction, quantity, price, figi, instrumentId });

        const token = envVariables.INVEST_TOKEN;
        if (!token) throw new Error('INVEST_TOKEN is not defined.');

        const {orders} = getSdk(token);
        const orderDirection = normalizeDirection(direction);

        const response = await TInvestApiCacheService.withRetry(() => orders.postOrder({
            accountId,
            orderId: clientOrderId,
            timeInForce: TimeInForceType.TIME_IN_FORCE_UNSPECIFIED,
            direction: orderDirection,
            orderType: OrderType.ORDER_TYPE_MARKET,
            quantity,
            price,
            figi,
            instrumentId,
            priceType: PriceType.PRICE_TYPE_CURRENCY,
            confirmMarginTrade: false
        }));

        return {
            ...response,
            clientOrderId
        };
    }

    static async getOrderState(accountId: string, orderId: string, orderIdType?: OrderIdType) {
        if (envVariables.INVEST_TOKEN) {
            const {orders} = getSdk(envVariables.INVEST_TOKEN);
            return await TInvestApiCacheService.withRetry(() => orders.getOrderState({
                accountId,
                orderId,
                priceType: PriceType.PRICE_TYPE_CURRENCY,
                orderIdType
            }));
        }
    }

    static async getMaxLots(accountId: string, instrumentId: string, price?: Price) {
        if (envVariables.INVEST_TOKEN) {
            const {orders} = getSdk(envVariables.INVEST_TOKEN);
            return await TInvestApiCacheService.cached(
                `orders:max-lots:${accountId}:${instrumentId}:${price?.units ?? ''}:${price?.nano ?? ''}`,
                10_000,
                () => orders.getMaxLots({
                    accountId,
                    instrumentId,
                    price
                })
            );
        }
    }

    static async getOrderPrice(
        accountId: string,
        direction: number,
        quantity: number,
        price: Price,
        instrumentId: string
    ) {
        if (envVariables.INVEST_TOKEN) {
            const {orders} = getSdk(envVariables.INVEST_TOKEN);
            return await TInvestApiCacheService.cached(
                `orders:price:${accountId}:${direction}:${quantity}:${instrumentId}:${price.units}:${price.nano}`,
                10_000,
                () => orders.getOrderPrice({
                    accountId,
                    instrumentId,
                    price,
                    direction: direction === 2 ? OrderDirection.ORDER_DIRECTION_SELL : OrderDirection.ORDER_DIRECTION_BUY,
                    quantity
                })
            );
        }
    }
}
