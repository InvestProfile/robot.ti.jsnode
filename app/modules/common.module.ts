import { getRobotConfig, RobotConfig } from '../config/robot.config';
import InstrumentsService from '../services/instruments.service';
import BuySignalEvaluatorService from '../services/buy-signal-evaluator.service';
import marketData from '../services/marketData.service';
import operationService from '../services/operations.service';
import orderService from '../services/orders.service';
import RiskManagerService from '../services/risk-manager.service';
import TradeJournalService from '../services/trade-journal.service';
import TradesService from '../services/trades.service';
import OrderReconciliationService from '../services/order-reconciliation.service';
import PortfolioSnapshotService from '../services/portfolio-snapshot.service';
import BuySignalJournalService from '../services/buy-signal-journal.service';
import PaperTradingService from '../services/paper-trading.service';
import RuntimeConfigService from '../services/runtime-config.service';
import SellPolicyService from '../services/sell-policy.service';
import StrategyEngine from '../strategies/strategy-engine';
import { numberToQuotation, quotationToNumber } from '../utils/money';
import { normalizeOrderStatus, normalizeOrderType } from '../utils/order-status';

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
    circuitBreakerReason
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

        const orderResult = await orderService.postOrder(
            accountId,
            1,
            preview.quantityLots,
            numberToQuotation(preview.currentPrice ?? 0),
            preview.figi,
            preview.instrumentUid
        );

        if (!orderResult) {
            await TradeJournalService.logDecision({
                accountId,
                accountAlias: preview.accountAlias,
                accountMode: 'trade',
                figi: preview.figi,
                instrumentUid: preview.instrumentUid,
                ticker: preview.ticker,
                name: preview.name,
                status: 'order-failed',
                signalSource: preview.signal?.source,
                reason: 'postOrder returned empty result',
                currentPrice: preview.currentPrice,
                quantityLots: preview.quantityLots,
                estimatedOrderRub: preview.estimatedOrderRub
            });
            continue;
        }

        await TradesService.createTrade(
            preview.figi,
            '1',
            '1',
            Math.trunc(preview.currentPrice ?? 0),
            Math.round(((preview.currentPrice ?? 0) - Math.trunc(preview.currentPrice ?? 0)) * 1e9),
            preview.instrumentUid,
            preview.instrumentUid,
            accountId,
            preview.ticker,
            preview.name,
            preview.quantityLots,
            {
                ...getOrderMetadata(orderResult),
                instrumentId: preview.instrumentUid
            }
        );

        await TradeJournalService.logDecision({
            accountId,
            accountAlias: preview.accountAlias,
            accountMode: 'trade',
            figi: preview.figi,
            instrumentUid: preview.instrumentUid,
            ticker: preview.ticker,
            name: preview.name,
            status: 'order-posted',
            signalSource: preview.signal?.source,
            reason: preview.reason,
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
        const signal = await StrategyEngine.evaluate({
            accountId,
            figi: position.figi,
            instrumentUid: position.instrumentUid,
            ticker: instrument?.ticker,
            name: instrument?.name,
            averagePrice,
            currentPrice,
            quantityLots: position.quantityLots?.units
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
            requestedLots: risk.quantity
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

        const orderResult = await orderService.postOrder(
            accountId,
            2,
            sellPolicy.allowedLots,
            orderPrice,
            position.figi,
            position.instrumentUid
        );

        if (!orderResult) {
            await TradeJournalService.logDecision({
                accountId,
                accountAlias,
                accountMode,
                figi: position?.figi,
                instrumentUid: position?.instrumentUid,
                ticker: instrument?.ticker,
                name: instrument?.name,
                status: 'order-failed',
                signalSource: signal?.source,
                reason: 'postOrder returned empty result',
                averagePrice,
                currentPrice,
                profitPercent: risk.profitPercent,
                quantityLots: sellPolicy.allowedLots
            });
            continue;
        }

        await TradesService.createTrade(
            position?.figi,
            '1',
            '2',
            position?.currentPrice?.units,
            position?.currentPrice?.nano,
            position?.instrumentUid,
            position?.instrumentUid,
            accountId,
            instrument?.ticker,
            instrument?.name,
            sellPolicy.allowedLots,
            {
                ...getOrderMetadata(orderResult),
                instrumentId: position?.instrumentUid
            }
        );

        await TradeJournalService.logDecision({
            accountId,
            accountAlias,
            accountMode,
            figi: position?.figi,
            instrumentUid: position?.instrumentUid,
            ticker: instrument?.ticker,
            name: instrument?.name,
            status: 'order-posted',
            signalSource: signal?.source,
            reason: `${risk.reason}; ${sellPolicy.reason}`,
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
