import { getRobotConfig, RobotConfig } from '../config/robot.config';
import InstrumentsService from '../services/instruments.service';
import marketData from '../services/marketData.service';
import operationService from '../services/operations.service';
import orderService from '../services/orders.service';
import RiskManagerService from '../services/risk-manager.service';
import TradeJournalService from '../services/trade-journal.service';
import TradesService from '../services/trades.service';
import { quotationToNumber } from '../utils/money';

const delay = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds));

type SharesResponse = Awaited<ReturnType<typeof InstrumentsService.getShares>>;
type ShareInstrument = NonNullable<NonNullable<SharesResponse>['instruments']>[number];

let isTickRunning = false;

export interface TradingProcess {
    stop: () => void;
}

const findInstrument = (
    instruments: ShareInstrument[],
    figi: string | undefined,
    instrumentUid: string | undefined
) => {
    return instruments.find(instrument => instrument?.figi === figi && instrument?.uid === instrumentUid)
        ?? instruments.find(instrument => instrument?.figi === figi);
};

export const executeTrades = async (
    accountId: string,
    config: RobotConfig = getRobotConfig(),
    instruments?: ShareInstrument[]
) => {
    console.log('accountId: ' + accountId);

    const portfolio = await operationService.getPortfolio(accountId);
    if (!portfolio?.positions?.length) return;

    for (const position of portfolio.positions) {
        const averagePrice = quotationToNumber(position?.averagePositionPrice);
        const currentPrice = quotationToNumber(position?.currentPrice);
        const instrument = findInstrument(instruments ?? [], position?.figi, position?.instrumentUid);

        if (averagePrice === undefined || currentPrice === undefined) {
            await TradeJournalService.logDecision({
                accountId,
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
        const risk = RiskManagerService.evaluateProfitSell({
            averagePrice,
            currentPrice,
            quantityLots: position.quantityLots?.units,
            tradingStatus: tradingStatus?.tradingStatus
        }, config);

        if (!risk.allowed) {
            await TradeJournalService.logDecision({
                accountId,
                figi: position?.figi,
                instrumentUid: position?.instrumentUid,
                ticker: instrument?.ticker,
                name: instrument?.name,
                status: 'skip',
                reason: risk.reason,
                averagePrice,
                currentPrice,
                profitPercent: risk.profitPercent,
                quantityLots: position.quantityLots?.units
            });
            continue;
        }

        if (config.dryRun) {
            await TradeJournalService.logDecision({
                accountId,
                figi: position?.figi,
                instrumentUid: position?.instrumentUid,
                ticker: instrument?.ticker,
                name: instrument?.name,
                status: 'dry-run',
                reason: risk.reason,
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
                figi: position?.figi,
                instrumentUid: position?.instrumentUid,
                ticker: instrument?.ticker,
                name: instrument?.name,
                status: 'order-failed',
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
            figi: position?.figi,
            instrumentUid: position?.instrumentUid,
            ticker: instrument?.ticker,
            name: instrument?.name,
            status: 'order-posted',
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

    try {
        console.log('Trading tick started. dryRun=' + config.dryRun);

        const shares = await InstrumentsService.getShares();
        const instruments = shares?.instruments ?? [];

        for (const accountId of config.accountIds) {
            await executeTrades(accountId, config, instruments);
        }
    } catch (error) {
        console.error('Error occurred in trading tick:', error);
    } finally {
        isTickRunning = false;
        console.log('Trading tick finished.');
    }
};

export function startTradingProcess(config: RobotConfig = getRobotConfig()): TradingProcess {
    console.log('Trading process started.');
    console.log('Accounts: ' + config.accountIds.join(', '));
    console.log('Protected accounts: ' + (config.protectedAccountIds.join(', ') || '<none>'));
    console.log('Interval: ' + config.intervalMs + ' ms');
    console.log('Min profit: ' + config.minProfitPercent + '%');
    console.log('Max lots per order: ' + config.maxLotsPerOrder);
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
