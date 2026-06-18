import { RobotConfig } from '../config/robot.config';
import {
    analyzeBuyQualityRow,
    BuyQualityDecision,
    EntryFactors,
    isStopExit,
    pnlRub
} from '../utils/buy-quality-analysis';
import TradePnlService from './trade-pnl.service';

type RoundTripRow = Record<string, unknown>;

interface EntryStopPattern {
    key: string;
    label: string;
    count: number;
    grossPnlRub: number;
    commissionRub: number;
    netPnlRub: number;
    averageNetPnlRub?: number;
    worstTicker?: string;
    worstNetPnlRub?: number;
    quality: 'good' | 'watch' | 'bad';
}

const toNumber = (value: unknown) => {
    const number = Number(value);
    return Number.isFinite(number) ? number : undefined;
};

const netPnl = (row: RoundTripRow) => toNumber(row.netPnlRub ?? row.pnlRub) ?? 0;

const grossPnl = (row: RoundTripRow) => toNumber(row.grossPnlRub ?? row.pnlRub) ?? 0;

const commission = (row: RoundTripRow) => toNumber(row.commissionRub) ?? 0;

const tickerLabel = (row: RoundTripRow) => String(row.ticker || 'UNKNOWN').toUpperCase();

const sourceLabel = (value: unknown) => String(value || '').toLowerCase();

const dateMs = (value: unknown) => {
    const ms = new Date(String(value || '')).getTime();
    return Number.isFinite(ms) ? ms : undefined;
};

const holdMinutes = (row: RoundTripRow) => {
    const entry = dateMs(row.entryAt);
    const exit = dateMs(row.exitAt);
    if (entry === undefined || exit === undefined || exit < entry) return undefined;
    return Math.round((exit - entry) / 60_000);
};

const holdBucket = (minutes?: number) => {
    if (minutes === undefined) return 'unknown';
    if (minutes < 15) return '<15m';
    if (minutes < 60) return '15-60m';
    if (minutes < 240) return '1-4h';
    if (minutes < 1_440) return '4-24h';
    return '>1d';
};

const scoreBand = (score?: number) => {
    if (score === undefined) return 'unknown';
    if (score < 70) return '<70';
    if (score < 80) return '70-79';
    if (score < 90) return '80-89';
    return '90+';
};

const scoreMarginBand = (factors: EntryFactors) => {
    if (factors.score === undefined || factors.minScore === undefined) return 'unknown';
    const margin = factors.score - factors.minScore;
    if (margin < 0) return 'below threshold';
    if (margin < 5) return '+0..4';
    if (margin < 10) return '+5..9';
    return '+10+';
};

const adjustmentSign = (value?: number) => {
    if (value === undefined) return 'unknown';
    if (value < 0) return 'negative';
    if (value > 0) return 'positive';
    return 'zero';
};

const createPattern = (key: string, label = key): EntryStopPattern => ({
    key,
    label,
    count: 0,
    grossPnlRub: 0,
    commissionRub: 0,
    netPnlRub: 0,
    quality: 'watch'
});

const addToPattern = (pattern: EntryStopPattern, row: RoundTripRow) => {
    const value = netPnl(row);
    pattern.count += 1;
    pattern.grossPnlRub += grossPnl(row);
    pattern.commissionRub += commission(row);
    pattern.netPnlRub += value;

    if (pattern.worstNetPnlRub === undefined || value < pattern.worstNetPnlRub) {
        pattern.worstNetPnlRub = value;
        pattern.worstTicker = tickerLabel(row);
    }
};

const finalizePattern = (pattern: EntryStopPattern) => {
    pattern.averageNetPnlRub = pattern.count > 0 ? pattern.netPnlRub / pattern.count : undefined;
    pattern.quality = pattern.netPnlRub < 0 && pattern.count >= 2
        ? 'bad'
        : pattern.netPnlRub < 0
            ? 'watch'
            : 'good';
    return pattern;
};

const groupBy = (
    rows: { row: RoundTripRow; decision: BuyQualityDecision }[],
    keyFor: (item: { row: RoundTripRow; decision: BuyQualityDecision }) => string,
    labelFor?: (key: string) => string
) => {
    const groups = new Map<string, EntryStopPattern>();

    for (const item of rows) {
        const key = keyFor(item);
        const pattern = groups.get(key) ?? createPattern(key, labelFor?.(key) ?? key);
        addToPattern(pattern, item.row);
        groups.set(key, pattern);
    }

    return [...groups.values()]
        .map(finalizePattern)
        .sort((a, b) => a.netPnlRub - b.netPnlRub);
};

const patternLabels = (decision: BuyQualityDecision, row: RoundTripRow) => {
    const labels = new Set<string>();
    const hold = holdMinutes(row);

    if (decision.nearPeak) labels.add('near high');
    if (decision.factors.technicalScoreAdjustment !== undefined && decision.factors.technicalScoreAdjustment < 0) labels.add('negative tech');
    if ((decision.factors.totalAdjustment ?? 0) >= 5) labels.add('boosted score');
    if (decision.factors.score !== undefined && decision.factors.minScore !== undefined && decision.factors.score - decision.factors.minScore < 5) labels.add('thin score margin');
    if (hold !== undefined && hold < 60) labels.add('fast stop');
    for (const filter of decision.candidateFilters) labels.add(filter);

    return [...labels];
};

const buildOperatorText = (summary: {
    scoreBuyStopExits: number;
    stopDamageNetRub: number;
    nearPeakStopExits: number;
    nearPeakStopDamageNetRub: number;
    negativeTechStopExits: number;
    fastStopExits: number;
    worstPattern?: string;
    worstPatternNetPnlRub?: number;
}) => {
    if (!summary.scoreBuyStopExits) {
        return 'Пока нет закрытых score-buy -> stop-loss пар для анализа входа.';
    }

    if (summary.nearPeakStopDamageNetRub < 0 && summary.nearPeakStopExits > 0) {
        return `Часть stop damage пришла из входов рядом с recent high: ${summary.nearPeakStopExits} стопов, ${summary.nearPeakStopDamageNetRub.toFixed(2)} RUB net.`;
    }

    if (summary.negativeTechStopExits > 0) {
        return `Есть stop exits с отрицательным tech adjustment: ${summary.negativeTechStopExits}. Это кандидат на усиление conflict-gate.`;
    }

    if (summary.fastStopExits > 0) {
        return `Есть быстрые стопы меньше часа: ${summary.fastStopExits}. Это похоже на плохой timing входа или шум сразу после покупки.`;
    }

    if (summary.worstPattern) {
        return `Худший входной паттерн: ${summary.worstPattern}, ${summary.worstPatternNetPnlRub?.toFixed(2)} RUB net.`;
    }

    return `Score-buy stop damage: ${summary.stopDamageNetRub.toFixed(2)} RUB net. Паттерн пока не выделился.`;
};

export default class ExitEntryQualityService {
    static async getExitEntryQuality(config: RobotConfig, limit = 500) {
        const safeLimit = Math.min(Math.max(Number.isFinite(limit) ? Math.trunc(limit) : 500, 1), 2_000);
        const pnl = await TradePnlService.getRoundTripPnl(config, safeLimit);
        const closedRows = (pnl.closedRoundTrips || []) as RoundTripRow[];
        const scoreBuyRows = closedRows
            .filter(row => sourceLabel(row.entrySignalSource) === 'score-buy')
            .map(row => ({
                row,
                decision: analyzeBuyQualityRow(row, config)
            }));
        const scoreBuyStopRows = scoreBuyRows.filter(item => isStopExit(item.row));
        const rowsWithFactors = scoreBuyStopRows.filter(item => item.decision.factors.score !== undefined);
        const missingEntryFactors = scoreBuyStopRows.length - rowsWithFactors.length;
        const nearPeakRows = scoreBuyStopRows.filter(item => item.decision.nearPeak);
        const negativeTechRows = scoreBuyStopRows.filter(item => (item.decision.factors.technicalScoreAdjustment ?? 0) < 0);
        const fastStopRows = scoreBuyStopRows.filter(item => {
            const minutes = holdMinutes(item.row);
            return minutes !== undefined && minutes < 60;
        });
        const byPattern = groupBy(
            scoreBuyStopRows.flatMap(item => {
                const labels = patternLabels(item.decision, item.row);
                return labels.length ? labels.map(label => ({ ...item, patternLabel: label })) : [{ ...item, patternLabel: 'unclassified' }];
            }),
            item => String((item as typeof item & { patternLabel: string }).patternLabel)
        );
        const worstPattern = byPattern[0];
        const stopDamageNetRub = scoreBuyStopRows.reduce((sum, item) => sum + Math.min(0, netPnl(item.row)), 0);
        const nearPeakStopDamageNetRub = nearPeakRows.reduce((sum, item) => sum + Math.min(0, netPnl(item.row)), 0);
        const quality: 'good' | 'watch' | 'bad' = stopDamageNetRub < 0 && (nearPeakRows.length > 0 || negativeTechRows.length > 0 || fastStopRows.length > 0)
            ? 'bad'
            : stopDamageNetRub < 0
                ? 'watch'
                : 'good';

        const summary = {
            scannedTrades: pnl.summary.scannedTrades,
            closedRoundTrips: closedRows.length,
            closedScoreBuyRoundTrips: scoreBuyRows.length,
            scoreBuyStopExits: scoreBuyStopRows.length,
            stopDamageNetRub,
            stopGrossPnlRub: scoreBuyStopRows.reduce((sum, item) => sum + grossPnl(item.row), 0),
            stopCommissionRub: scoreBuyStopRows.reduce((sum, item) => sum + commission(item.row), 0),
            nearPeakStopExits: nearPeakRows.length,
            nearPeakStopDamageNetRub,
            negativeTechStopExits: negativeTechRows.length,
            fastStopExits: fastStopRows.length,
            currentAntiFomoWouldCatch: scoreBuyStopRows.filter(item => item.decision.currentAntiFomoBlocked).length,
            tightRangeWouldCatch: scoreBuyStopRows.filter(item => item.decision.tightRangeBlocked).length,
            pullbackConfirmationWouldCatch: scoreBuyStopRows.filter(item => item.decision.pullbackConfirmationBlocked).length,
            missingEntryFactors,
            accounting: pnl.summary.accounting,
            matchingQuality: pnl.summary.matchingQuality,
            worstPattern: worstPattern?.label,
            worstPatternNetPnlRub: worstPattern?.netPnlRub,
            quality,
            topCause: buildOperatorText({
                scoreBuyStopExits: scoreBuyStopRows.length,
                stopDamageNetRub,
                nearPeakStopExits: nearPeakRows.length,
                nearPeakStopDamageNetRub,
                negativeTechStopExits: negativeTechRows.length,
                fastStopExits: fastStopRows.length,
                worstPattern: worstPattern?.label,
                worstPatternNetPnlRub: worstPattern?.netPnlRub
            })
        };

        return {
            generatedAt: new Date().toISOString(),
            summary,
            breakdowns: {
                byPattern,
                byTicker: groupBy(scoreBuyStopRows, item => tickerLabel(item.row)),
                byHoldTime: groupBy(scoreBuyStopRows, item => holdBucket(holdMinutes(item.row))),
                byScoreBand: groupBy(scoreBuyStopRows, item => scoreBand(item.decision.factors.score)),
                byScoreMargin: groupBy(scoreBuyStopRows, item => scoreMarginBand(item.decision.factors)),
                byTechnicalAdjustment: groupBy(scoreBuyStopRows, item => adjustmentSign(item.decision.factors.technicalScoreAdjustment))
            },
            worstStopEntries: scoreBuyStopRows
                .slice()
                .sort((a, b) => netPnl(a.row) - netPnl(b.row))
                .slice(0, 30)
                .map(item => ({
                    id: item.row.id,
                    ticker: item.row.ticker,
                    name: item.row.name,
                    accountAlias: item.row.accountAlias,
                    entryAt: item.row.entryAt,
                    exitAt: item.row.exitAt,
                    holdMinutes: holdMinutes(item.row),
                    lots: item.row.lots,
                    entryPrice: item.row.entryPrice,
                    exitPrice: item.row.exitPrice,
                    grossPnlRub: item.row.grossPnlRub,
                    commissionRub: item.row.commissionRub,
                    netPnlRub: item.row.netPnlRub ?? pnlRub(item.row),
                    netPnlPercent: item.row.netPnlPercent,
                    entrySignalSource: item.row.entrySignalSource,
                    exitSignalSource: item.row.exitSignalSource,
                    entryDecisionId: item.row.entryDecisionId,
                    exitDecisionId: item.row.exitDecisionId,
                    entryDecisionReason: item.row.entryDecisionReason,
                    exitDecisionReason: item.row.exitDecisionReason,
                    factors: item.decision.factors,
                    flags: {
                        nearPeak: item.decision.nearPeak,
                        losing: item.decision.losing,
                        stopExit: item.decision.stopExit,
                        currentAntiFomoBlocked: item.decision.currentAntiFomoBlocked,
                        tightRangeBlocked: item.decision.tightRangeBlocked,
                        pullbackConfirmationBlocked: item.decision.pullbackConfirmationBlocked
                    },
                    patterns: patternLabels(item.decision, item.row),
                    candidateFilters: item.decision.candidateFilters
                }))
        };
    }
}
