import { RobotConfig } from '../config/robot.config';
import InstrumentsService from './instruments.service';
import MarketDataService from './marketData.service';
import ScoreBuyStrategy from '../strategies/score-buy.strategy';
import { DailyCandle } from '../strategies/trade-signal';

const DEFAULT_WINDOWS = [10, 20, 30];
const DEFAULT_THRESHOLDS = [60, 65, 70, 75, 80];
const DEFAULT_HORIZONS = [3, 5, 10];

type SharesResponse = Awaited<ReturnType<typeof InstrumentsService.getShares>>;
type ShareInstrument = NonNullable<NonNullable<SharesResponse>['instruments']>[number];

interface OptimizationStats {
    count: number;
    winRatePercent?: number;
    averageReturnPercent?: number;
}

const average = (values: number[]) => values.length > 0
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : undefined;

const summarize = (values: number[]): OptimizationStats => {
    const wins = values.filter(value => value > 0).length;

    return {
        count: values.length,
        winRatePercent: values.length > 0 ? (wins / values.length) * 100 : undefined,
        averageReturnPercent: average(values)
    };
};

const parseNumberList = (value: string | undefined, fallback: number[]) => {
    if (!value) return fallback;

    const parsed = value
        .split(',')
        .map(item => Number(item.trim()))
        .filter(item => Number.isFinite(item) && item > 0)
        .map(item => Math.trunc(item));

    return parsed.length > 0 ? parsed : fallback;
};

export default class BuyOptimizerService {
    static parseWindows(value: string | undefined) {
        return parseNumberList(value, DEFAULT_WINDOWS);
    }

    static parseThresholds(value: string | undefined) {
        return parseNumberList(value, DEFAULT_THRESHOLDS);
    }

    static parseHorizons(value: string | undefined) {
        return parseNumberList(value, DEFAULT_HORIZONS);
    }

    static async optimize(
        config: RobotConfig,
        tickers = config.scanTickers,
        days = 180,
        windows = DEFAULT_WINDOWS,
        thresholds = DEFAULT_THRESHOLDS,
        horizons = DEFAULT_HORIZONS
    ) {
        const shares = await InstrumentsService.getShares();
        const instruments = shares?.instruments ?? [];
        const normalizedTickers = tickers.map(ticker => ticker.toUpperCase());
        const selected = normalizedTickers
            .map(ticker => instruments.find(instrument => instrument.ticker?.toUpperCase() === ticker))
            .filter((instrument): instrument is ShareInstrument => Boolean(instrument?.uid && instrument?.figi));
        const missing = normalizedTickers.filter(ticker =>
            !selected.some(instrument => instrument.ticker?.toUpperCase() === ticker)
        );
        const maxWindow = Math.max(...windows);
        const maxHorizon = Math.max(...horizons);
        const items = [];

        for (const instrument of selected) {
            const candles = await MarketDataService.getDailyCandles(
                instrument.uid,
                days + maxWindow + maxHorizon
            );
            const completeCandles = candles
                .filter((candle): candle is DailyCandle => Number.isFinite(candle.close) && candle.close > 0)
                .slice(-(days + maxWindow + maxHorizon));

            for (const window of windows) {
                for (const threshold of thresholds) {
                    const testConfig = {
                        ...config,
                        buyTickers: normalizedTickers,
                        buyTrendDays: window,
                        buyMinScore: threshold,
                        maxOrderRub: Number.MAX_SAFE_INTEGER
                    };
                    const returnsByHorizon = new Map<number, number[]>(
                        horizons.map(horizon => [horizon, []])
                    );
                    let signals = 0;

                    for (let index = window; index < completeCandles.length - maxHorizon; index += 1) {
                        const candle = completeCandles[index];
                        const history = completeCandles.slice(index - window + 1, index + 1);
                        const analysis = ScoreBuyStrategy.analyze({
                            accountId: 'optimize',
                            figi: instrument.figi,
                            instrumentUid: instrument.uid,
                            ticker: instrument.ticker,
                            name: instrument.name,
                            lot: instrument.lot ?? 1,
                            lastPrice: candle.close,
                            availableCashRub: Number.MAX_SAFE_INTEGER,
                            alreadyInPortfolio: false,
                            dailyCandles: history
                        }, testConfig);

                        if (!analysis?.passed) continue;

                        signals += 1;

                        for (const horizon of horizons) {
                            const future = completeCandles[index + horizon];
                            if (future?.close) {
                                returnsByHorizon.get(horizon)?.push((future.close / candle.close - 1) * 100);
                            }
                        }
                    }

                    const horizonStats = horizons.reduce<Record<string, OptimizationStats>>((stats, horizon) => {
                        stats[String(horizon)] = summarize(returnsByHorizon.get(horizon) ?? []);
                        return stats;
                    }, {});
                    const primaryHorizon = horizons.includes(5) ? 5 : horizons[0];
                    const primary = horizonStats[String(primaryHorizon)];

                    items.push({
                        ticker: instrument.ticker,
                        name: instrument.name,
                        window,
                        threshold,
                        signals,
                        primaryHorizon,
                        primaryAverageReturnPercent: primary.averageReturnPercent,
                        primaryWinRatePercent: primary.winRatePercent,
                        horizons: horizonStats
                    });
                }
            }
        }

        return {
            days,
            windows,
            thresholds,
            horizons,
            missing,
            items: items.sort((a, b) =>
                (b.primaryAverageReturnPercent ?? Number.NEGATIVE_INFINITY)
                - (a.primaryAverageReturnPercent ?? Number.NEGATIVE_INFINITY)
            )
        };
    }
}
