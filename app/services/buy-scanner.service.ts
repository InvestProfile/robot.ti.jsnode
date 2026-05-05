import { getBuyScoreConfigForTicker, RobotConfig } from '../config/robot.config';
import InstrumentsService from './instruments.service';
import MarketDataService from './marketData.service';
import ScoreBuyStrategy, { BuyScoreAnalysis } from '../strategies/score-buy.strategy';
import MarketRegimeService from './market-regime.service';
import SocialConsensusService from './social-consensus.service';

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
        const items: BuyScanItem[] = [];

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
            const candles = await MarketDataService.getDailyCandles(instrument.uid, scanConfig.buyTrendDays);
            const social = socialByTicker.get(instrument.ticker.toUpperCase());
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
                socialReason: social?.reason
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
