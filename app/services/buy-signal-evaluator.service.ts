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
import PreBuyRiskService, { PreBuyRiskResult } from './pre-buy-risk.service';

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
    lot?: number;
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
    preBuyRisk?: PreBuyRiskResult;
}

const selectTechnicalBudgetTickers = (input: {
    config: RobotConfig;
    accountId: string;
    instruments: ShareInstrument[];
    lastPrices: Map<string, number>;
    dailyCandlesByUid: Map<string, Awaited<ReturnType<typeof marketData.getDailyCandles>> | undefined>;
    socialByTicker: Map<string, NonNullable<Awaited<ReturnType<typeof SocialConsensusService.getConsensus>>>['items'][number]>;
    analystByTicker: Map<string, { adjustment: number; reason: string }>;
    buyConfigByUid: Map<string, RobotConfig>;
    effectiveBuyTickers: string[];
    availableCashRub: number;
}) => {
    const maxTickers = Math.max(1, input.config.technicalAnalysisMaxTickers ?? 40);
    const reach = Math.max(5, input.config.technicalMaxScoreAdjustment ?? 0);
    const ranked = input.instruments
        .map(instrument => {
            const lastPrice = input.lastPrices.get(instrument.uid);
            if (!lastPrice) return undefined;

            const buyConfig = input.buyConfigByUid.get(instrument.uid) ?? input.config;
            const analysis = ScoreBuyStrategy.analyze({
                accountId: input.accountId,
                figi: instrument.figi,
                instrumentUid: instrument.uid,
                ticker: instrument.ticker,
                name: instrument.name,
                lot: instrument.lot ?? 1,
                lastPrice,
                availableCashRub: input.availableCashRub,
                alreadyInPortfolio: false,
                dailyCandles: input.dailyCandlesByUid.get(instrument.uid),
                socialScoreAdjustment: input.socialByTicker.get(instrument.ticker.toUpperCase())?.scoreAdjustment,
                socialScore: input.socialByTicker.get(instrument.ticker.toUpperCase())?.score,
                socialMood: input.socialByTicker.get(instrument.ticker.toUpperCase())?.mood,
                socialReason: input.socialByTicker.get(instrument.ticker.toUpperCase())?.reason,
                analystScoreAdjustment: input.analystByTicker.get(instrument.ticker.toUpperCase())?.adjustment,
                analystReason: input.analystByTicker.get(instrument.ticker.toUpperCase())?.reason,
                technicalScoreAdjustment: 0,
                technicalReason: 'tech pending: budget selection'
            }, {
                ...buyConfig,
                buyTickers: input.effectiveBuyTickers,
                maxOrderRub: Number.MAX_SAFE_INTEGER
            });

            return {
                ticker: instrument.ticker.toUpperCase(),
                score: analysis?.score ?? -1,
                threshold: (analysis?.factors?.negativeTechRequiredScore ?? buyConfig.buyMinScore) - reach
            };
        })
        .filter((item): item is { ticker: string; score: number; threshold: number } => Boolean(item))
        .sort((a, b) => b.score - a.score);
    const nearThreshold = ranked.filter(item => item.score >= item.threshold).slice(0, maxTickers);
    const selected = nearThreshold.length > 0 ? nearThreshold : ranked.slice(0, maxTickers);

    return selected.map(item => item.ticker);
};

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
        const sectorValueBySector = new Map<string, number>();

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

            const sector = instrumentByUid.get(position.instrumentUid)?.sector?.trim();
            if (sector) {
                sectorValueBySector.set(sector, (sectorValueBySector.get(sector) ?? 0) + positionValueRub);
            }
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
        const buyConfigByUid = new Map(buyInstruments.map(instrument => [
            instrument.uid,
            getBuyScoreConfigForTicker(config, instrument.ticker)
        ]));
        const dailyCandlesByUid = new Map<string, Awaited<ReturnType<typeof marketData.getDailyCandles>> | undefined>();
        const dailyClosesByUid = new Map<string, Awaited<ReturnType<typeof marketData.getDailyClosePrices>> | undefined>();
        const orderBookByUid = new Map<string, Awaited<ReturnType<typeof marketData.getOrderBookMetrics>> | undefined>();
        const orderBookErrorByUid = new Map<string, unknown>();

        const dailyMarketDataPrefetch = Promise.all(buyInstruments.map(async instrument => {
            const buyConfig = buyConfigByUid.get(instrument.uid) ?? config;
            const needsDailyCandles = buyConfig.enabledStrategies.includes('score-buy') || config.liquidityRiskEnabled;
            const needsDailyCloses = buyConfig.enabledStrategies.includes('trend-follow-buy');
            const [dailyCandles, dailyCloses] = await Promise.all([
                needsDailyCandles
                    ? marketData.getDailyCandles(instrument.uid, buyConfig.buyTrendDays).catch(() => undefined)
                    : Promise.resolve(undefined),
                needsDailyCloses
                    ? marketData.getDailyClosePrices(instrument.uid, buyConfig.buyTrendDays).catch(() => undefined)
                    : Promise.resolve(undefined)
            ]);

            dailyCandlesByUid.set(instrument.uid, dailyCandles);
            dailyClosesByUid.set(instrument.uid, dailyCloses);
        }));

        const orderBookEligibleUids = new Set(
            buyInstruments
                .slice(0, Math.max(1, config.orderbookMaxTickers ?? 20))
                .map(instrument => instrument.uid)
        );
        const liquidityRiskPrefetch = config.liquidityRiskEnabled
            ? Promise.all(buyInstruments.map(async instrument => {
                if (!orderBookEligibleUids.has(instrument.uid)) {
                    orderBookErrorByUid.set(instrument.uid, `orderbook skipped: batch limit ${config.orderbookMaxTickers}`);
                    return;
                }

                try {
                    orderBookByUid.set(
                        instrument.uid,
                        await marketData.getOrderBookMetrics(
                            instrument.uid,
                            instrument.lot ?? 1,
                            10,
                            config.orderbookCacheTtlMs
                        )
                    );
                } catch (error) {
                    orderBookErrorByUid.set(instrument.uid, error);
                }
            }))
            : Promise.resolve([]);

        await Promise.all([dailyMarketDataPrefetch, liquidityRiskPrefetch]);
        const analystAdjustments = await BuyScoreAdjustmentService.getAdjustments(
            config,
            buyInstruments.map(instrument => instrument.ticker),
            { includeTechnical: false }
        );
        const technicalTickers = selectTechnicalBudgetTickers({
            config,
            accountId,
            instruments: buyInstruments,
            lastPrices,
            dailyCandlesByUid,
            socialByTicker,
            analystByTicker: analystAdjustments.analyst,
            buyConfigByUid,
            effectiveBuyTickers,
            availableCashRub: remainingCashRub
        });
        const technicalAdjustments = await BuyScoreAdjustmentService.getAdjustments(
            config,
            buyInstruments.map(instrument => instrument.ticker),
            {
                includeAnalyst: false,
                technicalTickers
            }
        );
        const scoreAdjustments = {
            analyst: analystAdjustments.analyst,
            technical: technicalAdjustments.technical
        };
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
            const buyConfig = buyConfigByUid.get(instrument.uid) ?? config;
            const effectiveBuyConfig = {
                ...buyConfig,
                buyTickers: effectiveBuyTickers
            };
            const dailyCandles = dailyCandlesByUid.get(instrument.uid);
            const dailyCloses = dailyClosesByUid.get(instrument.uid);
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
            const preBuyRisk = await PreBuyRiskService.evaluate({
                accountId,
                figi: instrument.figi,
                instrumentUid: instrument.uid,
                ticker: instrument.ticker,
                lot: instrument.lot ?? 1,
                currentPrice: lastPrice,
                estimatedOrderRub: risk.estimatedOrderRub ?? signal?.estimatedOrderRub ?? estimatedOrderRub,
                sector: instrument.sector,
                portfolioValueRub,
                sectorValueRub: instrument.sector ? (sectorValueBySector.get(instrument.sector) ?? 0) : 0,
                dailyCandles,
                orderBookMetrics: orderBookByUid.get(instrument.uid),
                orderBookError: orderBookErrorByUid.get(instrument.uid)
            }, config);
            const allowed = risk.allowed && preBuyRisk.passed;
            let skipReason: string | undefined;

            if (scoreAnalysis && !scoreAnalysis.passed) {
                skipReason = `score-buy blocked: ${scoreAnalysis.reason}`;
            } else if (!marketRegime.passed) {
                skipReason = marketRegime.reason;
            } else if (risk.allowed && !preBuyRisk.passed) {
                skipReason = preBuyRisk.blockingReasons.join('; ');
            }
            const preview: BuySignalPreview = {
                accountId,
                accountAlias,
                figi: instrument.figi,
                instrumentUid: instrument.uid,
                ticker: instrument.ticker,
                name: instrument.name,
                currentPrice: lastPrice,
                estimatedOrderRub: risk.estimatedOrderRub ?? signal?.estimatedOrderRub ?? estimatedOrderRub,
                quantityLots: risk.quantity,
                lot: instrument.lot ?? 1,
                status: allowed ? 'allowed' : 'blocked',
                reason: allowed ? risk.reason : skipReason ?? risk.reason,
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
                portfolioPositionsCount,
                preBuyRisk
            };

            previews.push(preview);

            if (allowed) {
                dailyOrdersCount += 1;
                dailyOrdersRub += risk.estimatedOrderRub ?? 0;
                remainingCashRub -= risk.estimatedOrderRub ?? 0;
            }
        }

        return previews;
    }
}
