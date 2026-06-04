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
import InstrumentsService from './instruments.service';

const envVariables = getEnv();
const FAILED_STOP_RETRY_COOLDOWN_MS = 30 * 60 * 1000;
const STOP_DRIFT_RESYNC_PERCENT = 0.5;
const STOP_LIMIT_FALLBACK_BUFFER_PERCENT = 0.5;
const failedStopAttempts = new Map<string, { failedAt: number; reason: string }>();

const roundSellStopPrice = (price: number, minPriceIncrement?: number) => {
    if (!Number.isFinite(minPriceIncrement) || !minPriceIncrement || minPriceIncrement <= 0) return price;

    const rounded = Math.floor(price / minPriceIncrement) * minPriceIncrement;
    return rounded > 0 ? rounded : price;
};

const failedStopKey = (accountId: string, instrumentUid: string) => `${accountId}:${instrumentUid}`;

const isInvalidStopOrderArgument = (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    return message.includes('INVALID_ARGUMENT') && message.includes('30099');
};

const buildStopLimitFallbackPrice = (stopPrice: number, minPriceIncrement?: number) => {
    const fallbackRawPrice = stopPrice * (1 - STOP_LIMIT_FALLBACK_BUFFER_PERCENT / 100);
    const rounded = roundSellStopPrice(fallbackRawPrice, minPriceIncrement);
    if (Number.isFinite(rounded) && rounded > 0 && rounded < stopPrice) return rounded;

    const increment = Number(minPriceIncrement);
    if (Number.isFinite(increment) && increment > 0 && stopPrice > increment) {
        return roundSellStopPrice(stopPrice - increment, increment);
    }

    return fallbackRawPrice > 0 && fallbackRawPrice < stopPrice ? fallbackRawPrice : undefined;
};

export interface ProtectiveStopInput {
    accountId: string;
    figi: string;
    instrumentUid: string;
    ticker?: string;
    quantityLots: number;
    entryPrice: number;
    currentPrice?: number;
    stopLossPercent: number;
}

export default class ProtectiveStopService {
    static getLastFailure(accountId: string, instrumentUid: string) {
        if (!accountId || !instrumentUid) return undefined;

        const failure = failedStopAttempts.get(failedStopKey(accountId, instrumentUid));
        if (!failure) return undefined;

        const cooldownLeftMs = Math.max(0, FAILED_STOP_RETRY_COOLDOWN_MS - (Date.now() - failure.failedAt));
        return {
            failedAt: new Date(failure.failedAt).toISOString(),
            reason: failure.reason,
            cooldownLeftMs
        };
    }

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

        const failureKey = failedStopKey(input.accountId, input.instrumentUid);
        const previousFailure = failedStopAttempts.get(failureKey);
        if (previousFailure && Date.now() - previousFailure.failedAt < FAILED_STOP_RETRY_COOLDOWN_MS) {
            return {
                skipped: true,
                reason: `recent protective stop failure, cooling down: ${previousFailure.reason}`
            };
        }

        const rawStopPrice = entryPrice * (1 - stopLossPercent / 100);
        const shares = await InstrumentsService.getShares();
        const instrument = shares?.instruments?.find(item =>
            item.uid === input.instrumentUid || item.figi === input.figi
        );
        const minPriceIncrement = quotationToNumber(instrument?.minPriceIncrement);
        const stopPrice = roundSellStopPrice(rawStopPrice, minPriceIncrement);

        const activeStops = await this.getActiveSellStops(input.accountId, input.instrumentUid);
        let activeLots = activeStops.reduce((sum, stop) => sum + Math.max(0, Number(stop.lotsRequested ?? 0)), 0);
        let resync: { reason: string; cancelled: number; failed: number } | undefined;
        const driftedStops = activeStops
            .map(stop => {
                const activeStopPrice = quotationToNumber(stop.stopPrice);
                if (!Number.isFinite(activeStopPrice) || !activeStopPrice || activeStopPrice <= 0 || stopPrice <= 0) return undefined;
                const driftPercent = (activeStopPrice / stopPrice - 1) * 100;
                return Math.abs(driftPercent) > STOP_DRIFT_RESYNC_PERCENT
                    ? {
                        activeStopPrice,
                        driftPercent
                    }
                    : undefined;
            })
            .filter((value): value is { activeStopPrice: number; driftPercent: number } => value !== undefined);

        if (activeLots > quantity || driftedStops.length > 0) {
            const cancelResult = await this.cancelActiveSellStopsForInstrument(input.accountId, input.instrumentUid);
            if (cancelResult.failed > 0) {
                throw new Error(`protective stop resync failed: active sell stops cover ${activeLots}/${quantity} lots, cancelled ${cancelResult.cancelled}, failed ${cancelResult.failed}`);
            }
            resync = {
                reason: activeLots > quantity
                    ? `active sell stops over-cover ${activeLots}/${quantity} lots`
                    : `active sell stop price drift ${driftedStops.map(stop => stop.driftPercent.toFixed(2)).join(', ')}% from expected ${stopPrice.toFixed(4)}`,
                cancelled: cancelResult.cancelled,
                failed: cancelResult.failed
            };
            activeLots = 0;
        }

        const uncoveredQuantity = Math.max(0, quantity - activeLots);
        if (uncoveredQuantity <= 0) {
            return {
                skipped: true,
                reason: `active sell stops already cover ${activeLots}/${quantity} lots`
            };
        }

        const currentPrice = Number(input.currentPrice);
        if (
            Number.isFinite(currentPrice)
            && currentPrice > 0
            && currentPrice <= stopPrice + Math.max(0, Number(minPriceIncrement ?? 0))
        ) {
            return {
                skipped: true,
                reason: `current price ${currentPrice.toFixed(4)} is already at or below protective stop ${stopPrice.toFixed(4)}`
            };
        }
        const stopPriceMoney = numberToQuotation(stopPrice);
        const stopPriceQuotation = {
            units: stopPriceMoney.units,
            nano: stopPriceMoney.nano
        };
        const baseDiagnostics = {
            accountId: input.accountId,
            ticker: input.ticker,
            instrumentUid: input.instrumentUid,
            quantity: uncoveredQuantity,
            rawStopPrice,
            stopPrice,
            minPriceIncrement,
            direction: 'sell',
            expirationType: 'good_till_cancel',
            stopOrderType: 'stop_loss',
            exchangeOrderType: 'market',
            priceType: 'currency',
            price: undefined,
            stopPriceQuotation
        };
        const { stopOrders } = getSdk(envVariables.INVEST_TOKEN);
        const postStopOrder = async (params: {
            orderId: string;
            price?: { units: number; nano: number };
            stopPrice: { units: number; nano: number };
            stopOrderType: StopOrderType;
            exchangeOrderType: ExchangeOrderType;
        }) => TInvestApiCacheService.withRetry(() => stopOrders.postStopOrder({
            accountId: input.accountId,
            orderId: params.orderId,
            figi: undefined,
            instrumentId: input.instrumentUid,
            quantity: uncoveredQuantity,
            price: params.price,
            stopPrice: params.stopPrice,
            direction: StopOrderDirection.STOP_ORDER_DIRECTION_SELL,
            expirationType: StopOrderExpirationType.STOP_ORDER_EXPIRATION_TYPE_GOOD_TILL_CANCEL,
            stopOrderType: params.stopOrderType,
            expireDate: undefined,
            exchangeOrderType: params.exchangeOrderType,
            takeProfitType: TakeProfitType.TAKE_PROFIT_TYPE_UNSPECIFIED,
            trailingData: undefined,
            priceType: PriceType.PRICE_TYPE_CURRENCY,
            confirmMarginTrade: false,
            instantExecution: undefined
        }));

        let response;
        let fallback;
        try {
            response = await postStopOrder({
                orderId: randomUUID(),
                price: undefined,
                stopPrice: stopPriceQuotation,
                stopOrderType: StopOrderType.STOP_ORDER_TYPE_STOP_LOSS,
                exchangeOrderType: ExchangeOrderType.EXCHANGE_ORDER_TYPE_MARKET
            });
        } catch (error) {
            if (isInvalidStopOrderArgument(error)) {
                const fallbackPrice = buildStopLimitFallbackPrice(stopPrice, minPriceIncrement);
                if (fallbackPrice) {
                    const fallbackPriceMoney = numberToQuotation(fallbackPrice);
                    const fallbackPriceQuotation = {
                        units: fallbackPriceMoney.units,
                        nano: fallbackPriceMoney.nano
                    };
                    const fallbackDiagnostics = {
                        ...baseDiagnostics,
                        fallbackFrom: 'market-stop-loss',
                        stopOrderType: 'stop_limit',
                        exchangeOrderType: 'limit',
                        price: fallbackPrice,
                        priceQuotation: fallbackPriceQuotation
                    };

                    try {
                        response = await postStopOrder({
                            orderId: randomUUID(),
                            price: fallbackPriceQuotation,
                            stopPrice: stopPriceQuotation,
                            stopOrderType: StopOrderType.STOP_ORDER_TYPE_STOP_LIMIT,
                            exchangeOrderType: ExchangeOrderType.EXCHANGE_ORDER_TYPE_LIMIT
                        });
                        fallback = {
                            used: true,
                            reason: 'market stop-loss rejected with INVALID_ARGUMENT 30099; placed stop-limit fallback',
                            stopPrice,
                            limitPrice: fallbackPrice,
                            bufferPercent: STOP_LIMIT_FALLBACK_BUFFER_PERCENT
                        };
                    } catch (fallbackError) {
                        const reason = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
                        failedStopAttempts.set(failureKey, { failedAt: Date.now(), reason });
                        throw new Error(`protective stop fallback post failed: ${reason}; diagnostics=${JSON.stringify(fallbackDiagnostics)}`);
                    }
                }
            }

            if (!response) {
            const reason = error instanceof Error ? error.message : String(error);
            failedStopAttempts.set(failureKey, { failedAt: Date.now(), reason });
                throw new Error(`protective stop post failed: ${reason}; diagnostics=${JSON.stringify(baseDiagnostics)}`);
            }
        }

        failedStopAttempts.delete(failureKey);

        return {
            skipped: false,
            stopOrderId: response.stopOrderId,
            orderRequestId: response.orderRequestId,
            rawStopPrice,
            minPriceIncrement,
            stopPrice: quotationToNumber(stopPriceQuotation),
            quantity: uncoveredQuantity,
            fallback,
            resync
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
