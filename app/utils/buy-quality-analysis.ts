export interface BuyQualityConfig {
    buyAntiFomoMaxMomentumPercent: number;
    buyAntiFomoMinBelowHighPercent: number;
    buyAntiFomoMaxRangeMultiplier: number;
}

export interface EntryFactors {
    score?: number;
    minScore?: number;
    baseScore?: number;
    totalAdjustment?: number;
    socialScoreAdjustment?: number;
    analystScoreAdjustment?: number;
    technicalScoreAdjustment?: number;
    trendPercent?: number;
    momentumPercent?: number;
    belowHighPercent?: number;
    volatilityPercent?: number;
}

export interface BuyQualityRow {
    entryDecisionReason?: unknown;
    exitSignalSource?: unknown;
    exitDecisionReason?: unknown;
    netPnlRub?: unknown;
    grossPnlRub?: unknown;
    pnlRub?: unknown;
}

export interface BuyQualityDecision {
    factors: EntryFactors;
    nearPeak: boolean;
    stopExit: boolean;
    losing: boolean;
    currentAntiFomoBlocked: boolean;
    tightRangeBlocked: boolean;
    pullbackConfirmationBlocked: boolean;
    candidateFilters: string[];
}

const toNumber = (value: unknown) => {
    const number = Number(value);
    return Number.isFinite(number) ? number : undefined;
};

const parseNumberAfter = (reason: unknown, label: string) => {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = String(reason || '').match(new RegExp(`${escaped}\\s+(-?\\d+(?:\\.\\d+)?)`, 'i'));

    return match ? toNumber(match[1]) : undefined;
};

export const parseEntryFactors = (reason: unknown): EntryFactors => {
    const scoreMatch = String(reason || '').match(/score\s+(-?\d+(?:\.\d+)?)(?:\/(-?\d+(?:\.\d+)?))?/i);

    return {
        score: scoreMatch ? toNumber(scoreMatch[1]) : undefined,
        minScore: scoreMatch?.[2] ? toNumber(scoreMatch[2]) : undefined,
        baseScore: parseNumberAfter(reason, 'base'),
        totalAdjustment: parseNumberAfter(reason, 'adj'),
        socialScoreAdjustment: parseNumberAfter(reason, 'social'),
        analystScoreAdjustment: parseNumberAfter(reason, 'analyst'),
        technicalScoreAdjustment: parseNumberAfter(reason, 'tech'),
        trendPercent: parseNumberAfter(reason, 'trend'),
        momentumPercent: parseNumberAfter(reason, 'momentum'),
        belowHighPercent: parseNumberAfter(reason, 'below high'),
        volatilityPercent: parseNumberAfter(reason, 'volatility')
    };
};

export const isStopExit = (row: BuyQualityRow) => {
    const text = `${row.exitSignalSource || ''} ${row.exitDecisionReason || ''}`.toLowerCase();
    return text.includes('stop-loss');
};

export const pnlRub = (row: BuyQualityRow) =>
    toNumber(row.netPnlRub ?? row.grossPnlRub ?? row.pnlRub);

export const analyzeBuyQualityRow = (
    row: BuyQualityRow,
    config: BuyQualityConfig
): BuyQualityDecision => {
    const factors = parseEntryFactors(row.entryDecisionReason);
    const nearPeak = factors.belowHighPercent !== undefined
        && factors.belowHighPercent <= config.buyAntiFomoMinBelowHighPercent;
    const stopExit = isStopExit(row);
    const pnl = pnlRub(row);
    const losing = pnl !== undefined && pnl < 0;
    const rangeLimit = factors.volatilityPercent !== undefined
        ? factors.volatilityPercent * config.buyAntiFomoMaxRangeMultiplier
        : undefined;
    const currentAntiFomoBlocked = Boolean(
        nearPeak
        && factors.momentumPercent !== undefined
        && (
            factors.momentumPercent > config.buyAntiFomoMaxMomentumPercent
            || (rangeLimit !== undefined && factors.momentumPercent > rangeLimit)
        )
    );
    const tightRangeBlocked = Boolean(
        nearPeak
        && factors.momentumPercent !== undefined
        && factors.volatilityPercent !== undefined
        && factors.momentumPercent > factors.volatilityPercent
    );
    const pullbackConfirmationBlocked = Boolean(
        nearPeak
        && factors.momentumPercent !== undefined
        && factors.momentumPercent > 0
    );
    const candidateFilters = [
        currentAntiFomoBlocked ? 'current anti-FOMO' : undefined,
        !currentAntiFomoBlocked && tightRangeBlocked ? 'range x1.0' : undefined,
        !currentAntiFomoBlocked && !tightRangeBlocked && pullbackConfirmationBlocked ? 'pullback/confirmation' : undefined
    ].filter((value): value is string => Boolean(value));

    return {
        factors,
        nearPeak,
        stopExit,
        losing,
        currentAntiFomoBlocked,
        tightRangeBlocked,
        pullbackConfirmationBlocked,
        candidateFilters
    };
};
