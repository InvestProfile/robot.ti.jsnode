import { RobotConfig } from '../config/robot.config';
import InstrumentsService from './instruments.service';
import MarketDataService from './marketData.service';
import ScoreBuyStrategy from '../strategies/score-buy.strategy';
import { DailyCandle } from '../strategies/trade-signal';

const DEFAULT_HORIZONS = [1, 3, 5, 10];

type SharesResponse = Awaited<ReturnType<typeof InstrumentsService.getShares>>;
type ShareInstrument = NonNullable<NonNullable<SharesResponse>['instruments']>[number];

interface SignalResult {
    at?: Date;
    close: number;
    score: number;
    returns: Record<string, number>;
}

const average = (values: number[]) => values.length > 0
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : undefined;

const summarizeReturns = (signals: SignalResult[], horizon: number) => {
    const values = signals
        .map(signal => signal.returns[String(horizon)])
        .filter(value => Number.isFinite(value));
    const wins = values.filter(value => value > 0).length;

    return {
        count: values.length,
        winRatePercent: values.length > 0 ? (wins / values.length) * 100 : undefined,
        averageReturnPercent: average(values),
        minReturnPercent: values.length > 0 ? Math.min(...values) : undefined,
        maxReturnPercent: values.length > 0 ? Math.max(...values) : undefined
    };
};

export default class BuyBacktestService {
    static async run(
        config: RobotConfig,
        tickers = config.scanTickers,
        days = 180,
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
        const backtestConfig = {
            ...config,
            buyTickers: normalizedTickers,
            maxOrderRub: Number.MAX_SAFE_INTEGER,
            buyMinScore: config.buyMinScore
        };
        const results = [];

        for (const instrument of selected) {
            const candles = await MarketDataService.getDailyCandles(
                instrument.uid,
                days + config.buyTrendDays + Math.max(...horizons)
            );
            const completeCandles = candles
                .filter((candle): candle is DailyCandle => Number.isFinite(candle.close) && candle.close > 0)
                .slice(-(days + config.buyTrendDays + Math.max(...horizons)));
            const signals: SignalResult[] = [];

            for (let index = config.buyTrendDays; index < completeCandles.length - Math.max(...horizons); index += 1) {
                const candle = completeCandles[index];
                const history = completeCandles.slice(index - config.buyTrendDays + 1, index + 1);
                const analysis = ScoreBuyStrategy.analyze({
                    accountId: 'backtest',
                    figi: instrument.figi,
                    instrumentUid: instrument.uid,
                    ticker: instrument.ticker,
                    name: instrument.name,
                    lot: instrument.lot ?? 1,
                    lastPrice: candle.close,
                    availableCashRub: Number.MAX_SAFE_INTEGER,
                    alreadyInPortfolio: false,
                    dailyCandles: history
                }, backtestConfig);

                if (!analysis?.passed) continue;

                const returns = horizons.reduce<Record<string, number>>((items, horizon) => {
                    const future = completeCandles[index + horizon];
                    if (future?.close) {
                        items[String(horizon)] = (future.close / candle.close - 1) * 100;
                    }

                    return items;
                }, {});

                signals.push({
                    at: candle.time,
                    close: candle.close,
                    score: analysis.score,
                    returns
                });
            }

            const latest = completeCandles[completeCandles.length - 1];
            const latestHistory = completeCandles.slice(-config.buyTrendDays);
            const latestAnalysis = latest
                ? ScoreBuyStrategy.analyze({
                    accountId: 'backtest',
                    figi: instrument.figi,
                    instrumentUid: instrument.uid,
                    ticker: instrument.ticker,
                    name: instrument.name,
                    lot: instrument.lot ?? 1,
                    lastPrice: latest.close,
                    availableCashRub: Number.MAX_SAFE_INTEGER,
                    alreadyInPortfolio: false,
                    dailyCandles: latestHistory
                }, backtestConfig)
                : undefined;

            results.push({
                ticker: instrument.ticker,
                name: instrument.name,
                figi: instrument.figi,
                instrumentUid: instrument.uid,
                candles: completeCandles.length,
                signals: signals.length,
                latestScore: latestAnalysis?.score,
                latestPassed: latestAnalysis?.passed,
                latestReason: latestAnalysis?.reason,
                horizons: horizons.reduce<Record<string, ReturnType<typeof summarizeReturns>>>((items, horizon) => {
                    items[String(horizon)] = summarizeReturns(signals, horizon);
                    return items;
                }, {}),
                recentSignals: signals.slice(-5)
            });
        }

        return {
            minScore: config.buyMinScore,
            trendDays: config.buyTrendDays,
            days,
            horizons,
            missing,
            results
        };
    }
}
