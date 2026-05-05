import { Recommendation } from 'tinkoff-sdk-grpc-js/dist/generated/instruments';
import { RobotConfig } from '../config/robot.config';
import { quotationToNumber } from '../utils/money';
import InstrumentsService from './instruments.service';

type SharesResponse = Awaited<ReturnType<typeof InstrumentsService.getShares>>;
type ShareInstrument = NonNullable<NonNullable<SharesResponse>['instruments']>[number];

const recommendationLabel = (recommendation: Recommendation | undefined) => {
    switch (recommendation) {
        case Recommendation.RECOMMENDATION_BUY:
            return 'buy';
        case Recommendation.RECOMMENDATION_HOLD:
            return 'hold';
        case Recommendation.RECOMMENDATION_SELL:
            return 'sell';
        default:
            return 'unspecified';
    }
};

const toPercent = (value: number | undefined) => {
    if (value === undefined || !Number.isFinite(value)) return undefined;
    return Math.abs(value) <= 1 ? value * 100 : value;
};

const findInstrument = (instruments: ShareInstrument[], ticker: string) =>
    instruments.find(instrument => instrument.ticker?.toUpperCase() === ticker.toUpperCase());

export default class AnalystForecastService {
    static async getForecasts(config: RobotConfig, tickers = config.buyTickers) {
        const shares = await InstrumentsService.getShares();
        const instruments = shares?.instruments ?? [];
        const normalizedTickers = tickers.map(ticker => ticker.trim().toUpperCase()).filter(Boolean);
        const items = [];
        const missing = [];

        for (const ticker of normalizedTickers) {
            const instrument = findInstrument(instruments, ticker);

            if (!instrument?.uid) {
                missing.push(ticker);
                continue;
            }

            try {
                const forecast = await InstrumentsService.getForecastBy(instrument.uid);
                const consensus = forecast?.consensus;
                const currentPrice = quotationToNumber(consensus?.currentPrice);
                const targetPrice = quotationToNumber(consensus?.consensus);
                const priceChange = quotationToNumber(consensus?.priceChange);
                const priceChangePercent = toPercent(quotationToNumber(consensus?.priceChangeRel));
                const targets = forecast?.targets ?? [];

                items.push({
                    ticker: instrument.ticker,
                    name: instrument.name,
                    figi: instrument.figi,
                    instrumentUid: instrument.uid,
                    currency: consensus?.currency || instrument.currency,
                    recommendation: recommendationLabel(consensus?.recommendation),
                    currentPrice,
                    targetPrice,
                    minTarget: quotationToNumber(consensus?.minTarget),
                    maxTarget: quotationToNumber(consensus?.maxTarget),
                    priceChange,
                    priceChangePercent,
                    targetCount: targets.length,
                    buyCount: targets.filter(target => target.recommendation === Recommendation.RECOMMENDATION_BUY).length,
                    holdCount: targets.filter(target => target.recommendation === Recommendation.RECOMMENDATION_HOLD).length,
                    sellCount: targets.filter(target => target.recommendation === Recommendation.RECOMMENDATION_SELL).length,
                    prognosisDate: targets
                        .map(target => target.recommendationDate)
                        .filter((date): date is Date => Boolean(date))
                        .sort((a, b) => b.getTime() - a.getTime())[0],
                    targets: targets.map(target => ({
                        company: target.company,
                        recommendation: recommendationLabel(target.recommendation),
                        recommendationDate: target.recommendationDate,
                        currentPrice: quotationToNumber(target.currentPrice),
                        targetPrice: quotationToNumber(target.targetPrice),
                        priceChange: quotationToNumber(target.priceChange),
                        priceChangePercent: toPercent(quotationToNumber(target.priceChangeRel))
                    }))
                });
            } catch (error) {
                items.push({
                    ticker: instrument.ticker,
                    name: instrument.name,
                    figi: instrument.figi,
                    instrumentUid: instrument.uid,
                    recommendation: 'error',
                    targetCount: 0,
                    reason: error instanceof Error ? error.message : String(error)
                });
            }
        }

        return {
            generatedAt: new Date().toISOString(),
            tickers: normalizedTickers,
            missing,
            items
        };
    }
}
