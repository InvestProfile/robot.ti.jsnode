import SocialSignalModel, { SocialSignalAction } from '../models/social-signal.model';
import InstrumentsService from './instruments.service';
import MarketDataService from './marketData.service';
import { DailyCandle } from '../strategies/trade-signal';

const HORIZONS = [1, 3, 5, 10] as const;

type Horizon = typeof HORIZONS[number];

const sortCandles = (candles: DailyCandle[]) => candles
    .filter(candle => candle.time && Number.isFinite(candle.close) && candle.close > 0)
    .sort((a, b) => new Date(a.time as Date).getTime() - new Date(b.time as Date).getTime());

const percentChange = (from: number, to: number) => Number.isFinite(from) && from > 0
    ? (to / from - 1) * 100
    : undefined;

const actionMultiplier = (action: SocialSignalAction) => {
    if (action === 'sell') return -1;
    if (action === 'buy') return 1;
    return 0;
};

const average = (values: number[]) => values.length > 0
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : undefined;

const winRate = (values: number[]) => values.length > 0
    ? values.filter(value => value > 0).length / values.length * 100
    : undefined;

const finite = (value: unknown): value is number =>
    typeof value === 'number' && Number.isFinite(value);

const round = (value: number | undefined, digits = 2) => {
    if (value === undefined || !Number.isFinite(value)) return undefined;
    const multiplier = 10 ** digits;
    return Math.round(value * multiplier) / multiplier;
};

interface SocialSignalEvidenceRow {
    id: number;
    observedAt: Date;
    actorKey: string;
    actorName: string | null;
    ticker: string;
    name?: string;
    action: SocialSignalAction;
    signalPrice: number | null;
    confidence: number | null;
    status: string;
    reason: string;
    return1dPercent?: number;
    return3dPercent?: number;
    return5dPercent?: number;
    return10dPercent?: number;
    actionReturn1dPercent?: number;
    actionReturn3dPercent?: number;
    actionReturn5dPercent?: number;
    actionReturn10dPercent?: number;
}

export default class SocialSignalEvidenceService {
    static async getEvidence(limit = 200) {
        const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), 500);
        const signals = await SocialSignalModel.findAll({
            order: [['observedAt', 'DESC']],
            limit: safeLimit
        });
        const shares = await InstrumentsService.getShares();
        const instrumentsByTicker = new Map(
            (shares?.instruments ?? [])
                .filter(instrument => instrument.ticker && instrument.uid)
                .map(instrument => [instrument.ticker.toUpperCase(), instrument])
        );
        const candlesByUid = new Map<string, DailyCandle[]>();
        const rows: SocialSignalEvidenceRow[] = [];

        for (const signal of signals) {
            const ticker = signal.ticker.toUpperCase();
            const instrument = signal.instrumentUid
                ? undefined
                : instrumentsByTicker.get(ticker);
            const instrumentUid = signal.instrumentUid ?? instrument?.uid;
            const signalPrice = signal.price;
            const returns: Partial<Record<`return${Horizon}dPercent`, number>> = {};
            const actionReturns: Partial<Record<`actionReturn${Horizon}dPercent`, number>> = {};
            let status = 'pending';
            let reason = 'waiting for future candles';

            if (!instrumentUid) {
                status = 'skip';
                reason = 'instrument uid is empty';
            } else if (!signalPrice || !Number.isFinite(signalPrice) || signalPrice <= 0) {
                status = 'skip';
                reason = 'signal price is empty';
            } else {
                if (!candlesByUid.has(instrumentUid)) {
                    candlesByUid.set(instrumentUid, sortCandles(await MarketDataService.getDailyCandles(instrumentUid, 45)));
                }

                const candles = candlesByUid.get(instrumentUid) ?? [];
                const observedAt = new Date(signal.observedAt).getTime();
                const futureCandles = candles.filter(candle => new Date(candle.time as Date).getTime() > observedAt);
                const multiplier = actionMultiplier(signal.action);

                for (const horizon of HORIZONS) {
                    const candle = futureCandles[horizon - 1];
                    const value = candle ? percentChange(signalPrice, candle.close) : undefined;

                    if (value !== undefined) {
                        returns[`return${horizon}dPercent`] = round(value);
                        if (multiplier !== 0) {
                            actionReturns[`actionReturn${horizon}dPercent`] = round(value * multiplier);
                        }
                    }
                }

                const measured = HORIZONS.some(horizon => returns[`return${horizon}dPercent`] !== undefined);
                if (measured) {
                    status = 'measured';
                    reason = 'future candles found';
                }
            }

            rows.push({
                id: signal.id,
                observedAt: signal.observedAt,
                actorKey: signal.actorKey,
                actorName: signal.actorName,
                ticker,
                name: signal.name ?? instrument?.name,
                action: signal.action,
                signalPrice,
                confidence: signal.confidence,
                status,
                reason,
                ...returns,
                ...actionReturns
            });
        }

        const directionalRows = rows.filter(row => row.action === 'buy' || row.action === 'sell');
        const summary = HORIZONS.reduce<Record<string, {
            count: number;
            avgReturnPercent?: number;
            avgActionReturnPercent?: number;
            winRatePercent?: number;
        }>>((result, horizon) => {
            const returns = rows
                .map(row => row[`return${horizon}dPercent` as keyof typeof row])
                .filter(finite);
            const actionReturns = directionalRows
                .map(row => row[`actionReturn${horizon}dPercent` as keyof typeof row])
                .filter(finite);

            result[`${horizon}d`] = {
                count: actionReturns.length,
                avgReturnPercent: round(average(returns)),
                avgActionReturnPercent: round(average(actionReturns)),
                winRatePercent: round(winRate(actionReturns), 0)
            };

            return result;
        }, {});

        return {
            generatedAt: new Date().toISOString(),
            signals: rows.length,
            measured: rows.filter(row => row.status === 'measured').length,
            summary,
            rows
        };
    }
}
