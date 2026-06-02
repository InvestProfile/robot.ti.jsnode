import { getRobotConfig, RobotConfig } from '../config/robot.config';
import { RobotExecutableOrderType } from '../config/robot.config';
import InstrumentsService from '../services/instruments.service';
import BuySignalEvaluatorService from '../services/buy-signal-evaluator.service';
import marketData from '../services/marketData.service';
import operationService from '../services/operations.service';
import orderService from '../services/orders.service';
import { ORDER_SIDE, OrderSide } from '../services/orders.service';
import RiskManagerService from '../services/risk-manager.service';
import TradeJournalService from '../services/trade-journal.service';
import TradesService from '../services/trades.service';
import OrderReconciliationService from '../services/order-reconciliation.service';
import PortfolioSnapshotService from '../services/portfolio-snapshot.service';
import BuySignalJournalService from '../services/buy-signal-journal.service';
import PaperTradingService from '../services/paper-trading.service';
import RuntimeConfigService from '../services/runtime-config.service';
import SellPolicyService from '../services/sell-policy.service';
import PositionStateService from '../services/position-state.service';
import ProtectiveStopService from '../services/protective-stop.service';
import RobotPositionLedgerService from '../services/robot-position-ledger.service';
import StrategyEngine from '../strategies/strategy-engine';
import StopLossStrategy from '../strategies/stop-loss.strategy';
import { numberToQuotation, quotationToNumber } from '../utils/money';
import { normalizeOrderStatus, normalizeOrderType } from '../utils/order-status';
import { isRejectedOrderStatus } from '../utils/order-status';

const delay = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds));

type SharesResponse = Awaited<ReturnType<typeof InstrumentsService.getShares>>;
type ShareInstrument = NonNullable<NonNullable<SharesResponse>['instruments']>[number];
type AccountMode = 'trade' | 'observe';

let isTickRunning = false;
let lastTickStartedAt: string | undefined;
let lastTickFinishedAt: string | undefined;
let lastTickError: string | undefined;
let consecutiveTickErrors = 0;
let circuitBreakerOpen = false;
let circuitBreakerReason: string | undefined;
let isBuySignalJournalRunning = false;
let isPaperTradingRunning = false;
let protectiveStopLastSyncStartedAt: string | undefined;
let protectiveStopLastSyncFinishedAt: string | undefined;
let protectiveStopLastResyncAt: string | undefined;
let protectiveStopLastResyncReason: string | undefined;
let protectiveStopLastError: string | undefined;
let protectiveStopLastChecked = 0;
let protectiveStopLastResynced = 0;

export interface TradingProcess {
    stop: () => void;
}

export const getTradingRuntimeState = () => ({
    isTickRunning,
    lastTickStartedAt,
    lastTickFinishedAt,
    lastTickError,
    consecutiveTickErrors,
    circuitBreakerOpen,
    circuitBreakerReason,
    protectiveStops: {
        lastSyncStartedAt: protectiveStopLastSyncStartedAt,
        lastSyncFinishedAt: protectiveStopLastSyncFinishedAt,
        lastResyncAt: protectiveStopLastResyncAt,
        lastResyncReason: protectiveStopLastResyncReason,
        lastError: protectiveStopLastError,
        checked: protectiveStopLastChecked,
        resynced: protectiveStopLastResynced
    }
});

const findInstrument = (
    instruments: ShareInstrument[],
    figi: string | undefined,
    instrumentUid: string | undefined
) => {
    return instruments.find(instrument => instrument?.figi === figi && instrument?.uid === instrumentUid)
        ?? instruments.find(instrument => instrument?.figi === figi);
};

const getOrderMetadata = (orderResult: unknown) => {
    const data = (orderResult ?? {}) as Record<string, unknown>;
    const getString = (...keys: string[]) => {
        const value = keys.map(key => data[key]).find(item => item !== undefined && item !== null);
        return value === undefined || value === null ? undefined : String(value);
    };
    const moneyParts = (value: unknown) => {
        const money = value as Record<string, unknown> | undefined;
        return {
            units: money?.units,
            nano: money?.nano
        };
    };
    const executedPrice = moneyParts(data.executedOrderPrice);
    const totalAmount = moneyParts(data.totalOrderAmount);

    return {
        orderId: getString('orderId', 'clientOrderId'),
        clientOrderId: getString('clientOrderId'),
        orderType: normalizeOrderType(data.orderType),
        status: normalizeOrderStatus(data.executionReportStatus ?? data.status),
        tradeDateTime: getString('tradeDateTime', 'createdAt'),
        lotsRequested: typeof data.lotsRequested === 'number' ? data.lotsRequested : undefined,
        lotsExecuted: typeof data.lotsExecuted === 'number' ? data.lotsExecuted : undefined,
        executedPriceUnits: executedPrice.units as string | number | undefined,
        executedPriceNano: executedPrice.nano as string | number | undefined,
        totalAmountUnits: totalAmount.units as string | number | undefined,
        totalAmountNano: totalAmount.nano as string | number | undefined
    };
};

const getErrorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);

const isPostOrderRejectedError = (error: unknown) => {
    const message = getErrorMessage(error);
    return message.includes('INVALID_ARGUMENT')
        || message.includes('FAILED_PRECONDITION')
        || message.includes('PERMISSION_DENIED')
        || message.includes('UNAUTHENTICATED');
};

const moneyPartsToNumber = (units: unknown, nano: unknown) => {
    const parsedUnits = Number(units ?? 0);
    const parsedNano = Number(nano ?? 0);
    const value = parsedUnits + parsedNano * 1e-9;

    return Number.isFinite(value) && value > 0 ? value : undefined;
};

type SmartOrderBookMetrics = {
    spreadPercent?: number;
    askLiquidityRub?: number;
};

const orderTypeLabel = (orderType: RobotExecutableOrderType) =>
    orderType === 'limit' ? 'ORDER_TYPE_LIMIT' : 'ORDER_TYPE_MARKET';

const resolveOrderType = async (input: {
    config: RobotConfig;
    side: OrderSide;
    instrumentUid: string;
    ticker?: string;
    lot?: number;
    estimatedOrderRub?: number;
    score?: number;
    orderBookMetrics?: SmartOrderBookMetrics;
}): Promise<{ orderType: RobotExecutableOrderType; reason: string }> => {
    const configured = input.side === ORDER_SIDE.BUY ? input.config.buyOrderType : input.config.sellOrderType;
    if (configured !== 'smart') {
        return { orderType: configured, reason: `${input.side} order type configured as ${configured}` };
    }

    if (input.side !== ORDER_SIDE.BUY) {
        return { orderType: 'market', reason: 'smart sell falls back to market for exit reliability' };
    }

    try {
        const orderBook = input.orderBookMetrics
            ?? await marketData.getOrderBookMetrics(
                input.instrumentUid,
                Math.max(1, input.lot ?? 1),
                10,
                input.config.orderbookCacheTtlMs
            );
        const score = Number(input.score ?? 0);
        const spreadPercent = orderBook?.spreadPercent;
        const askLiquidityRub = orderBook?.askLiquidityRub;
        const estimatedOrderRub = Number(input.estimatedOrderRub ?? 0);
        const maxMarketSpreadPercent = Math.min(0.15, Math.max(0.03, input.config.maxSpreadPercent / 2));
        const minMarketAskRub = Math.max(input.config.minOrderbookAskRub, estimatedOrderRub * 30);

        if (
            score >= 85
            && spreadPercent !== undefined
            && spreadPercent <= maxMarketSpreadPercent
            && askLiquidityRub !== undefined
            && askLiquidityRub >= minMarketAskRub
        ) {
            return {
                orderType: 'market',
                reason: `smart-buy market: score ${score}, spread ${spreadPercent.toFixed(2)}%, ask liquidity ${Math.round(askLiquidityRub)} RUB`
            };
        }

        return {
            orderType: 'limit',
            reason: `smart-buy limit: score ${score}, spread ${spreadPercent === undefined ? '-' : spreadPercent.toFixed(2) + '%'}, ask liquidity ${askLiquidityRub === undefined ? '-' : Math.round(askLiquidityRub) + ' RUB'}`
        };
    } catch (error) {
        return {
            orderType: 'limit',
            reason: `smart-buy limit: orderbook unavailable (${getErrorMessage(error)})`
        };
    }
};

const validateLiveOrderAllowed = (config: RobotConfig, side: OrderSide) => {
    const pauseReason = getLiveTradingPauseReason(config);
    if (config.dryRun) throw new Error('live order blocked: dry-run mode is enabled');
    if (pauseReason) throw new Error(`live order blocked: ${pauseReason}`);
    if (!config.liveAllowedActions.includes(side)) {
        throw new Error(`live order blocked: ${side} is disabled by ROBOT_LIVE_ALLOWED_ACTIONS`);
    }
};

const getSubmittedDecisionStatus = (orderSubmission: { pendingTrade?: { getDataValue?: (key: string) => unknown } }) => {
    const brokerStatus = orderSubmission.pendingTrade?.getDataValue?.('status');
    return isRejectedOrderStatus(brokerStatus ? String(brokerStatus) : undefined) ? 'order-rejected' : 'order-posted';
};

const getSubmittedDecisionReason = (
    baseReason: string,
    orderSubmission: {
        pendingTrade?: { getDataValue?: (key: string) => unknown };
        reconciled?: boolean;
        error?: unknown;
    }
) => {
    if (orderSubmission.reconciled) return `${baseReason}; order reconciled after postOrder error`;
    if (orderSubmission.error && getSubmittedDecisionStatus(orderSubmission) === 'order-rejected') {
        return `${baseReason}; order rejected by broker/API: ${getErrorMessage(orderSubmission.error)}`;
    }
    return baseReason;
};

const placeProtectiveStopForBuy = async (input: {
    config: RobotConfig;
    accountId: string;
    figi: string;
    instrumentUid: string;
    ticker?: string;
    name?: string;
    quantityLots: number;
    entryPrice: number;
    currentPrice?: number;
}) => {
    if (!input.config.protectiveStopsEnabled) return;

    try {
        const stopPlan = await StopLossStrategy.calculateEffectiveStop({
            accountId: input.accountId,
            ticker: input.ticker,
            instrumentUid: input.instrumentUid
        }, input.config);

        const result = await ProtectiveStopService.placeStopLoss({
            accountId: input.accountId,
            figi: input.figi,
            instrumentUid: input.instrumentUid,
            ticker: input.ticker,
            quantityLots: input.quantityLots,
            entryPrice: input.entryPrice,
            currentPrice: input.currentPrice,
            stopLossPercent: stopPlan.effectiveStopPercent
        });

        console.log('Protective stop checked:', {
            accountId: input.accountId,
            ticker: input.ticker,
            name: input.name,
            stopPlan,
            result
        });

        return result;
    } catch (error) {
        console.error('Protective stop placement failed:', {
            accountId: input.accountId,
            ticker: input.ticker,
            name: input.name,
            error: getErrorMessage(error)
        });
        throw error;
    }
};

const cancelProtectiveStopsAfterSell = async (input: {
    config: RobotConfig;
    accountId: string;
    instrumentUid: string;
    ticker?: string;
}) => {
    if (!input.config.protectiveStopsEnabled) return;

    try {
        const result = await ProtectiveStopService.cancelActiveSellStopsForInstrument(
            input.accountId,
            input.instrumentUid
        );

        if (result.cancelled > 0 || result.failed > 0) {
            console.log('Protective sell stops cancelled after robot sell:', {
                accountId: input.accountId,
                ticker: input.ticker,
                result
            });
        }
    } catch (error) {
        console.error('Protective stop cancellation failed:', {
            accountId: input.accountId,
            ticker: input.ticker,
            error: getErrorMessage(error)
        });
    }
};

export const ensureProtectiveStopsForOpenRobotPositions = async (config: RobotConfig, reason = 'automatic') => {
    if (!config.protectiveStopsEnabled || config.dryRun || !config.liveAllowedActions.includes('sell')) return {
        checked: 0,
        resynced: 0,
        skipped: true,
        reason: 'protective stops disabled, dry-run, or live sell disabled'
    };

    protectiveStopLastSyncStartedAt = new Date().toISOString();
    protectiveStopLastError = undefined;
    let checked = 0;
    let resynced = 0;

    try {
        const ledger = await RobotPositionLedgerService.getLedger(config);
        const openItems = (ledger.items || []).filter(item =>
            Number(item.lots ?? 0) > 0
            && Number(item.averagePrice ?? 0) > 0
            && item.accountId
            && item.figi
            && item.instrumentUid
        );

        for (const item of openItems) {
            checked += 1;
            const result = await placeProtectiveStopForBuy({
                config,
                accountId: String(item.accountId),
                figi: String(item.figi),
                instrumentUid: String(item.instrumentUid),
                ticker: item.ticker ? String(item.ticker) : undefined,
                name: item.name ? String(item.name) : undefined,
                quantityLots: Number(item.lots),
                entryPrice: Number(item.averagePrice),
                currentPrice: Number(item.currentPrice)
            });
            const cancelledStops = Number(result?.resync?.cancelled ?? 0);
            if (cancelledStops > 0) {
                resynced += 1;
                protectiveStopLastResyncAt = new Date().toISOString();
                protectiveStopLastResyncReason = `${reason}: ${String(item.ticker || item.figi || item.instrumentUid)} ${String(result?.resync?.reason || '')}`;
            }
        }

        protectiveStopLastChecked = checked;
        protectiveStopLastResynced = resynced;
        protectiveStopLastSyncFinishedAt = new Date().toISOString();

        return {
            checked,
            resynced,
            skipped: false,
            reason
        };
    } catch (error) {
        protectiveStopLastError = getErrorMessage(error);
        protectiveStopLastSyncFinishedAt = new Date().toISOString();
        console.error('Protective stop sync failed:', getErrorMessage(error));

        return {
            checked,
            resynced,
            skipped: false,
            reason,
            error: getErrorMessage(error)
        };
    }
};

const submitTrackedOrder = async (input: {
    config: RobotConfig;
    accountId: string;
    side: OrderSide;
    quantityLots: number;
    price: { units: number; nano: number; currency?: string };
    figi: string;
    instrumentUid: string;
    ticker?: string;
    name?: string;
    lot?: number;
    estimatedOrderRub?: number;
    score?: number;
    orderBookMetrics?: SmartOrderBookMetrics;
}) => {
    const clientOrderId = orderService.createClientOrderId();
    const executionPolicy = await resolveOrderType(input);
    const orderType = executionPolicy.orderType;
    try {
        validateLiveOrderAllowed(input.config, input.side);
    } catch (error) {
        return {
            orderResult: undefined,
            pendingTrade: undefined,
            clientOrderId,
            unknown: false,
            failedBeforeSubmit: true,
            error
        };
    }

    const direction = input.side === ORDER_SIDE.SELL ? '2' : '1';
    const pendingTrade = await TradesService.createPendingOrder({
        figi: input.figi,
        quantity: '1',
        direction,
        priceUnits: input.price.units,
        priceNano: input.price.nano,
        uid: input.instrumentUid,
        instrumentUid: input.instrumentUid,
        accountId: input.accountId,
        ticker: input.ticker,
        name: input.name,
        lot: input.quantityLots,
        clientOrderId,
        lotsRequested: input.quantityLots,
        orderType: orderTypeLabel(orderType)
    });

    try {
        const orderResult = await orderService.postOrder(
            input.accountId,
            input.side,
            input.quantityLots,
            {
                currency: input.price.currency ?? 'rub',
                units: input.price.units,
                nano: input.price.nano
            },
            input.figi,
            input.instrumentUid,
            orderType,
            clientOrderId
        );

        const metadata = getOrderMetadata(orderResult);

        await TradesService.updateOrderMetadata(pendingTrade, {
            ...metadata,
            clientOrderId,
            instrumentId: input.instrumentUid
        });

        if (input.side === ORDER_SIDE.BUY && !isRejectedOrderStatus(metadata.status)) {
            const executedLots = Number(metadata.lotsExecuted ?? 0);
            const entryPrice = moneyPartsToNumber(metadata.executedPriceUnits, metadata.executedPriceNano)
                ?? moneyPartsToNumber(input.price.units, input.price.nano);

            await PositionStateService.resetHighWaterMark({
                accountId: input.accountId,
                figi: input.figi,
                instrumentUid: input.instrumentUid,
                ticker: input.ticker,
                name: input.name,
                currentPrice: entryPrice ?? 0
            });

            if (executedLots > 0 && entryPrice) {
                await placeProtectiveStopForBuy({
                    config: input.config,
                    accountId: input.accountId,
                    figi: input.figi,
                    instrumentUid: input.instrumentUid,
                    ticker: input.ticker,
                    name: input.name,
                    quantityLots: executedLots,
                    entryPrice
                });
            }
        }

        if (input.side === ORDER_SIDE.SELL && !isRejectedOrderStatus(metadata.status)) {
            await cancelProtectiveStopsAfterSell({
                config: input.config,
                accountId: input.accountId,
                instrumentUid: input.instrumentUid,
                ticker: input.ticker
            });
        }

        return {
            orderResult,
            pendingTrade,
            clientOrderId,
            unknown: false,
            executionPolicy
        };
    } catch (error) {
        if (isPostOrderRejectedError(error)) {
            await TradesService.markOrderRejected(pendingTrade, error);
            return {
                orderResult: undefined,
                pendingTrade,
                clientOrderId,
                unknown: false,
                failedBeforeSubmit: false,
                rejected: true,
                error
            };
        }

        try {
            const reconciled = await OrderReconciliationService.reconcileTrade(pendingTrade);
            if (reconciled) {
                return {
                    orderResult: undefined,
                    pendingTrade,
                    clientOrderId,
                    unknown: false,
                    reconciled: true
                };
            }
        } catch (reconcileError) {
            console.error('Order submit reconciliation failed:', {
                clientOrderId,
                error: getErrorMessage(reconcileError)
            });
        }

        await TradesService.markOrderUnknown(pendingTrade, error);

        return {
            orderResult: undefined,
            pendingTrade,
            clientOrderId,
            unknown: true,
            error
        };
    }
};

const getLiveTradingPauseReason = (config: RobotConfig) => {
    if (config.tradingPaused) return 'trading is paused by ROBOT_TRADING_PAUSED';
    if (circuitBreakerOpen) return circuitBreakerReason ?? 'circuit breaker is open';
    return undefined;
};

const executeBuySignals = async (
    accountId: string,
    config: RobotConfig,
    instruments: ShareInstrument[]
) => {
    const previews = await BuySignalEvaluatorService.evaluateAccount(accountId, config, instruments);

    for (const preview of previews) {
        if (preview.status !== 'allowed') {
            await TradeJournalService.logDecision({
                accountId,
                accountAlias: preview.accountAlias,
                accountMode: 'trade',
                figi: preview.figi,
                instrumentUid: preview.instrumentUid,
                ticker: preview.ticker,
                name: preview.name,
                status: 'skip',
                signalSource: preview.signal?.source ?? 'watchlist-buy',
                reason: preview.reason,
                currentPrice: preview.currentPrice,
                estimatedOrderRub: preview.estimatedOrderRub
            });
            continue;
        }

        if (config.dryRun) {
            await TradeJournalService.logDecision({
                accountId,
                accountAlias: preview.accountAlias,
                accountMode: 'trade',
                figi: preview.figi,
                instrumentUid: preview.instrumentUid,
                ticker: preview.ticker,
                name: preview.name,
                status: 'dry-run',
                signalSource: preview.signal?.source,
                reason: preview.reason,
                currentPrice: preview.currentPrice,
                quantityLots: preview.quantityLots,
                estimatedOrderRub: preview.estimatedOrderRub
            });
            continue;
        }

        if (!preview.figi || !preview.instrumentUid || !preview.quantityLots || !preview.currentPrice) {
            await TradeJournalService.logDecision({
                accountId,
                accountAlias: preview.accountAlias,
                accountMode: 'trade',
                figi: preview.figi,
                instrumentUid: preview.instrumentUid,
                ticker: preview.ticker,
                name: preview.name,
                status: 'skip',
                signalSource: preview.signal?.source,
                reason: 'buy preview is missing order parameters',
                currentPrice: preview.currentPrice,
                quantityLots: preview.quantityLots,
                estimatedOrderRub: preview.estimatedOrderRub
            });
            continue;
        }

        const pauseReason = getLiveTradingPauseReason(config);
        if (pauseReason) {
            await TradeJournalService.logDecision({
                accountId,
                accountAlias: preview.accountAlias,
                accountMode: 'trade',
                figi: preview.figi,
                instrumentUid: preview.instrumentUid,
                ticker: preview.ticker,
                name: preview.name,
                status: 'skip',
                signalSource: preview.signal?.source,
                reason: pauseReason,
                currentPrice: preview.currentPrice,
                quantityLots: preview.quantityLots,
                estimatedOrderRub: preview.estimatedOrderRub
            });
            continue;
        }

        if (await TradesService.hasOpenOrderForInstrument(accountId, preview.figi, preview.instrumentUid, '1')) {
            await TradeJournalService.logDecision({
                accountId,
                accountAlias: preview.accountAlias,
                accountMode: 'trade',
                figi: preview.figi,
                instrumentUid: preview.instrumentUid,
                ticker: preview.ticker,
                name: preview.name,
                status: 'skip',
                signalSource: preview.signal?.source,
                reason: 'open buy order already exists',
                currentPrice: preview.currentPrice,
                quantityLots: preview.quantityLots,
                estimatedOrderRub: preview.estimatedOrderRub
            });
            continue;
        }

        const orderSubmission = await submitTrackedOrder({
            accountId,
            config,
            side: ORDER_SIDE.BUY,
            quantityLots: preview.quantityLots,
            price: numberToQuotation(preview.currentPrice ?? 0),
            figi: preview.figi,
            instrumentUid: preview.instrumentUid,
            ticker: preview.ticker,
            name: preview.name,
            lot: preview.lot,
            estimatedOrderRub: preview.estimatedOrderRub,
            score: preview.scoreAnalysis?.score,
            orderBookMetrics: preview.preBuyRisk
                ? {
                    spreadPercent: preview.preBuyRisk.spreadPercent,
                    askLiquidityRub: preview.preBuyRisk.askLiquidityRub
                }
                : undefined
        });

        if (orderSubmission.failedBeforeSubmit) {
            await TradeJournalService.logDecision({
                accountId,
                accountAlias: preview.accountAlias,
                accountMode: 'trade',
                figi: preview.figi,
                instrumentUid: preview.instrumentUid,
                ticker: preview.ticker,
                name: preview.name,
                status: 'order-failed-before-submit',
                signalSource: preview.signal?.source,
                reason: getErrorMessage(orderSubmission.error),
                currentPrice: preview.currentPrice,
                quantityLots: preview.quantityLots,
                estimatedOrderRub: preview.estimatedOrderRub
            });
            continue;
        }

        if (orderSubmission.unknown) {
            await TradeJournalService.logDecision({
                accountId,
                accountAlias: preview.accountAlias,
                accountMode: 'trade',
                figi: preview.figi,
                instrumentUid: preview.instrumentUid,
                ticker: preview.ticker,
                name: preview.name,
                status: 'order-unknown',
                signalSource: preview.signal?.source,
                reason: `postOrder state is unknown; duplicate orders blocked by clientOrderId ${orderSubmission.clientOrderId}: ${getErrorMessage(orderSubmission.error)}`,
                currentPrice: preview.currentPrice,
                quantityLots: preview.quantityLots,
                estimatedOrderRub: preview.estimatedOrderRub
            });
            continue;
        }

        await TradeJournalService.logDecision({
            accountId,
            accountAlias: preview.accountAlias,
            accountMode: 'trade',
            figi: preview.figi,
            instrumentUid: preview.instrumentUid,
            ticker: preview.ticker,
            name: preview.name,
            status: getSubmittedDecisionStatus(orderSubmission),
            signalSource: preview.signal?.source,
            reason: getSubmittedDecisionReason(`${preview.reason}; ${orderSubmission.executionPolicy?.reason ?? ''}`, orderSubmission),
            currentPrice: preview.currentPrice,
            quantityLots: preview.quantityLots,
            estimatedOrderRub: preview.estimatedOrderRub
        });
    }
};

export const executeTrades = async (
    accountId: string,
    config: RobotConfig = getRobotConfig(),
    instruments?: ShareInstrument[],
    accountMode: AccountMode = 'trade'
) => {
    const accountAlias = config.accountAliases[accountId];
    console.log(`accountId: ${accountId}${accountAlias ? ' (' + accountAlias + ')' : ''} mode=${accountMode}`);

    const portfolio = await operationService.getPortfolio(accountId);
    if (!portfolio?.positions?.length) {
        await TradeJournalService.logDecision({
            accountId,
            accountAlias,
            accountMode,
            status: 'skip',
            reason: 'portfolio has no positions'
        });
        return;
    }

    const tradingStatuses = await marketData.getStatuses(
        portfolio.positions.map(position => position.instrumentUid).filter(Boolean)
    );
    const ledger = await RobotPositionLedgerService.getLedger(config);
    const ledgerEntries: Array<[string, { lastTradeAt?: Date | string }]> = [];
    for (const item of ledger.items || []) {
        if (item.accountId !== accountId) continue;
        if (item.instrumentUid) ledgerEntries.push([String(item.instrumentUid), item]);
        if (item.figi) ledgerEntries.push([String(item.figi), item]);
    }
    const ledgerByInstrument = new Map(ledgerEntries);

    for (const position of portfolio.positions) {
        const averagePrice = quotationToNumber(position?.averagePositionPrice);
        const currentPrice = quotationToNumber(position?.currentPrice);
        const instrument = findInstrument(instruments ?? [], position?.figi, position?.instrumentUid);

        if (averagePrice === undefined || currentPrice === undefined) {
            await TradeJournalService.logDecision({
                accountId,
                accountAlias,
                accountMode,
                figi: position?.figi,
                instrumentUid: position?.instrumentUid,
                ticker: instrument?.ticker,
                name: instrument?.name,
                status: 'skip',
                reason: 'average or current price is empty'
            });
            continue;
        }
        const orderPrice = position.currentPrice;
        if (!orderPrice) {
            await TradeJournalService.logDecision({
                accountId,
                accountAlias,
                accountMode,
                figi: position?.figi,
                instrumentUid: position?.instrumentUid,
                ticker: instrument?.ticker,
                name: instrument?.name,
                status: 'skip',
                reason: 'order price is empty'
            });
            continue;
        }

        if (config.positionDelayMs > 0) {
            await delay(config.positionDelayMs);
        }

        const tradingStatus = tradingStatuses.get(position.instrumentUid);
        const ledgerItem = ledgerByInstrument.get(position.instrumentUid) ?? ledgerByInstrument.get(position.figi);
        const signal = await StrategyEngine.evaluate({
            accountId,
            figi: position.figi,
            instrumentUid: position.instrumentUid,
            ticker: instrument?.ticker,
            name: instrument?.name,
            averagePrice,
            currentPrice,
            quantityLots: position.quantityLots?.units,
            lastTradeAt: ledgerItem?.lastTradeAt
        }, config);
        const risk = RiskManagerService.evaluateSignal({
            averagePrice,
            currentPrice,
            quantityLots: position.quantityLots?.units,
            tradingStatus: tradingStatus?.tradingStatus,
            signal
        }, config);

        if (!risk.allowed) {
            await TradeJournalService.logDecision({
                accountId,
                accountAlias,
                accountMode,
                figi: position?.figi,
                instrumentUid: position?.instrumentUid,
                ticker: instrument?.ticker,
                name: instrument?.name,
                status: 'skip',
                signalSource: signal?.source,
                reason: risk.reason,
                averagePrice,
                currentPrice,
                profitPercent: risk.profitPercent,
                quantityLots: position.quantityLots?.units
            });
            continue;
        }

        if (config.dryRun || accountMode === 'observe') {
            await TradeJournalService.logDecision({
                accountId,
                accountAlias,
                accountMode,
                figi: position?.figi,
                instrumentUid: position?.instrumentUid,
                ticker: instrument?.ticker,
                name: instrument?.name,
                status: 'dry-run',
                signalSource: signal?.source,
                reason: accountMode === 'observe' ? 'observe-only: ' + risk.reason : risk.reason,
                averagePrice,
                currentPrice,
                profitPercent: risk.profitPercent,
                quantityLots: risk.quantity
            });
            continue;
        }

        const sellPolicy = await SellPolicyService.evaluateSellPermission({
            accountId,
            figi: position?.figi,
            instrumentUid: position?.instrumentUid,
            requestedLots: risk.quantity,
            signalSource: signal?.source,
            profitPercent: risk.profitPercent,
            minProfitPercent: config.minProfitPercent,
            currentPrice,
            lotSize: instrument?.lot
        });

        if (!sellPolicy.allowed) {
            await TradeJournalService.logDecision({
                accountId,
                accountAlias,
                accountMode,
                figi: position?.figi,
                instrumentUid: position?.instrumentUid,
                ticker: instrument?.ticker,
                name: instrument?.name,
                status: 'skip',
                signalSource: signal?.source,
                reason: sellPolicy.reason,
                averagePrice,
                currentPrice,
                profitPercent: risk.profitPercent,
                quantityLots: risk.quantity
            });
            continue;
        }

        if (!config.liveAllowedActions.includes('sell')) {
            await TradeJournalService.logDecision({
                accountId,
                accountAlias,
                accountMode,
                figi: position?.figi,
                instrumentUid: position?.instrumentUid,
                ticker: instrument?.ticker,
                name: instrument?.name,
                status: 'skip',
                signalSource: signal?.source,
                reason: `live sell is disabled by ROBOT_LIVE_ALLOWED_ACTIONS; ${sellPolicy.reason}`,
                averagePrice,
                currentPrice,
                profitPercent: risk.profitPercent,
                quantityLots: sellPolicy.allowedLots
            });
            continue;
        }

        const pauseReason = getLiveTradingPauseReason(config);
        if (pauseReason) {
            await TradeJournalService.logDecision({
                accountId,
                accountAlias,
                accountMode,
                figi: position?.figi,
                instrumentUid: position?.instrumentUid,
                ticker: instrument?.ticker,
                name: instrument?.name,
                status: 'skip',
                signalSource: signal?.source,
                reason: pauseReason,
                averagePrice,
                currentPrice,
                profitPercent: risk.profitPercent,
                quantityLots: sellPolicy.allowedLots
            });
            continue;
        }

        if (await TradesService.hasOpenOrderForInstrument(accountId, position.figi, position.instrumentUid, '2')) {
            await TradeJournalService.logDecision({
                accountId,
                accountAlias,
                accountMode,
                figi: position?.figi,
                instrumentUid: position?.instrumentUid,
                ticker: instrument?.ticker,
                name: instrument?.name,
                status: 'skip',
                signalSource: signal?.source,
                reason: 'open sell order already exists',
                averagePrice,
                currentPrice,
                profitPercent: risk.profitPercent,
                quantityLots: sellPolicy.allowedLots
            });
            continue;
        }

        const orderSubmission = await submitTrackedOrder({
            accountId,
            config,
            side: ORDER_SIDE.SELL,
            quantityLots: sellPolicy.allowedLots,
            price: orderPrice,
            figi: position.figi,
            instrumentUid: position.instrumentUid,
            ticker: instrument?.ticker,
            name: instrument?.name,
            lot: instrument?.lot
        });

        if (orderSubmission.failedBeforeSubmit) {
            await TradeJournalService.logDecision({
                accountId,
                accountAlias,
                accountMode,
                figi: position?.figi,
                instrumentUid: position?.instrumentUid,
                ticker: instrument?.ticker,
                name: instrument?.name,
                status: 'order-failed-before-submit',
                signalSource: signal?.source,
                reason: getErrorMessage(orderSubmission.error),
                averagePrice,
                currentPrice,
                profitPercent: risk.profitPercent,
                quantityLots: sellPolicy.allowedLots
            });
            continue;
        }

        if (orderSubmission.unknown) {
            await TradeJournalService.logDecision({
                accountId,
                accountAlias,
                accountMode,
                figi: position?.figi,
                instrumentUid: position?.instrumentUid,
                ticker: instrument?.ticker,
                name: instrument?.name,
                status: 'order-unknown',
                signalSource: signal?.source,
                reason: `postOrder state is unknown; duplicate orders blocked by clientOrderId ${orderSubmission.clientOrderId}: ${getErrorMessage(orderSubmission.error)}`,
                averagePrice,
                currentPrice,
                profitPercent: risk.profitPercent,
                quantityLots: sellPolicy.allowedLots
            });
            continue;
        }

        await TradeJournalService.logDecision({
            accountId,
            accountAlias,
            accountMode,
            figi: position?.figi,
            instrumentUid: position?.instrumentUid,
            ticker: instrument?.ticker,
            name: instrument?.name,
            status: getSubmittedDecisionStatus(orderSubmission),
            signalSource: signal?.source,
            reason: getSubmittedDecisionReason(`${risk.reason}; ${sellPolicy.reason}; ${orderSubmission.executionPolicy?.reason ?? ''}`, orderSubmission),
            averagePrice,
            currentPrice,
            profitPercent: risk.profitPercent,
            quantityLots: sellPolicy.allowedLots
        });
    }
};

const executeRobotTick = async (config: RobotConfig) => {
    if (isTickRunning) {
        console.log('Trading tick is still running, skip this interval.');
        return;
    }

    isTickRunning = true;
    lastTickStartedAt = new Date().toISOString();
    lastTickError = undefined;

    try {
        console.log('Trading tick started. dryRun=' + config.dryRun);

        const shares = await InstrumentsService.getShares();
        const instruments = shares?.instruments ?? [];

        await OrderReconciliationService.reconcileOpenOrders();
        await ensureProtectiveStopsForOpenRobotPositions(config);

        for (const accountId of config.observeAccountIds) {
            await executeTrades(accountId, config, instruments, 'observe');
        }

        for (const accountId of config.accountIds) {
            await executeTrades(accountId, config, instruments, 'trade');
            await executeBuySignals(accountId, config, instruments);
        }

        await OrderReconciliationService.reconcileOpenOrders();
        await PortfolioSnapshotService.capture(config);
        consecutiveTickErrors = 0;
    } catch (error) {
        console.error('Error occurred in trading tick:', error);
        lastTickError = error instanceof Error ? error.message : String(error);
        consecutiveTickErrors += 1;
        if (consecutiveTickErrors >= config.maxConsecutiveTickErrors) {
            circuitBreakerOpen = true;
            circuitBreakerReason = `circuit breaker opened after ${consecutiveTickErrors} consecutive tick errors`;
            console.error(circuitBreakerReason);
        }
    } finally {
        isTickRunning = false;
        lastTickFinishedAt = new Date().toISOString();
        console.log('Trading tick finished.');
    }
};

const executeBuySignalJournalTick = async (config: RobotConfig) => {
    if (isBuySignalJournalRunning) {
        console.log('Buy signal journal tick is still running, skip this interval.');
        return;
    }

    isBuySignalJournalRunning = true;

    try {
        const result = await BuySignalJournalService.capture(config);
        console.log(`Buy signal journal tick finished. captured=${result.captured} updated=${result.updated}`);
    } catch (error) {
        console.error('Error occurred in buy signal journal tick:', error);
    } finally {
        isBuySignalJournalRunning = false;
    }
};

const executePaperTradingTick = async (config: RobotConfig) => {
    if (isPaperTradingRunning) {
        console.log('Paper trading tick is still running, skip this interval.');
        return;
    }

    isPaperTradingRunning = true;

    try {
        const result = await PaperTradingService.tick(config);
        console.log(`Paper trading tick finished. opened=${result.opened} updated=${result.updated} closed=${result.closed}`);
    } catch (error) {
        console.error('Error occurred in paper trading tick:', error);
    } finally {
        isPaperTradingRunning = false;
    }
};

export function startTradingProcess(config: RobotConfig = getRobotConfig()): TradingProcess {
    console.log('Trading process started.');
    console.log('Accounts: ' + config.accountIds.join(', '));
    console.log('Observe accounts: ' + (config.observeAccountIds.join(', ') || '<none>'));
    console.log('Protected accounts: ' + (config.protectedAccountIds.join(', ') || '<none>'));
    console.log('Interval: ' + config.intervalMs + ' ms');
    console.log('Min profit: ' + config.minProfitPercent + '%');
    console.log('Stop loss: ' + config.stopLossPercent + '%');
    console.log('Trailing stop: ' + config.trailingStopPercent + '%');
    console.log('Trailing baseline: ' + config.trailingBaseline);
    console.log('Strategies: ' + config.enabledStrategies.join(', '));
    console.log('Max lots per order: ' + config.maxLotsPerOrder);
    console.log('Max order RUB: ' + config.maxOrderRub);
    console.log('Max daily orders: ' + config.maxDailyOrders);
    console.log('Max daily RUB: ' + config.maxDailyRub);
    console.log('Buy tickers: ' + (config.buyTickers.join(', ') || '<none>'));
    console.log(`Buy score: min ${config.buyMinScore}, trend ${config.buyTrendDays}d, min trend ${config.buyMinTrendPercent}%, min momentum ${config.buyMinMomentumPercent}%`);
    console.log('Dry run: ' + config.dryRun);
    console.log('Live allowed actions: ' + config.liveAllowedActions.join(', '));
    console.log(`Order types: buy=${config.buyOrderType}, sell=${config.sellOrderType}`);
    console.log('Live confirmation required: ' + config.liveConfirmationRequired);
    console.log('Trading paused: ' + config.tradingPaused);
    console.log('Max consecutive tick errors: ' + config.maxConsecutiveTickErrors);
    console.log('Snapshot interval: ' + config.snapshotIntervalMs + ' ms');
    console.log('Buy signal journal interval: ' + config.buySignalJournalIntervalMs + ' ms');
    console.log('Paper trading: ' + config.paperTradingEnabled);
    console.log('Paper trading interval: ' + config.paperTradingIntervalMs + ' ms');

    const withEffectiveConfig = async (task: (effectiveConfig: RobotConfig) => Promise<void>) => {
        try {
            const effectiveConfig = await RuntimeConfigService.getEffectiveConfig(config);
            await task(effectiveConfig);
        } catch (error) {
            console.error('Failed to load runtime config:', error);
        }
    };

    void withEffectiveConfig(executeRobotTick);
    const interval = setInterval(() => void withEffectiveConfig(executeRobotTick), config.intervalMs);
    const buySignalJournalInterval = config.buySignalJournalIntervalMs > 0
        ? setInterval(() => void withEffectiveConfig(executeBuySignalJournalTick), config.buySignalJournalIntervalMs)
        : undefined;

    if (config.buySignalJournalIntervalMs > 0) {
        void withEffectiveConfig(executeBuySignalJournalTick);
    }

    const paperTradingInterval = config.paperTradingEnabled && config.paperTradingIntervalMs > 0
        ? setInterval(() => void withEffectiveConfig(executePaperTradingTick), config.paperTradingIntervalMs)
        : undefined;

    if (config.paperTradingEnabled && config.paperTradingIntervalMs > 0) {
        void withEffectiveConfig(executePaperTradingTick);
    }

    return {
        stop: () => {
            clearInterval(interval);
            if (buySignalJournalInterval) clearInterval(buySignalJournalInterval);
            if (paperTradingInterval) clearInterval(paperTradingInterval);
            console.log('Trading process stopped.');
        }
    };
}
