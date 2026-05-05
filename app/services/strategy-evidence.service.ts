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

            return {
                strategy,
                type: 'entry',
                signals: strategy === 'score-buy' ? buySignals.length : undefined,
                paperPositions: rows.length,
                closed: closed.length,
                winRatePercent: winRate(closedPercents),
                averageProfitPercent: average(closedPercents),
                profitRub: profits.reduce((sum, value) => sum + value, 0),
                commissionRub: fees.reduce((sum, value) => sum + value, 0),
                status: closed.length >= 10 ? 'enough-data' : closed.length >= 3 ? 'watch' : 'learning',
                note: closed.length >= 10
                    ? 'Есть материал для оценки.'
                    : 'Пока мало закрытых paper-сделок, выводы предварительные.'
            };
        });

        const exitRows = Array.from(paperByExit.entries()).map(([strategy, rows]) => {
            const percents = getNumbers(rows, 'profitPercent');
            const profits = getNumbers(rows, 'profitRub');

            return {
                strategy,
                type: 'exit',
                paperPositions: rows.length,
                closed: rows.length,
                winRatePercent: winRate(percents),
                averageProfitPercent: average(percents),
                profitRub: profits.reduce((sum, value) => sum + value, 0),
                status: rows.length >= 10 ? 'enough-data' : rows.length >= 3 ? 'watch' : 'learning',
                note: 'Оценивает только виртуальные закрытия, реальные продажи пока не включены.'
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
            strategies: [...entryRows, ...exitRows, ...decisionRows]
        };
    }
}
