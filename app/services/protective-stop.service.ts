import {
    ExchangeOrderType,
    StopOrderDirection,
    StopOrderExpirationType,
    StopOrderStatusOption,
    StopOrderType,
    TakeProfitType
} from 'tinkoff-sdk-grpc-js/dist/generated/stoporders';
import { PriceType } from 'tinkoff-sdk-grpc-js/dist/generated/common';
import { randomUUID } from 'crypto';
import { getEnv } from '../config/env.config';
import { getSdk } from './get-sdk';
import TInvestApiCacheService from './tinvest-api-cache.service';
import { numberToQuotation, quotationToNumber } from '../utils/money';

const envVariables = getEnv();

export interface ProtectiveStopInput {
    accountId: string;
    figi: string;
    instrumentUid: string;
    ticker?: string;
    quantityLots: number;
    entryPrice: number;
    stopLossPercent: number;
}

export default class ProtectiveStopService {
    static async getActiveStops(accountId: string) {
        if (!envVariables.INVEST_TOKEN) throw new Error('INVEST_TOKEN is not defined.');
        if (!accountId) throw new Error('accountId is required for stop order lookup');

        const { stopOrders } = getSdk(envVariables.INVEST_TOKEN);
        const response = await TInvestApiCacheService.withRetry(() => stopOrders.getStopOrders({
            accountId,
            status: StopOrderStatusOption.STOP_ORDER_STATUS_ACTIVE,
            from: undefined,
            to: undefined
        }));

        return response.stopOrders || [];
    }

    static async getActiveSellStops(accountId: string, instrumentUid: string) {
        const stops = await this.getActiveStops(accountId);
        return stops.filter(stop =>
            stop.instrumentUid === instrumentUid
            && stop.direction === StopOrderDirection.STOP_ORDER_DIRECTION_SELL
            && (
                stop.orderType === StopOrderType.STOP_ORDER_TYPE_STOP_LOSS
                || stop.orderType === StopOrderType.STOP_ORDER_TYPE_STOP_LIMIT
            )
        );
    }

    static async getActiveSellStopLots(accountId: string, instrumentUid: string) {
        const stops = await this.getActiveSellStops(accountId, instrumentUid);
        return stops.reduce((sum, stop) => sum + Math.max(0, Number(stop.lotsRequested ?? 0)), 0);
    }

    static async placeStopLoss(input: ProtectiveStopInput) {
        if (!envVariables.INVEST_TOKEN) throw new Error('INVEST_TOKEN is not defined.');

        const quantity = Math.trunc(Number(input.quantityLots));
        const entryPrice = Number(input.entryPrice);
        const stopLossPercent = Number(input.stopLossPercent);
        if (!input.accountId) throw new Error('accountId is required for protective stop');
        if (!input.figi) throw new Error('figi is required for protective stop');
        if (!input.instrumentUid) throw new Error('instrumentUid is required for protective stop');
        if (!Number.isInteger(quantity) || quantity <= 0) throw new Error(`protective stop quantity must be positive integer, got ${input.quantityLots}`);
        if (!Number.isFinite(entryPrice) || entryPrice <= 0) throw new Error(`protective stop entry price must be positive, got ${input.entryPrice}`);
        if (!Number.isFinite(stopLossPercent) || stopLossPercent <= 0) throw new Error(`protective stop percent must be positive, got ${input.stopLossPercent}`);

        const activeLots = await this.getActiveSellStopLots(input.accountId, input.instrumentUid);
        const uncoveredQuantity = Math.max(0, quantity - activeLots);
        if (uncoveredQuantity <= 0) {
            return {
                skipped: true,
                reason: `active sell stops already cover ${activeLots}/${quantity} lots`
            };
        }

        const stopPrice = entryPrice * (1 - stopLossPercent / 100);
        const stopPriceMoney = numberToQuotation(stopPrice);
        const stopPriceQuotation = {
            units: stopPriceMoney.units,
            nano: stopPriceMoney.nano
        };
        const { stopOrders } = getSdk(envVariables.INVEST_TOKEN);
        const response = await TInvestApiCacheService.withRetry(() => stopOrders.postStopOrder({
            accountId: input.accountId,
            orderId: randomUUID(),
            figi: input.figi,
            instrumentId: input.instrumentUid,
            quantity: uncoveredQuantity,
            price: stopPriceQuotation,
            stopPrice: stopPriceQuotation,
            direction: StopOrderDirection.STOP_ORDER_DIRECTION_SELL,
            expirationType: StopOrderExpirationType.STOP_ORDER_EXPIRATION_TYPE_GOOD_TILL_CANCEL,
            stopOrderType: StopOrderType.STOP_ORDER_TYPE_STOP_LOSS,
            expireDate: undefined,
            exchangeOrderType: ExchangeOrderType.EXCHANGE_ORDER_TYPE_MARKET,
            takeProfitType: TakeProfitType.TAKE_PROFIT_TYPE_UNSPECIFIED,
            trailingData: undefined,
            priceType: PriceType.PRICE_TYPE_CURRENCY,
            confirmMarginTrade: false,
            instantExecution: false
        }));

        return {
            skipped: false,
            stopOrderId: response.stopOrderId,
            orderRequestId: response.orderRequestId,
            stopPrice: quotationToNumber(stopPriceQuotation),
            quantity: uncoveredQuantity
        };
    }

    static async cancelActiveSellStopsForInstrument(accountId: string, instrumentUid: string) {
        if (!envVariables.INVEST_TOKEN) throw new Error('INVEST_TOKEN is not defined.');
        if (!accountId || !instrumentUid) return { cancelled: 0, failed: 0, errors: [] as string[] };

        const stops = await this.getActiveSellStops(accountId, instrumentUid);
        const { stopOrders } = getSdk(envVariables.INVEST_TOKEN);
        let cancelled = 0;
        const errors: string[] = [];

        for (const stop of stops) {
            try {
                await TInvestApiCacheService.withRetry(() => stopOrders.cancelStopOrder({
                    accountId,
                    stopOrderId: stop.stopOrderId
                }));
                cancelled += 1;
            } catch (error) {
                errors.push(error instanceof Error ? error.message : String(error));
            }
        }

        return {
            cancelled,
            failed: errors.length,
            errors
        };
    }
}
