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
import MarketRegimeService from './market-regime.service';
import SocialConsensusService from './social-consensus.service';
import BuyScoreAdjustmentService from './buy-score-adjustment.service';
import DailyBuyListService from './daily-buy-list.service';

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
    portfolioValueRub?: number;
    positionValueRub?: number;
    projectedPositionValueRub?: number;
    projectedPositionSharePercent?: number;
    maxPositionValueRub?: number;
    portfolioPositionsCount?: number;
}

export default class BuySignalEvaluatorService {
    static async evaluateAccount(
        accountId: string,
        config: RobotConfig,
        instruments?: ShareInstrument[]
    ) {
        const effectiveBuyTickers = await DailyBuyListService.getEffectiveBuyTickers(config);
        if (effectiveBuyTickers.length === 0) return [];

        const accountAlias = config.accountAliases[accountId];
        const shares = instruments ? undefined : await InstrumentsService.getShares();
        const allInstruments = instruments ?? shares?.instruments ?? [];
        const portfolio = await operationService.getPortfolio(accountId);
        const instrumentByUid = new Map(allInstruments.map(instrument => [instrument.uid, instrument]));
        const portfolioValueRub = quotationToNumber(portfolio?.totalAmountPortfolio) ?? 0;
        let remainingCashRub = quotationToNumber(portfolio?.totalAmountCurrencies) ?? 0;
        let dailyOrdersCount = await TradesService.countTodayTrades(accountId);
        let dailyOrdersRub = await TradesService.sumTodayBuyTradesRub(accountId);
        const positionValueByInstrumentUid = new Map<string, number>();

        for (const position of portfolio?.positions ?? []) {
            if (!position.instrumentUid) continue;

            const quantityLots = Number(position.quantityLots?.units ?? 0);
            if (!Number.isFinite(quantityLots) || quantityLots <= 0) continue;

            const currentPrice = quotationToNumber(position.currentPrice)
                ?? quotationToNumber(position.averagePositionPrice)
                ?? 0;
            const lot = Math.max(1, instrumentByUid.get(position.instrumentUid)?.lot ?? 1);
            const positionValueRub = currentPrice * quantityLots * lot;
            if (!Number.isFinite(positionValueRub) || positionValueRub <= 0) continue;

            positionValueByInstrumentUid.set(
                position.instrumentUid,
                (positionValueByInstrumentUid.get(position.instrumentUid) ?? 0) + positionValueRub
            );
        }

        const portfolioInstrumentIds = new Set(positionValueByInstrumentUid.keys());
        const portfolioPositionsCount = portfolioInstrumentIds.size;
        const buyInstruments = effectiveBuyTickers
            .map(ticker => allInstruments.find(instrument => instrument.ticker?.toUpperCase() === ticker))
            .filter((instrument): instrument is ShareInstrument => Boolean(instrument?.uid && instrument?.figi));
        const lastPrices = await marketData.getLastPrices(buyInstruments.map(instrument => instrument.uid));
        const tradingStatuses = await marketData.getStatuses(buyInstruments.map(instrument => instrument.uid));
        const marketRegime = await MarketRegimeService.evaluate(config);
        const socialConsensus = config.socialConsensusEnabled
            ? await SocialConsensusService.getConsensus({
                days: config.socialConsensusDays,
                maxScoreAdjustment: config.socialConsensusMaxScoreAdjustment,
                minActors: config.socialConsensusMinActors,
                tickers: buyInstruments.map(instrument => instrument.ticker)
            })
            : undefined;
        const socialByTicker = new Map(
            socialConsensus?.items.map(item => [item.ticker, item]) ?? []
        );
        const scoreAdjustments = await BuyScoreAdjustmentService.getAdjustments(
            config,
            buyInstruments.map(instrument => instrument.ticker)
        );
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
                    dailyOrdersRub,
                    portfolioValueRub,
                    positionValueRub: 0,
                    projectedPositionValueRub: 0,
                    portfolioPositionsCount
                });
                continue;
            }

            const estimatedOrderRub = lastPrice * Math.max(1, instrument.lot ?? 1);
            const alreadyInPortfolio = portfolioInstrumentIds.has(instrument.uid);
            const positionValueRub = positionValueByInstrumentUid.get(instrument.uid) ?? 0;
            const tradingStatus = tradingStatuses.get(instrument.uid);
            const buyConfig = getBuyScoreConfigForTicker(config, instrument.ticker);
            const effectiveBuyConfig = {
                ...buyConfig,
                buyTickers: effectiveBuyTickers
            };
            const dailyCandles = buyConfig.enabledStrategies.includes('score-buy')
                ? await marketData.getDailyCandles(instrument.uid, buyConfig.buyTrendDays)
                : undefined;
            const dailyCloses = buyConfig.enabledStrategies.includes('trend-follow-buy')
                ? await marketData.getDailyClosePrices(instrument.uid, buyConfig.buyTrendDays)
                : undefined;
            const social = socialByTicker.get(instrument.ticker.toUpperCase());
            const analyst = scoreAdjustments.analyst.get(instrument.ticker.toUpperCase());
            const technical = scoreAdjustments.technical.get(instrument.ticker.toUpperCase());
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
                dailyCandles,
                socialScoreAdjustment: social?.scoreAdjustment,
                socialScore: social?.score,
                socialMood: social?.mood,
                socialReason: social?.reason,
                analystScoreAdjustment: analyst?.adjustment,
                analystReason: analyst?.reason,
                technicalScoreAdjustment: technical?.adjustment,
                technicalReason: technical?.reason
            }, effectiveBuyConfig);
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
                    dailyCandles,
                    socialScoreAdjustment: social?.scoreAdjustment,
                    socialScore: social?.score,
                    socialMood: social?.mood,
                    socialReason: social?.reason,
                    analystScoreAdjustment: analyst?.adjustment,
                    analystReason: analyst?.reason,
                    technicalScoreAdjustment: technical?.adjustment,
                    technicalReason: technical?.reason
                }, effectiveBuyConfig)
                : undefined;
            const risk = RiskManagerService.evaluateBuySignal({
                availableCashRub: remainingCashRub,
                dailyOrdersCount,
                dailyOrdersRub,
                portfolioValueRub,
                positionValueRub,
                portfolioPositionsCount,
                alreadyInPortfolio,
                signal: marketRegime.passed ? signal : undefined,
                tradingStatus: tradingStatus?.tradingStatus
            }, config);
            const skipReason = estimatedOrderRub > config.maxOrderRub
                ? 'estimated lot is above max order RUB'
                : estimatedOrderRub > remainingCashRub
                    ? 'not enough cash for estimated lot'
                    : scoreAnalysis && !scoreAnalysis.passed
                        ? `score-buy blocked: ${scoreAnalysis.reason}`
                        : !marketRegime.passed
                            ? marketRegime.reason
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
                dailyOrdersRub,
                portfolioValueRub,
                positionValueRub,
                projectedPositionValueRub: risk.projectedPositionRub,
                projectedPositionSharePercent: risk.projectedPositionSharePercent,
                maxPositionValueRub: risk.maxPositionRub,
                portfolioPositionsCount
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
