import { Op } from 'sequelize';
import { TradeDecisionModel } from '../models/trade-decision.model';

const SCORE_PATTERN = /(?:score-buy blocked:\s*)?score\s+(\d+)\/(\d+):\s+base\s+(-?\d+),\s+adj\s+(-?\d+),\s+social\s+(-?\d+),\s+analyst\s+(-?\d+),\s+tech\s+(-?\d+)/i;

const parseScoreReason = (reason: string) => {
    const match = reason.match(SCORE_PATTERN);
    if (!match) return undefined;

    return {
        score: Number(match[1]),
        minScore: Number(match[2]),
        baseScore: Number(match[3]),
        totalAdjustment: Number(match[4]),
        socialScoreAdjustment: Number(match[5]),
        analystScoreAdjustment: Number(match[6]),
        technicalScoreAdjustment: Number(match[7])
    };
};

const normalizeReason = (reason: string) => {
    if (reason.includes('instrument is already in portfolio')) return 'already in portfolio';
    if (reason.includes('position concentration limit')) return 'concentration limit';
    if (reason.includes('diversification first')) return 'diversification first';
    if (reason.includes('spread')) return 'spread';
    if (reason.includes('liquidity')) return 'liquidity';
    if (reason.includes('turnover')) return 'daily turnover';
    if (reason.includes('sector')) return 'sector concentration';
    if (reason.includes('daily order limit')) return 'daily limit';
    if (reason.includes('not enough cash')) return 'not enough cash';
    if (reason.includes('estimated lot is above')) return 'lot too expensive';
    if (reason.includes('market')) return 'market regime';
    if (reason.includes('not in normal trading status')) return 'trading status';
    if (reason.includes('score-buy blocked')) return 'score below threshold';
    return reason.slice(0, 80);
};

export default class BuyCandidateLabService {
    static async getSummary(hours = 24, limit = 30) {
        const safeHours = Math.min(Math.max(Math.trunc(hours), 1), 168);
        const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), 100);
        const since = new Date(Date.now() - safeHours * 60 * 60 * 1000);
        const decisions = await TradeDecisionModel.findAll({
            where: {
                createdAt: { [Op.gte]: since },
                accountMode: 'trade',
                ticker: { [Op.ne]: null }
            },
            order: [['createdAt', 'DESC']],
            limit: 3000
        });
        const groups = new Map<string, {
            ticker: string;
            name?: string;
            count: number;
            allowed: number;
            blocked: number;
            bestScore?: number;
            latestScore?: number;
            minScore?: number;
            latestPrice?: number;
            latestAt?: Date;
            baseScore?: number;
            socialScoreAdjustment?: number;
            analystScoreAdjustment?: number;
            technicalScoreAdjustment?: number;
            reasons: Map<string, number>;
        }>();

        for (const decision of decisions) {
            const ticker = decision.ticker?.toUpperCase();
            if (!ticker) continue;

            const parsed = parseScoreReason(decision.reason);
            const existing = groups.get(ticker) ?? {
                ticker,
                name: decision.name,
                count: 0,
                allowed: 0,
                blocked: 0,
                reasons: new Map<string, number>()
            };
            const createdAt = new Date((decision as any).createdAt);
            const status = decision.status;
            const reason = normalizeReason(decision.reason);

            existing.count += 1;
            if (status === 'dry-run' || status === 'order-posted') existing.allowed += 1;
            else existing.blocked += 1;
            existing.reasons.set(reason, (existing.reasons.get(reason) ?? 0) + 1);

            if (!existing.latestAt || createdAt > existing.latestAt) {
                existing.latestAt = createdAt;
                existing.latestPrice = decision.currentPrice;
                if (parsed) {
                    existing.latestScore = parsed.score;
                    existing.minScore = parsed.minScore;
                    existing.baseScore = parsed.baseScore;
                    existing.socialScoreAdjustment = parsed.socialScoreAdjustment;
                    existing.analystScoreAdjustment = parsed.analystScoreAdjustment;
                    existing.technicalScoreAdjustment = parsed.technicalScoreAdjustment;
                }
            }

            if (parsed) {
                existing.bestScore = Math.max(existing.bestScore ?? Number.NEGATIVE_INFINITY, parsed.score);
                existing.minScore = existing.minScore ?? parsed.minScore;
            }

            groups.set(ticker, existing);
        }

        const items = [...groups.values()]
            .map(item => ({
                ticker: item.ticker,
                name: item.name,
                count: item.count,
                allowed: item.allowed,
                blocked: item.blocked,
                bestScore: item.bestScore === Number.NEGATIVE_INFINITY ? undefined : item.bestScore,
                latestScore: item.latestScore,
                minScore: item.minScore,
                scoreGap: item.latestScore !== undefined && item.minScore !== undefined
                    ? item.minScore - item.latestScore
                    : undefined,
                latestPrice: item.latestPrice,
                latestAt: item.latestAt,
                baseScore: item.baseScore,
                socialScoreAdjustment: item.socialScoreAdjustment,
                analystScoreAdjustment: item.analystScoreAdjustment,
                technicalScoreAdjustment: item.technicalScoreAdjustment,
                topReason: [...item.reasons.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '-'
            }))
            .sort((a, b) => {
                const aGap = a.scoreGap ?? Number.POSITIVE_INFINITY;
                const bGap = b.scoreGap ?? Number.POSITIVE_INFINITY;
                if (aGap !== bGap) return aGap - bGap;
                return (b.bestScore ?? -1) - (a.bestScore ?? -1);
            })
            .slice(0, safeLimit);

        return {
            generatedAt: new Date().toISOString(),
            hours: safeHours,
            since: since.toISOString(),
            totalDecisions: decisions.length,
            items
        };
    }
}
