import type { BuySignalPreview } from './buy-signal-evaluator.service';
import {
    PostRiskTradeDecision,
    ShadowIntentAdaptation,
    adaptPostRiskDecisionToShadowIntent
} from '../paper/shadow-intent.adapter';

export interface ShadowDecisionIdentity {
    readonly decisionId: string;
    readonly virtualAccountId: string;
    readonly evaluatedAt: string;
}

export interface SellBrainShadowItem {
    readonly instrumentUid?: string;
    readonly figi?: string;
    readonly action?: string;
    readonly status?: string;
    readonly source?: string;
    readonly reason?: string;
    readonly orderLots?: number;
}

const instrumentId = (uid?: string, figi?: string) => {
    const value = uid || figi;
    if (!value) throw new Error('shadow decision requires instrumentUid or figi');
    return value;
};

const adapt = (decision: PostRiskTradeDecision): ShadowIntentAdaptation =>
    adaptPostRiskDecisionToShadowIntent(decision);

export const mapBuyPreviewToShadowIntent = (
    preview: BuySignalPreview,
    identity: ShadowDecisionIdentity
) => adapt({
    decisionStage: 'post-risk-policy',
    decisionId: identity.decisionId,
    virtualAccountId: identity.virtualAccountId,
    instrumentId: instrumentId(preview.instrumentUid, preview.figi),
    evaluatedAt: identity.evaluatedAt,
    action: preview.status === 'allowed' ? 'buy' : preview.signal?.action ?? 'skip',
    status: preview.status,
    approvedLots: preview.status === 'allowed' ? preview.quantityLots : undefined,
    source: preview.signal?.source,
    reason: preview.reason
});

export const mapSellBrainItemToShadowIntent = (
    item: SellBrainShadowItem,
    identity: ShadowDecisionIdentity
) => {
    const status: PostRiskTradeDecision['status'] = item.status === 'allowed'
        ? 'allowed'
        : item.status === 'hold'
            ? 'hold'
            : 'blocked';
    const action: PostRiskTradeDecision['action'] = item.action === 'sell'
        ? 'sell'
        : item.action === 'hold'
            ? 'hold'
            : 'skip';
    return adapt({
        decisionStage: 'post-risk-policy',
        decisionId: identity.decisionId,
        virtualAccountId: identity.virtualAccountId,
        instrumentId: instrumentId(item.instrumentUid, item.figi),
        evaluatedAt: identity.evaluatedAt,
        action,
        status,
        approvedLots: status === 'allowed' && action === 'sell' ? item.orderLots : undefined,
        source: item.source,
        reason: item.reason || 'sell-brain produced no reason'
    });
};
