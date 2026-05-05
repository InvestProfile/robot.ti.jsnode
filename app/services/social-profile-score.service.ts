import { Op } from 'sequelize';
import SocialProfileModel from '../models/social-profile.model';
import SocialSignalModel from '../models/social-signal.model';

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

const finite = (value: unknown): value is number =>
    typeof value === 'number' && Number.isFinite(value);

const scoreReturn = (returnPercent: number | null, minReturnPercent: number) => {
    if (!finite(returnPercent)) return 0;
    if (returnPercent < minReturnPercent) return -20;

    return 30 + clamp((returnPercent - minReturnPercent) / 10, 0, 35);
};

const scoreActivity = (activity: number) => clamp(activity, 0, 10);

const scoreManualConfidence = (confidence: number | null) =>
    finite(confidence) ? clamp(confidence * 10, 0, 100) : 0;

const scoreFollowers = (followersCount: number | null) => {
    if (!finite(followersCount) || followersCount <= 0) return 0;
    if (followersCount >= 10_000) return 15;
    if (followersCount >= 5_000) return 13;
    if (followersCount >= 1_000) return 10;
    if (followersCount >= 100) return 5;

    return 1;
};

const scoreMonthOperations = (monthOperationsCount: number | null) => {
    if (!finite(monthOperationsCount) || monthOperationsCount <= 0) return 0;
    if (monthOperationsCount >= 40) return 15;
    if (monthOperationsCount >= 20) return 10;
    if (monthOperationsCount >= 5) return 5;

    return 2;
};

const scoreSignals = (signalsCount: number, buySignalsCount: number, sellSignalsCount: number) => {
    const activityScore = clamp(signalsCount, 0, 10);
    const directionBonus = buySignalsCount > sellSignalsCount ? 3 : 0;

    return activityScore + directionBonus;
};

const statusPenalty = (status: string) => {
    if (status === 'ready') return 0;
    if (status === 'pending-auth') return -10;
    if (status === 'error') return -25;
    return -5;
};

export default class SocialProfileScoreService {
    static async refresh(days = 30) {
        const since = new Date(Date.now() - Math.max(1, days) * 24 * 60 * 60 * 1000);
        const profiles = await SocialProfileModel.findAll({
            order: [['updatedAt', 'DESC']],
            limit: 1000
        });
        const signals = await SocialSignalModel.findAll({
            where: {
                observedAt: { [Op.gte]: since }
            },
            order: [['observedAt', 'DESC']],
            limit: 5000
        });
        const signalsByActor = new Map<string, SocialSignalModel[]>();

        for (const signal of signals) {
            signalsByActor.set(signal.actorKey, [...(signalsByActor.get(signal.actorKey) ?? []), signal]);
        }

        for (const profile of profiles) {
            const profileSignals = signalsByActor.get(profile.profileKey) ?? [];
            const buySignals = profileSignals.filter(signal => signal.action === 'buy').length;
            const sellSignals = profileSignals.filter(signal => signal.action === 'sell').length;
            const manualScore = scoreManualConfidence(profile.confidence);
            const returnScore = scoreReturn(profile.lastReturnPercent, profile.minReturnPercent);
            const activityScore = scoreActivity(profile.activity);
            const followersScore = scoreFollowers(profile.followersCount);
            const monthOperationsScore = scoreMonthOperations(profile.monthOperationsCount);
            const signalScore = scoreSignals(profileSignals.length, buySignals, sellSignals);
            const penalty = statusPenalty(profile.status);
            const autoConfidence = Math.round(clamp(returnScore + followersScore + monthOperationsScore + activityScore + signalScore + penalty, 0, 100));
            const effectiveConfidence = Math.round(clamp(manualScore * 0.45 + autoConfidence * 0.55, 0, 100));
            const reason = [
                `manual=${Math.round(manualScore)}`,
                `auto=${autoConfidence}`,
                `return=${finite(profile.lastReturnPercent) ? profile.lastReturnPercent.toFixed(2) + '%' : '-'}`,
                `followers=${profile.followersCount ?? '-'}`,
                `ops30d=${profile.monthOperationsCount ?? '-'}`,
                `activity=${profile.activity}`,
                `signals${days}d=${profileSignals.length}`,
                `buy=${buySignals}`,
                `sell=${sellSignals}`,
                `status=${profile.status}`
            ].join(', ');

            await profile.update({
                autoConfidence,
                effectiveConfidence,
                recentSignalsCount: profileSignals.length,
                recentBuySignalsCount: buySignals,
                recentSellSignalsCount: sellSignals,
                scoreReason: reason,
                scoreUpdatedAt: new Date()
            });
        }

        return {
            profiles: profiles.length,
            signals: signals.length
        };
    }
}
