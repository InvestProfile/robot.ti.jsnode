import BuySignalJournalModel from '../models/buy-signal-journal.model';
import PaperPositionModel from '../models/paper-position.model';
import { TradeDecisionModel } from '../models/trade-decision.model';
import SocialSignalService from './social-signal.service';

type NumberKey<T> = {
    [K in keyof T]: T[K] extends number | null ? K : never
}[keyof T];

const average = (values: number[]) => values.length > 0
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : undefined;

const winRate = (values: number[]) => values.length > 0
    ? values.filter(value => value > 0).length / values.length * 100
    : undefined;

const finite = (value: unknown): value is number =>
    typeof value === 'number' && Number.isFinite(value);

const getNumbers = <T>(items: T[], key: NumberKey<T>) =>
    items.map(item => item[key]).filter(finite);

const getEntrySource = (position: PaperPositionModel) => {
    const reason = String(position.entryReason ?? '');
    if (reason.startsWith('score ')) return 'score-buy';
    if (reason.includes('trend')) return 'trend-follow-buy';
    return 'paper-entry';
};

const getConfidence = (closed: number, winRatePercent: number | undefined, averageProfitPercent: number | undefined) => {
    const sampleScore = Math.min(60, closed * 6);
    const winScore = winRatePercent === undefined ? 0 : Math.max(0, Math.min(25, (winRatePercent - 40) * 0.8));
    const avgScore = averageProfitPercent === undefined ? 0 : Math.max(0, Math.min(15, averageProfitPercent * 10));

    return Math.round(sampleScore + winScore + avgScore);
};

const getStrategyStatus = (confidence: number) => {
    if (confidence >= 75) return 'enough-data';
    if (confidence >= 40) return 'watch';
    return 'learning';
};

const getRecommendation = (status: string) => {
    if (status === 'enough-data') return 'Можно рассматривать для осторожного live-расширения, если risk limits тоже зеленые.';
    if (status === 'watch') return 'Стратегия выглядит интересно, но ей нужно больше закрытых сделок.';
    return 'Собирать данные, не увеличивать риск.';
};

export default class StrategyEvidenceService {
    static async getEvidence() {
        const [buySignals, paperPositions, decisions, socialSummary] = await Promise.all([
            BuySignalJournalModel.findAll({ order: [['signaledAt', 'DESC']], limit: 2000 }),
            PaperPositionModel.findAll({ order: [['openedAt', 'DESC']], limit: 2000 }),
            TradeDecisionModel.findAll({ order: [['createdAt', 'DESC']], limit: 2000 }),
            SocialSignalService.summary(30)
        ]);
        const buyReturn1d = getNumbers(buySignals, 'return1dPercent');
        const buyReturn3d = getNumbers(buySignals, 'return3dPercent');
        const buyReturn5d = getNumbers(buySignals, 'return5dPercent');
        const buyReturn10d = getNumbers(buySignals, 'return10dPercent');
        const paperByEntry = new Map<string, PaperPositionModel[]>();
        const paperByExit = new Map<string, PaperPositionModel[]>();
        const decisionsBySource = new Map<string, TradeDecisionModel[]>();

        for (const position of paperPositions) {
            const entrySource = getEntrySource(position);
            paperByEntry.set(entrySource, [...(paperByEntry.get(entrySource) ?? []), position]);
            if (position.exitSource) {
                paperByExit.set(position.exitSource, [...(paperByExit.get(position.exitSource) ?? []), position]);
            }
        }

        for (const decision of decisions) {
            const source = decision.signalSource || 'unknown';
            decisionsBySource.set(source, [...(decisionsBySource.get(source) ?? []), decision]);
        }

        const entryRows = Array.from(paperByEntry.entries()).map(([strategy, rows]) => {
            const closed = rows.filter(row => row.status === 'closed');
            const profits = getNumbers(rows, 'profitRub');
            const closedPercents = getNumbers(closed, 'profitPercent');
            const fees = getNumbers(rows, 'totalCommissionRub');
            const wr = winRate(closedPercents);
            const avg = average(closedPercents);
            const confidence = getConfidence(closed.length, wr, avg);
            const status = getStrategyStatus(confidence);

            return {
                strategy,
                type: 'entry',
                signals: strategy === 'score-buy' ? buySignals.length : undefined,
                paperPositions: rows.length,
                closed: closed.length,
                winRatePercent: wr,
                averageProfitPercent: avg,
                profitRub: profits.reduce((sum, value) => sum + value, 0),
                commissionRub: fees.reduce((sum, value) => sum + value, 0),
                confidence,
                status,
                note: getRecommendation(status)
            };
        });

        const exitRows = Array.from(paperByExit.entries()).map(([strategy, rows]) => {
            const percents = getNumbers(rows, 'profitPercent');
            const profits = getNumbers(rows, 'profitRub');
            const wr = winRate(percents);
            const avg = average(percents);
            const confidence = getConfidence(rows.length, wr, avg);
            const status = getStrategyStatus(confidence);

            return {
                strategy,
                type: 'exit',
                paperPositions: rows.length,
                closed: rows.length,
                winRatePercent: wr,
                averageProfitPercent: avg,
                profitRub: profits.reduce((sum, value) => sum + value, 0),
                confidence,
                status,
                note: getRecommendation(status)
            };
        });

        const decisionRows = Array.from(decisionsBySource.entries()).map(([strategy, rows]) => ({
            strategy,
            type: 'decision',
            decisions: rows.length,
            dryRun: rows.filter(row => row.status === 'dry-run').length,
            skipped: rows.filter(row => row.status === 'skip').length,
            orders: rows.filter(row => row.status === 'order-posted').length
        }));

        return {
            generatedAt: new Date().toISOString(),
            buySignalJournal: {
                signals: buySignals.length,
                return1d: { count: buyReturn1d.length, avg: average(buyReturn1d), winRatePercent: winRate(buyReturn1d) },
                return3d: { count: buyReturn3d.length, avg: average(buyReturn3d), winRatePercent: winRate(buyReturn3d) },
                return5d: { count: buyReturn5d.length, avg: average(buyReturn5d), winRatePercent: winRate(buyReturn5d) },
                return10d: { count: buyReturn10d.length, avg: average(buyReturn10d), winRatePercent: winRate(buyReturn10d) }
            },
            socialAlpha: socialSummary,
            recommendation: {
                minClosedTradesForLive: 10,
                minConfidenceForLive: 75,
                note: 'Evidence не включает live сам по себе. Он только показывает, какие стратегии заслужили больше доверия.'
            },
            strategies: [...entryRows, ...exitRows, ...decisionRows]
        };
    }
}
