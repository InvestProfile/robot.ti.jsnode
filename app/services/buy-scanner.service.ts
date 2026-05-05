import { RobotConfig } from '../config/robot.config';
import InstrumentsService from './instruments.service';
import MarketDataService from './marketData.service';
import ScoreBuyStrategy, { BuyScoreAnalysis } from '../strategies/score-buy.strategy';

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
        const scanConfig = {
            ...config,
            buyTickers: normalizedTickers,
            maxOrderRub: Number.MAX_SAFE_INTEGER
        };
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

            const candles = await MarketDataService.getDailyCandles(instrument.uid, config.buyTrendDays);
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
                dailyCandles: candles
            }, scanConfig);

            items.push({
                ticker: instrument.ticker,
                name: instrument.name,
                figi: instrument.figi,
                instrumentUid: instrument.uid,
                lastPrice,
                estimatedOrderRub: lastPrice * Math.max(1, instrument.lot ?? 1),
                score: analysis?.score,
                passed: analysis?.passed,
                reason: analysis?.reason ?? 'score analysis is empty',
                analysis
            });
        }

        return {
            minScore: config.buyMinScore,
            trendDays: config.buyTrendDays,
            missing,
            items: items.sort((a, b) => (b.score ?? -1) - (a.score ?? -1))
        };
    }
}
