import { getBuyScoreConfigForTicker, RobotConfig } from '../config/robot.config';
import InstrumentsService from './instruments.service';
import MarketDataService from './marketData.service';
import ScoreBuyStrategy, { BuyScoreAnalysis } from '../strategies/score-buy.strategy';
import MarketRegimeService from './market-regime.service';
import SocialConsensusService from './social-consensus.service';
import BuyScoreAdjustmentService from './buy-score-adjustment.service';

type SharesResponse = Awaited<ReturnType<typeof InstrumentsService.getShares>>;
type ShareInstrument = NonNullable<NonNullable<SharesResponse>['instruments']>[number];

export interface BuyScanItem {
    ticker: string;
    name?: string;
    figi?: string;
    instrumentUid?: string;
    lastPrice?: number;
    estimatedOrderRub?: number;
    score?: number;
    passed?: boolean;
    reason: string;
    profile?: {
        trendDays: number;
        minScore: number;
    };
    analysis?: BuyScoreAnalysis;
}

export default class BuyScannerService {
    static async scan(config: RobotConfig, tickers = config.scanTickers) {
        const shares = await InstrumentsService.getShares();
        const instruments = shares?.instruments ?? [];
        const normalizedTickers = tickers.map(ticker => ticker.toUpperCase());
        const selected = normalizedTickers
            .map(ticker => instruments.find(instrument => instrument.ticker?.toUpperCase() === ticker))
            .filter((instrument): instrument is ShareInstrument => Boolean(instrument?.uid && instrument?.figi));
        const missing = normalizedTickers.filter(ticker =>
            !selected.some(instrument => instrument.ticker?.toUpperCase() === ticker)
        );
        const prices = await MarketDataService.getLastPrices(selected.map(instrument => instrument.uid));
        const marketRegime = await MarketRegimeService.evaluate(config);
        const socialConsensus = config.socialConsensusEnabled
            ? await SocialConsensusService.getConsensus({
                days: config.socialConsensusDays,
                maxScoreAdjustment: config.socialConsensusMaxScoreAdjustment,
                minActors: config.socialConsensusMinActors,
                tickers: selected.map(instrument => instrument.ticker)
            })
            : undefined;
        const socialByTicker = new Map(
            socialConsensus?.items.map(item => [item.ticker, item]) ?? []
        );
        const analystAdjustments = await BuyScoreAdjustmentService.getAdjustments(
            config,
            selected.map(instrument => instrument.ticker),
            { includeTechnical: false }
        );
        const candlesByUid = new Map<string, Awaited<ReturnType<typeof MarketDataService.getDailyCandles>> | undefined>();
        const items: BuyScanItem[] = [];

        for (const instrument of selected) {
            const lastPrice = prices.get(instrument.uid);

            if (!lastPrice) continue;

            const baseScanConfig = getBuyScoreConfigForTicker(config, instrument.ticker);
            const scanConfig = {
                ...baseScanConfig,
                buyTickers: normalizedTickers,
                maxOrderRub: Number.MAX_SAFE_INTEGER
            };
            const candles = await MarketDataService.getDailyCandles(instrument.uid, scanConfig.buyTrendDays)
                .catch(() => undefined);
            candlesByUid.set(instrument.uid, candles);
        }

        const maxTechnicalTickers = Math.max(1, config.technicalAnalysisMaxTickers ?? 40);
        const technicalReach = Math.max(5, config.technicalMaxScoreAdjustment ?? 0);
        const technicalTickers = selected
            .map(instrument => {
                const lastPrice = prices.get(instrument.uid);
                if (!lastPrice) return undefined;

                const baseScanConfig = getBuyScoreConfigForTicker(config, instrument.ticker);
                const scanConfig = {
                    ...baseScanConfig,
                    buyTickers: normalizedTickers,
                    maxOrderRub: Number.MAX_SAFE_INTEGER
                };
                const social = socialByTicker.get(instrument.ticker.toUpperCase());
                const analyst = analystAdjustments.analyst.get(instrument.ticker.toUpperCase());
                const analysis = ScoreBuyStrategy.analyze({
                    accountId: 'scan',
                    figi: instrument.figi,
                    instrumentUid: instrument.uid,
                    ticker: instrument.ticker,
                    name: instrument.name,
                    lot: instrument.lot ?? 1,
                    lastPrice,
                    availableCashRub: Number.MAX_SAFE_INTEGER,
                    alreadyInPortfolio: false,
                    dailyCandles: candlesByUid.get(instrument.uid),
                    socialScoreAdjustment: social?.scoreAdjustment,
                    socialScore: social?.score,
                    socialMood: social?.mood,
                    socialReason: social?.reason,
                    analystScoreAdjustment: analyst?.adjustment,
                    analystReason: analyst?.reason,
                    technicalScoreAdjustment: 0,
                    technicalReason: 'tech pending: budget selection'
                }, scanConfig);

                return {
                    ticker: instrument.ticker.toUpperCase(),
                    score: analysis?.score ?? -1,
                    threshold: (analysis?.factors?.negativeTechRequiredScore ?? scanConfig.buyMinScore) - technicalReach
                };
            })
            .filter((item): item is { ticker: string; score: number; threshold: number } => Boolean(item))
            .sort((a, b) => b.score - a.score)
            .filter((item, index) => item.score >= item.threshold || index < maxTechnicalTickers)
            .slice(0, maxTechnicalTickers)
            .map(item => item.ticker);
        const technicalAdjustments = await BuyScoreAdjustmentService.getAdjustments(
            config,
            selected.map(instrument => instrument.ticker),
            {
                includeAnalyst: false,
                technicalTickers
            }
        );
        const scoreAdjustments = {
            analyst: analystAdjustments.analyst,
            technical: technicalAdjustments.technical
        };

        for (const instrument of selected) {
            const lastPrice = prices.get(instrument.uid);

            if (!lastPrice) {
                items.push({
                    ticker: instrument.ticker,
                    name: instrument.name,
                    figi: instrument.figi,
                    instrumentUid: instrument.uid,
                    reason: 'last price is empty'
                });
                continue;
            }

            const baseScanConfig = getBuyScoreConfigForTicker(config, instrument.ticker);
            const scanConfig = {
                ...baseScanConfig,
                buyTickers: normalizedTickers,
                maxOrderRub: Number.MAX_SAFE_INTEGER
            };
            const candles = candlesByUid.get(instrument.uid);
            const social = socialByTicker.get(instrument.ticker.toUpperCase());
            const analyst = scoreAdjustments.analyst.get(instrument.ticker.toUpperCase());
            const technical = scoreAdjustments.technical.get(instrument.ticker.toUpperCase());
            const analysis = ScoreBuyStrategy.analyze({
                accountId: 'scan',
                figi: instrument.figi,
                instrumentUid: instrument.uid,
                ticker: instrument.ticker,
                name: instrument.name,
                lot: instrument.lot ?? 1,
                lastPrice,
                availableCashRub: Number.MAX_SAFE_INTEGER,
                alreadyInPortfolio: false,
                dailyCandles: candles,
                socialScoreAdjustment: social?.scoreAdjustment,
                socialScore: social?.score,
                socialMood: social?.mood,
                socialReason: social?.reason,
                analystScoreAdjustment: analyst?.adjustment,
                analystReason: analyst?.reason,
                technicalScoreAdjustment: technical?.adjustment,
                technicalReason: technical?.reason
            }, scanConfig);

            items.push({
                ticker: instrument.ticker,
                name: instrument.name,
                figi: instrument.figi,
                instrumentUid: instrument.uid,
                lastPrice,
                estimatedOrderRub: lastPrice * Math.max(1, instrument.lot ?? 1),
                score: analysis?.score,
                passed: Boolean(analysis?.passed && marketRegime.passed),
                reason: analysis?.passed && !marketRegime.passed
                    ? marketRegime.reason
                    : analysis?.reason ?? 'score analysis is empty',
                profile: {
                    trendDays: scanConfig.buyTrendDays,
                    minScore: scanConfig.buyMinScore
                },
                analysis
            });
        }

        return {
            minScore: config.buyMinScore,
            trendDays: config.buyTrendDays,
            profiles: config.buyScoreProfiles,
            marketRegime,
            missing,
            items: items.sort((a, b) => (b.score ?? -1) - (a.score ?? -1))
        };
    }
}
