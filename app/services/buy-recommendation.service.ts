import { RobotConfig } from '../config/robot.config';
import BuyScannerService, { BuyScanItem } from './buy-scanner.service';
import BuyCandidateLabService from './buy-candidate-lab.service';

type LabSummary = Awaited<ReturnType<typeof BuyCandidateLabService.getSummary>>;
type LabItem = LabSummary['items'][number];

const BLOCKER_WEIGHTS: Record<string, number> = {
    'daily limit': -4,
    'market regime': -3,
    'score below threshold': -2,
    'already in portfolio': -8,
    'concentration limit': -7,
    'diversification first': -4,
    'trading status': -10,
    'lot too expensive': -6,
    'not enough cash': -5
};

const normalizeBlocker = (value?: string) => {
    const text = String(value ?? '').toLowerCase();
    if (text.includes('daily limit')) return 'daily limit';
    if (text.includes('market')) return 'market regime';
    if (text.includes('score below')) return 'score below threshold';
    if (text.includes('concentration')) return 'concentration limit';
    if (text.includes('diversification')) return 'diversification first';
    if (text.includes('portfolio')) return 'already in portfolio';
    if (text.includes('trading status')) return 'trading status';
    if (text.includes('lot too expensive')) return 'lot too expensive';
    if (text.includes('cash')) return 'not enough cash';
    return value || '-';
};

const getLabBoost = (lab?: LabItem) => {
    if (!lab) return 0;
    if ((lab.allowed ?? 0) > 0) return 5;
    if ((lab.scoreGap ?? 999) <= 2) return 3;
    if ((lab.scoreGap ?? 999) <= 5) return 1;
    return 0;
};

const classify = (score: number, minScore: number, blocker: string, passed?: boolean) => {
    if (blocker === 'already in portfolio') return 'skip-owned';
    if (blocker === 'concentration limit') return 'skip-concentration';
    if (blocker === 'diversification first') return 'watch';
    if (blocker === 'trading status') return 'skip-status';
    if (blocker === 'lot too expensive') return 'skip-expensive';
    if (passed && score >= minScore) return 'buy-candidate';
    if (score >= minScore) return 'wait-market';
    if (score >= minScore - 5) return 'watch';
    if (score >= minScore - 12) return 'scan-only';
    return 'ignore';
};

export default class BuyRecommendationService {
    static async getRecommendations(config: RobotConfig, limit = 30) {
        const [scan, lab] = await Promise.all([
            BuyScannerService.scan(config),
            BuyCandidateLabService.getSummary(24, 100)
        ]);
        const labByTicker = new Map(lab.items.map(item => [item.ticker.toUpperCase(), item]));
        const minScore = scan.minScore ?? config.buyMinScore;

        const items = scan.items.map((item: BuyScanItem) => {
            const ticker = item.ticker.toUpperCase();
            const labItem = labByTicker.get(ticker);
            const score = Math.round((item.score ?? 0) + getLabBoost(labItem));
            const blocker = normalizeBlocker(labItem?.topReason || item.reason);
            const blockerPenalty = BLOCKER_WEIGHTS[blocker] ?? 0;
            const effectiveScore = Math.max(0, Math.min(100, score + blockerPenalty));
            const recommendation = classify(effectiveScore, minScore, blocker, item.passed);

            return {
                ticker: item.ticker,
                name: item.name,
                recommendation,
                score: effectiveScore,
                rawScore: item.score,
                labBoost: getLabBoost(labItem),
                scoreGap: Math.max(0, minScore - effectiveScore),
                lastPrice: item.lastPrice,
                blocker,
                reason: `${recommendation}: score ${effectiveScore}/${minScore}, raw ${item.score ?? '-'}, lab +${getLabBoost(labItem)}, blocker ${blocker}`
            };
        }).sort((a, b) => {
            const order = ['buy-candidate', 'wait-market', 'watch', 'scan-only', 'skip-owned', 'skip-concentration', 'skip-expensive', 'skip-status', 'ignore'];
            const aRank = order.indexOf(a.recommendation);
            const bRank = order.indexOf(b.recommendation);
            if (aRank !== bRank) return aRank - bRank;
            return b.score - a.score;
        }).slice(0, Math.min(Math.max(Math.trunc(limit), 1), 100));

        return {
            generatedAt: new Date().toISOString(),
            minScore,
            marketRegime: scan.marketRegime,
            items
        };
    }
}
