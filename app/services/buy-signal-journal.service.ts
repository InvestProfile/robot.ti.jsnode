import { RobotConfig } from '../config/robot.config';
import BuySignalJournalModel from '../models/buy-signal-journal.model';
import BuyScannerService from './buy-scanner.service';
import MarketDataService from './marketData.service';
import { DailyCandle } from '../strategies/trade-signal';

const HORIZONS = [1, 3, 5, 10] as const;

type Horizon = typeof HORIZONS[number];

const returnFieldByHorizon: Record<Horizon, keyof BuySignalJournalModel> = {
    1: 'return1dPercent',
    3: 'return3dPercent',
    5: 'return5dPercent',
    10: 'return10dPercent'
};

const getSignalDay = (date: Date) => date.toISOString().slice(0, 10);

const getSignalKey = (ticker: string, date: Date, trendDays: number, minScore: number) =>
    [ticker.toUpperCase(), getSignalDay(date), trendDays, minScore].join(':');

const sortCandles = (candles: DailyCandle[]) => candles
    .filter(candle => candle.time && Number.isFinite(candle.close) && candle.close > 0)
    .sort((a, b) => new Date(a.time as Date).getTime() - new Date(b.time as Date).getTime());

const calculateReturnPercent = (from: number, to: number) => (to / from - 1) * 100;

export default class BuySignalJournalService {
    static async capture(config: RobotConfig) {
        if (config.scanTickers.length === 0) return { captured: 0, updated: 0 };

        const now = new Date();
        const scan = await BuyScannerService.scan(config, config.scanTickers);
        let captured = 0;

        for (const item of scan.items) {
            if (!item.passed || !item.instrumentUid || !item.lastPrice || item.score === undefined) continue;

            const trendDays = item.profile?.trendDays ?? config.buyTrendDays;
            const minScore = item.profile?.minScore ?? config.buyMinScore;
            const signalKey = getSignalKey(item.ticker, now, trendDays, minScore);
            const [record, created] = await BuySignalJournalModel.findOrCreate({
                where: { signalKey },
                defaults: {
                    signalKey,
                    ticker: item.ticker,
                    name: item.name,
                    figi: item.figi,
                    instrumentUid: item.instrumentUid,
                    signaledAt: now,
                    signalPrice: item.lastPrice,
                    signalScore: item.score,
                    profileTrendDays: trendDays,
                    profileMinScore: minScore,
                    reason: item.reason
                }
            });

            if (created) {
                captured += 1;
                console.log(`BUY_SIGNAL_JOURNAL captured ${record.ticker} score=${record.signalScore} price=${record.signalPrice}`);
            }
        }

        const updated = await this.updatePending();

        return { captured, updated };
    }

    static async updatePending() {
        const records = await BuySignalJournalModel.findAll({
            where: { completedAt: null },
            order: [['signaledAt', 'ASC']],
            limit: 250
        });
        let updated = 0;

        for (const record of records) {
            const candles = sortCandles(await MarketDataService.getDailyCandles(record.instrumentUid, 45));
            const signaledAt = new Date(record.signaledAt).getTime();
            const futureCandles = candles.filter(candle => new Date(candle.time as Date).getTime() > signaledAt);
            const patch: Partial<BuySignalJournalModel> = {
                checkedAt: new Date()
            };

            for (const horizon of HORIZONS) {
                const field = returnFieldByHorizon[horizon];
                const alreadySet = record[field];

                if (typeof alreadySet === 'number') continue;

                const candle = futureCandles[horizon - 1];
                if (candle) {
                    (patch as Record<string, unknown>)[field] = calculateReturnPercent(record.signalPrice, candle.close);
                }
            }

            if (typeof (patch as Record<string, unknown>).return10dPercent === 'number' || typeof record.return10dPercent === 'number') {
                patch.completedAt = new Date();
            }

            await record.update(patch);
            updated += 1;
        }

        return updated;
    }

    static async list(limit = 100) {
        const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), 500);
        const signals = await BuySignalJournalModel.findAll({
            order: [['signaledAt', 'DESC']],
            limit: safeLimit
        });

        return {
            signals: signals.map(signal => signal.toJSON())
        };
    }
}
