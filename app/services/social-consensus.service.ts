import { Op } from 'sequelize';
import SocialProfileModel from '../models/social-profile.model';
import SocialSignalModel, { SocialSignalAction } from '../models/social-signal.model';

export interface SocialConsensusItem {
    ticker: string;
    name?: string;
    mood: 'bullish' | 'bearish' | 'mixed' | 'quiet';
    score: number;
    confidence: number;
    actors: number;
    signals: number;
    buy: number;
    sell: number;
    hold: number;
    watch: number;
    bullishWeight: number;
    bearishWeight: number;
    scoreAdjustment: number;
    lastObservedAt?: Date;
    reason: string;
}

export interface SocialConsensusOptions {
    days?: number;
    maxScoreAdjustment?: number;
    minActors?: number;
    tickers?: string[];
}

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

const getProfileWeight = (profile?: SocialProfileModel) => {
    if (typeof profile?.effectiveConfidence === 'number' && Number.isFinite(profile.effectiveConfidence)) {
        return clamp(profile.effectiveConfidence / 100, 0.1, 1.2);
    }

    if (typeof profile?.confidence === 'number' && Number.isFinite(profile.confidence)) {
        return clamp(profile.confidence / 10, 0.1, 1);
    }

    return 0.5;
};

const getDirection = (action: SocialSignalAction) => {
    if (action === 'buy') return 1;
    if (action === 'sell') return -1;
    return 0;
};

const round = (value: number, precision = 2) => {
    const multiplier = 10 ** precision;
    return Math.round(value * multiplier) / multiplier;
};

export default class SocialConsensusService {
    static async getConsensus(options: SocialConsensusOptions = {}) {
        const days = Math.max(1, Math.trunc(options.days ?? 3));
        const maxScoreAdjustment = Math.max(0, Math.min(25, options.maxScoreAdjustment ?? 10));
        const minActors = Math.max(1, Math.trunc(options.minActors ?? 1));
        const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
        const tickers = options.tickers?.map(ticker => ticker.toUpperCase()).filter(Boolean);
        const signals = await SocialSignalModel.findAll({
            where: {
                observedAt: { [Op.gte]: since },
                ...(tickers?.length ? { ticker: { [Op.in]: tickers } } : {})
            },
            order: [['observedAt', 'DESC']],
            limit: 5000
        });
        const profiles = await SocialProfileModel.findAll({
            where: {
                profileKey: { [Op.in]: Array.from(new Set(signals.map(signal => signal.actorKey))) }
            }
        });
        const profilesByKey = new Map(profiles.map(profile => [profile.profileKey, profile]));
        const groups = new Map<string, {
            ticker: string;
            name?: string;
            actors: Set<string>;
            signals: number;
            buy: number;
            sell: number;
            hold: number;
            watch: number;
            bullishWeight: number;
            bearishWeight: number;
            lastObservedAt?: Date;
        }>();

        for (const signal of signals) {
            const ticker = signal.ticker.toUpperCase();
            const group = groups.get(ticker) ?? {
                ticker,
                name: signal.name ?? undefined,
                actors: new Set<string>(),
                signals: 0,
                buy: 0,
                sell: 0,
                hold: 0,
                watch: 0,
                bullishWeight: 0,
                bearishWeight: 0
            };
            const direction = getDirection(signal.action);
            const profile = profilesByKey.get(signal.actorKey);
            const weight = getProfileWeight(profile);

            group.actors.add(signal.actorKey);
            group.signals += 1;
            group.name = group.name ?? signal.name ?? undefined;
            group.lastObservedAt = group.lastObservedAt && group.lastObservedAt > signal.observedAt
                ? group.lastObservedAt
                : signal.observedAt;

            if (signal.action === 'buy') group.buy += 1;
            if (signal.action === 'sell') group.sell += 1;
            if (signal.action === 'hold') group.hold += 1;
            if (signal.action === 'watch') group.watch += 1;
            if (direction > 0) group.bullishWeight += weight;
            if (direction < 0) group.bearishWeight += weight;

            groups.set(ticker, group);
        }

        const items: SocialConsensusItem[] = Array.from(groups.values()).map(group => {
            const actors = group.actors.size;
            const totalDirectionalWeight = group.bullishWeight + group.bearishWeight;
            const netWeight = group.bullishWeight - group.bearishWeight;
            const score = totalDirectionalWeight > 0 ? Math.round((netWeight / totalDirectionalWeight) * 100) : 0;
            const confidence = totalDirectionalWeight > 0 ? Math.round((Math.abs(netWeight) / totalDirectionalWeight) * 100) : 0;
            const active = actors >= minActors && totalDirectionalWeight > 0;
            const mood = !active
                ? 'quiet'
                : score >= 25
                    ? 'bullish'
                    : score <= -25
                        ? 'bearish'
                        : 'mixed';
            const actorScale = clamp(actors / 2, 0.5, 1);
            const scoreAdjustment = active
                ? Math.round((score / 100) * maxScoreAdjustment * actorScale)
                : 0;

            return {
                ticker: group.ticker,
                name: group.name,
                mood,
                score,
                confidence,
                actors,
                signals: group.signals,
                buy: group.buy,
                sell: group.sell,
                hold: group.hold,
                watch: group.watch,
                bullishWeight: round(group.bullishWeight),
                bearishWeight: round(group.bearishWeight),
                scoreAdjustment,
                lastObservedAt: group.lastObservedAt,
                reason: `social ${mood}: buy ${group.buy}, sell ${group.sell}, actors ${actors}, score ${score}, adjustment ${scoreAdjustment}`
            };
        });

        return {
            days,
            maxScoreAdjustment,
            minActors,
            generatedAt: new Date().toISOString(),
            items: items.sort((a, b) =>
                Math.abs(b.scoreAdjustment) - Math.abs(a.scoreAdjustment)
                || b.signals - a.signals
                || b.confidence - a.confidence
            )
        };
    }

    static async getByTicker(ticker: string, options: SocialConsensusOptions = {}) {
        const result = await this.getConsensus({
            ...options,
            tickers: [ticker]
        });

        return result.items[0];
    }
}
