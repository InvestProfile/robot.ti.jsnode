import { getRobotConfig, RobotConfig } from '../config/robot.config';
import InstrumentsService from '../services/instruments.service';
import marketData from '../services/marketData.service';
import operationService from '../services/operations.service';
import orderService from '../services/orders.service';
import RiskManagerService from '../services/risk-manager.service';
import TradeJournalService from '../services/trade-journal.service';
import TradesService from '../services/trades.service';
import StrategyEngine from '../strategies/strategy-engine';
import { numberToQuotation, quotationToNumber } from '../utils/money';

const delay = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds));

type SharesResponse = Awaited<ReturnType<typeof InstrumentsService.getShares>>;
type ShareInstrument = NonNullable<NonNullable<SharesResponse>['instruments']>[number];
type AccountMode = 'trade' | 'observe';

let isTickRunning = false;
let lastTickStartedAt: string | undefined;
let lastTickFinishedAt: string | undefined;
let lastTickError: string | undefined;

export interface TradingProcess {
    stop: () => void;
}

export const getTradingRuntimeState = () => ({
    isTickRunning,
    lastTickStartedAt,
    lastTickFinishedAt,
    lastTickError
});

const findInstrument = (
    instruments: ShareInstrument[],
    figi: string | undefined,
    instrumentUid: string | undefined
) => {
    return instruments.find(instrument => instrument?.figi === figi && instrument?.uid === instrumentUid)
        ?? instruments.find(instrument => instrument?.figi === figi);
};

const executeBuySignals = async (
    accountId: string,
    config: RobotConfig,
    instruments: ShareInstrument[]
) => {
    if (config.buyTickers.length === 0) return;

    const accountAlias = config.accountAliases[accountId];
    const portfolio = await operationService.getPortfolio(accountId);
    let remainingCashRub = quotationToNumber(portfolio?.totalAmountCurrencies) ?? 0;
    const portfolioInstrumentIds = new Set(
        portfolio?.positions
            ?.map(position => position.instrumentUid)
            .filter(Boolean) ?? []
    );
    let dailyOrdersCount = await TradesService.countTodayTrades(accountId);
    let dailyOrdersRub = await TradesService.sumTodayBuyTradesRub(accountId);
    const buyInstruments = config.buyTickers
        .map(ticker => instruments.find(instrument => instrument.ticker?.toUpperCase() === ticker))
        .filter((instrument): instrument is ShareInstrument => Boolean(instrument?.uid && instrument?.figi));
    const lastPrices = await marketData.getLastPrices(buyInstruments.map(instrument => instrument.uid));

    for (const instrument of buyInstruments) {
        const lastPrice = lastPrices.get(instrument.uid);
        if (!lastPrice) {
            await TradeJournalService.logDecision({
                accountId,
                accountAlias,
                accountMode: 'trade',
                figi: instrument.figi,
                instrumentUid: instrument.uid,
                ticker: instrument.ticker,
                name: instrument.name,
                status: 'skip',
                signalSource: 'watchlist-buy',
                reason: 'last price is empty'
            });
            continue;
        }

        const estimatedOrderRub = lastPrice * Math.max(1, instrument.lot ?? 1);
        const alreadyInPortfolio = portfolioInstrumentIds.has(instrument.uid);
        const skipReason = alreadyInPortfolio
            ? 'instrument is already in portfolio'
            : estimatedOrderRub > config.maxOrderRub
                ? 'estimated lot is above max order RUB'
                : estimatedOrderRub > remainingCashRub
                    ? 'not enough cash for estimated lot'
                    : undefined;
        const tradingStatus = await marketData.getStatus(instrument.figi, instrument.uid);
        const signal = StrategyEngine.evaluateBuy({
            accountId,
            figi: instrument.figi,
            instrumentUid: instrument.uid,
            ticker: instrument.ticker,
            name: instrument.name,
            lot: instrument.lot ?? 1,
            lastPrice,
            availableCashRub: remainingCashRub,
            alreadyInPortfolio
        }, config);
        const risk = RiskManagerService.evaluateBuySignal({
            availableCashRub: remainingCashRub,
            dailyOrdersCount,
            dailyOrdersRub,
            signal,
            tradingStatus: tradingStatus?.tradingStatus
        }, config);

        if (!risk.allowed) {
            await TradeJournalService.logDecision({
                accountId,
                accountAlias,
                accountMode: 'trade',
                figi: instrument.figi,
                instrumentUid: instrument.uid,
                ticker: instrument.ticker,
                name: instrument.name,
                status: 'skip',
                signalSource: signal?.source ?? 'watchlist-buy',
                reason: skipReason ?? risk.reason,
                currentPrice: lastPrice,
                estimatedOrderRub: signal?.estimatedOrderRub ?? estimatedOrderRub
            });
            continue;
        }

        if (config.dryRun) {
            await TradeJournalService.logDecision({
                accountId,
                accountAlias,
                accountMode: 'trade',
                figi: instrument.figi,
                instrumentUid: instrument.uid,
                ticker: instrument.ticker,
                name: instrument.name,
                status: 'dry-run',
                signalSource: signal?.source,
                reason: risk.reason,
                currentPrice: lastPrice,
                quantityLots: risk.quantity,
                estimatedOrderRub: risk.estimatedOrderRub
            });
            dailyOrdersCount += 1;
            dailyOrdersRub += risk.estimatedOrderRub ?? 0;
            remainingCashRub -= risk.estimatedOrderRub ?? 0;
            continue;
        }

        const orderResult = await orderService.postOrder(
            accountId,
            1,
            risk.quantity,
            numberToQuotation(lastPrice),
            instrument.figi,
            instrument.uid
        );

        if (!orderResult) {
            await TradeJournalService.logDecision({
                accountId,
                accountAlias,
                accountMode: 'trade',
                figi: instrument.figi,
                instrumentUid: instrument.uid,
                ticker: instrument.ticker,
                name: instrument.name,
                status: 'order-failed',
                signalSource: signal?.source,
                reason: 'postOrder returned empty result',
                currentPrice: lastPrice,
                quantityLots: risk.quantity,
                estimatedOrderRub: risk.estimatedOrderRub
            });
            continue;
        }

        dailyOrdersCount += 1;
        dailyOrdersRub += risk.estimatedOrderRub ?? 0;
        remainingCashRub -= risk.estimatedOrderRub ?? 0;

        await TradesService.createTrade(
            instrument.figi,
            '1',
            '1',
            Math.trunc(lastPrice),
            Math.round((lastPrice - Math.trunc(lastPrice)) * 1e9),
            instrument.uid,
            instrument.uid,
            accountId,
            instrument.ticker,
            instrument.name,
            risk.quantity
        );
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

        const tradingStatus = await marketData.getStatus(position.figi, position.instrumentUid);
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

        const orderResult = await orderService.postOrder(
            accountId,
            2,
            risk.quantity,
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
                quantityLots: risk.quantity
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
            risk.quantity
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
            reason: risk.reason,
            averagePrice,
            currentPrice,
            profitPercent: risk.profitPercent,
            quantityLots: risk.quantity
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

        for (const accountId of config.observeAccountIds) {
            await executeTrades(accountId, config, instruments, 'observe');
        }

        for (const accountId of config.accountIds) {
            await executeTrades(accountId, config, instruments, 'trade');
            await executeBuySignals(accountId, config, instruments);
        }
    } catch (error) {
        console.error('Error occurred in trading tick:', error);
        lastTickError = error instanceof Error ? error.message : String(error);
    } finally {
        isTickRunning = false;
        lastTickFinishedAt = new Date().toISOString();
        console.log('Trading tick finished.');
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
    console.log('Dry run: ' + config.dryRun);
    console.log('Live confirmation required: ' + config.liveConfirmationRequired);

    void executeRobotTick(config);
    const interval = setInterval(() => void executeRobotTick(config), config.intervalMs);

    return {
        stop: () => {
            clearInterval(interval);
            console.log('Trading process stopped.');
        }
    };
}
