import { normalizeRfc3339Timestamp } from '../virtual/codecs';
import { VirtualOrderIntent } from '../virtual/execution';

export interface PostRiskTradeDecision {
    readonly decisionStage: 'post-risk-policy';
    readonly decisionId: string;
    readonly virtualAccountId: string;
    readonly instrumentId: string;
    readonly evaluatedAt: string;
    readonly action: 'buy' | 'sell' | 'hold' | 'skip';
    readonly status: 'allowed' | 'blocked' | 'hold';
    readonly approvedLots?: number;
    readonly source?: string;
    readonly reason: string;
}

export interface ShadowDecisionObservation {
    readonly decisionId: string;
    readonly virtualAccountId: string;
    readonly instrumentId: string;
    readonly evaluatedAt: string;
    readonly action: PostRiskTradeDecision['action'];
    readonly status: PostRiskTradeDecision['status'];
    readonly source?: string;
    readonly reason: string;
    readonly orderId?: string;
}

export interface ShadowIntentAdaptation {
    readonly observation: ShadowDecisionObservation;
    readonly intent?: VirtualOrderIntent;
}

const requireTrimmed = (value: string, field: string) => {
    if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
        throw new TypeError(`${field} must be a trimmed non-empty string`);
    }
};

export const adaptPostRiskDecisionToShadowIntent = (
    decision: PostRiskTradeDecision
): ShadowIntentAdaptation => {
    if (!decision || decision.decisionStage !== 'post-risk-policy') {
        throw new Error('shadow intent requires an explicit post-risk-policy decision');
    }
    requireTrimmed(decision.decisionId, 'decision.decisionId');
    requireTrimmed(decision.virtualAccountId, 'decision.virtualAccountId');
    requireTrimmed(decision.instrumentId, 'decision.instrumentId');
    requireTrimmed(decision.reason, 'decision.reason');
    if (decision.source !== undefined) requireTrimmed(decision.source, 'decision.source');
    const evaluatedAt = normalizeRfc3339Timestamp(decision.evaluatedAt);
    const executable = decision.status === 'allowed'
        && (decision.action === 'buy' || decision.action === 'sell');

    if (!executable) {
        return Object.freeze({
            observation: Object.freeze({
                decisionId: decision.decisionId,
                virtualAccountId: decision.virtualAccountId,
                instrumentId: decision.instrumentId,
                evaluatedAt,
                action: decision.action,
                status: decision.status,
                source: decision.source,
                reason: decision.reason
            })
        });
    }

    if (!Number.isSafeInteger(decision.approvedLots) || (decision.approvedLots ?? 0) <= 0) {
        throw new Error('allowed shadow decision requires positive integer approvedLots');
    }
    const orderId = `shadow:${decision.virtualAccountId}:${decision.decisionId}`;
    const intent: VirtualOrderIntent = Object.freeze({
        id: orderId,
        virtualAccountId: decision.virtualAccountId,
        instrumentId: decision.instrumentId,
        side: decision.action,
        quantityLots: decision.approvedLots as number,
        submittedAt: evaluatedAt
    });
    return Object.freeze({
        observation: Object.freeze({
            decisionId: decision.decisionId,
            virtualAccountId: decision.virtualAccountId,
            instrumentId: decision.instrumentId,
            evaluatedAt,
            action: decision.action,
            status: decision.status,
            source: decision.source,
            reason: decision.reason,
            orderId
        }),
        intent
    });
};
