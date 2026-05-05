import { Op } from 'sequelize';
import SocialSignalModel from '../models/social-signal.model';

const average = (values: number[]) => values.length > 0
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : undefined;

const clampLimit = (limit: number) => Math.min(Math.max(Math.trunc(limit), 1), 500);

export default class SocialSignalService {
    static async list(limit = 100) {
        const safeLimit = clampLimit(limit);
        const signals = await SocialSignalModel.findAll({
            order: [['observedAt', 'DESC']],
            limit: safeLimit
        });

        return {
            summary: await this.summary(),
            signals: signals.map(signal => signal.toJSON())
        };
    }

    static async summary(days = 30) {
        const since = new Date(Date.now() - Math.max(1, days) * 24 * 60 * 60 * 1000);
        const signals = await SocialSignalModel.findAll({
            where: {
                observedAt: { [Op.gte]: since }
            },
            order: [['observedAt', 'DESC']],
            limit: 2000
        });
        const actorKeys = new Set(signals.map(signal => signal.actorKey));
        const tickers = new Set(signals.map(signal => signal.ticker));
        const actorReturns = signals
            .map(signal => signal.actorReturnPercent)
            .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
        const confidenceValues = signals
            .map(signal => signal.confidence)
            .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
        const byAction = new Map<string, number>();
        const byTicker = new Map<string, { ticker: string; count: number; buy: number; sell: number; watch: number; hold: number }>();

        for (const signal of signals) {
            byAction.set(signal.action, (byAction.get(signal.action) ?? 0) + 1);
            const row = byTicker.get(signal.ticker) ?? {
                ticker: signal.ticker,
                count: 0,
                buy: 0,
                sell: 0,
                watch: 0,
                hold: 0
            };

            row.count += 1;
            if (signal.action === 'buy') row.buy += 1;
            if (signal.action === 'sell') row.sell += 1;
            if (signal.action === 'watch') row.watch += 1;
            if (signal.action === 'hold') row.hold += 1;
            byTicker.set(signal.ticker, row);
        }

        return {
            days,
            signals: signals.length,
            actors: actorKeys.size,
            tickers: tickers.size,
            averageActorReturnPercent: average(actorReturns),
            averageConfidence: average(confidenceValues),
            byAction: Array.from(byAction.entries()).map(([action, count]) => ({ action, count })),
            topTickers: Array.from(byTicker.values()).sort((a, b) => b.count - a.count).slice(0, 20)
        };
    }
}
