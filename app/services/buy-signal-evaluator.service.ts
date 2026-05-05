import { getBuyScoreConfigForTicker, RobotConfig } from '../config/robot.config';
import InstrumentsService from './instruments.service';
import marketData from './marketData.service';
import operationService from './operations.service';
import RiskManagerService from './risk-manager.service';
import TradesService from './trades.service';
import StrategyEngine from '../strategies/strategy-engine';
import { TradeSignal } from '../strategies/trade-signal';
import ScoreBuyStrategy, { BuyScoreAnalysis } from '../strategies/score-buy.strategy';
import { quotationToNumber } from '../utils/money';

type SharesResponse = Awaited<ReturnType<typeof InstrumentsService.getShares>>;
type ShareInstrument = NonNullable<NonNullable<SharesResponse>['instruments']>[number];

export interface BuySignalPreview {
    accountId: string;
    accountAlias?: string;
    figi?: string;
    instrumentUid?: string;
    ticker?: string;
    name?: string;
    currentPrice?: number;
    estimatedOrderRub?: number;
    quantityLots?: number;
    status: 'allowed' | 'blocked';
    reason: string;
    signal?: TradeSignal;
    scoreAnalysis?: BuyScoreAnalysis;
    tradingStatus?: number;
    alreadyInPortfolio?: boolean;
    remainingCashRub: number;
    dailyOrdersCount: number;
    dailyOrdersRub: number;
}

export default class BuySignalEvaluatorService {
    static async evaluateAccount(
        accountId: string,
        config: RobotConfig,
        instruments?: ShareInstrument[]
    ) {
        if (config.buyTickers.length === 0) return [];

        const accountAlias = config.accountAliases[accountId];
        const shares = instruments ? undefined : await InstrumentsService.getShares();
        const allInstruments = instruments ?? shares?.instruments ?? [];
        const portfolio = await operationService.getPortfolio(accountId);
        let remainingCashRub = quotationToNumber(portfolio?.totalAmountCurrencies) ?? 0;
        let dailyOrdersCount = await TradesService.countTodayTrades(accountId);
        let dailyOrdersRub = await TradesService.sumTodayBuyTradesRub(accountId);
        const portfolioInstrumentIds = new Set(
            portfolio?.positions
                ?.map(position => position.instrumentUid)
                .filter(Boolean) ?? []
        );
        const buyInstruments = config.buyTickers
            .map(ticker => allInstruments.find(instrument => instrument.ticker?.toUpperCase() === ticker))
            .filter((instrument): instrument is ShareInstrument => Boolean(instrument?.uid && instrument?.figi));
        const lastPrices = await marketData.getLastPrices(buyInstruments.map(instrument => instrument.uid));
        const previews: BuySignalPreview[] = [];

        for (const instrument of buyInstruments) {
            const lastPrice = lastPrices.get(instrument.uid);

            if (!lastPrice) {
                previews.push({
                    accountId,
                    accountAlias,
                    figi: instrument.figi,
                    instrumentUid: instrument.uid,
                    ticker: instrument.ticker,
                    name: instrument.name,
                    status: 'blocked',
                    reason: 'last price is empty',
                    remainingCashRub,
                    dailyOrdersCount,
                    dailyOrdersRub
                });
                continue;
            }

            const estimatedOrderRub = lastPrice * Math.max(1, instrument.lot ?? 1);
            const alreadyInPortfolio = portfolioInstrumentIds.has(instrument.uid);
            const tradingStatus = await marketData.getStatus(instrument.figi, instrument.uid);
            const buyConfig = getBuyScoreConfigForTicker(config, instrument.ticker);
            const dailyCandles = buyConfig.enabledStrategies.includes('score-buy')
                ? await marketData.getDailyCandles(instrument.uid, buyConfig.buyTrendDays)
                : undefined;
            const dailyCloses = buyConfig.enabledStrategies.includes('trend-follow-buy')
                ? await marketData.getDailyClosePrices(instrument.uid, buyConfig.buyTrendDays)
                : undefined;
            const signal = StrategyEngine.evaluateBuy({
                accountId,
                figi: instrument.figi,
                instrumentUid: instrument.uid,
                ticker: instrument.ticker,
                name: instrument.name,
                lot: instrument.lot ?? 1,
                lastPrice,
                availableCashRub: remainingCashRub,
                alreadyInPortfolio,
                dailyCloses,
                dailyCandles
            }, buyConfig);
            const scoreAnalysis = buyConfig.enabledStrategies.includes('score-buy')
                ? ScoreBuyStrategy.analyze({
                    accountId,
                    figi: instrument.figi,
                    instrumentUid: instrument.uid,
                    ticker: instrument.ticker,
                    name: instrument.name,
                    lot: instrument.lot ?? 1,
                    lastPrice,
                    availableCashRub: remainingCashRub,
                    alreadyInPortfolio,
                    dailyCloses,
                    dailyCandles
                }, buyConfig)
                : undefined;
            const risk = RiskManagerService.evaluateBuySignal({
                availableCashRub: remainingCashRub,
                dailyOrdersCount,
                dailyOrdersRub,
                signal,
                tradingStatus: tradingStatus?.tradingStatus
            }, config);
            const skipReason = alreadyInPortfolio
                ? 'instrument is already in portfolio'
                : estimatedOrderRub > config.maxOrderRub
                    ? 'estimated lot is above max order RUB'
                : estimatedOrderRub > remainingCashRub
                    ? 'not enough cash for estimated lot'
                    : scoreAnalysis && !scoreAnalysis.passed
                        ? `score-buy blocked: ${scoreAnalysis.reason}`
                        : undefined;
            const preview: BuySignalPreview = {
                accountId,
                accountAlias,
                figi: instrument.figi,
                instrumentUid: instrument.uid,
                ticker: instrument.ticker,
                name: instrument.name,
                currentPrice: lastPrice,
                estimatedOrderRub: signal?.estimatedOrderRub ?? estimatedOrderRub,
                quantityLots: risk.quantity,
                status: risk.allowed ? 'allowed' : 'blocked',
                reason: risk.allowed ? risk.reason : skipReason ?? risk.reason,
                signal,
                scoreAnalysis,
                tradingStatus: tradingStatus?.tradingStatus,
                alreadyInPortfolio,
                remainingCashRub,
                dailyOrdersCount,
                dailyOrdersRub
            };

            previews.push(preview);

            if (risk.allowed) {
                dailyOrdersCount += 1;
                dailyOrdersRub += risk.estimatedOrderRub ?? 0;
                remainingCashRub -= risk.estimatedOrderRub ?? 0;
            }
        }

        return previews;
    }
}
