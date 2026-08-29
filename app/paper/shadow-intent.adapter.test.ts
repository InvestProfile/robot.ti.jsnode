import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    PostRiskTradeDecision,
    adaptPostRiskDecisionToShadowIntent
} from './shadow-intent.adapter';

const allowed = (overrides: Partial<PostRiskTradeDecision> = {}): PostRiskTradeDecision => ({
    decisionStage: 'post-risk-policy',
    decisionId: 'decision-1',
    virtualAccountId: 'experiment-1x',
    instrumentId: 'SBER-uid',
    evaluatedAt: '2026-08-29T13:00:00+03:00',
    action: 'buy',
    status: 'allowed',
    approvedLots: 2,
    source: 'score-buy',
    reason: 'score and all risk gates passed',
    ...overrides
});

describe('post-risk shadow intent adapter', () => {
    it('maps an approved buy to one deterministic immutable virtual intent', () => {
        const result = adaptPostRiskDecisionToShadowIntent(allowed());
        assert.deepEqual(result.intent, {
            id: 'shadow:experiment-1x:decision-1',
            virtualAccountId: 'experiment-1x',
            instrumentId: 'SBER-uid',
            side: 'buy',
            quantityLots: 2,
            submittedAt: '2026-08-29T10:00:00.000Z'
        });
        assert.equal(result.observation.orderId, result.intent?.id);
        assert.ok(Object.isFrozen(result));
        assert.ok(Object.isFrozen(result.intent));
    });

    it('maps the sell-policy approved lots rather than raw position size', () => {
        const result = adaptPostRiskDecisionToShadowIntent(allowed({
            decisionId: 'sell-1', action: 'sell', approvedLots: 1,
            source: 'stop-loss', reason: 'risk and robot-owned lot policy passed'
        }));
        assert.equal(result.intent?.side, 'sell');
        assert.equal(result.intent?.quantityLots, 1);
    });

    it('records blocked, hold and skip decisions without creating orders', () => {
        for (const decision of [
            allowed({ status: 'blocked', reason: 'daily loss guard', approvedLots: undefined }),
            allowed({ action: 'hold', status: 'hold', reason: 'hold-winner', approvedLots: undefined }),
            allowed({ action: 'skip', status: 'blocked', reason: 'no valid price', approvedLots: undefined })
        ]) {
            const result = adaptPostRiskDecisionToShadowIntent(decision);
            assert.equal(result.intent, undefined);
            assert.equal(result.observation.reason, decision.reason);
            assert.equal(result.observation.orderId, undefined);
        }
    });

    it('rejects pre-risk decisions and invalid executable quantities', () => {
        assert.throws(() => adaptPostRiskDecisionToShadowIntent({
            ...allowed(), decisionStage: 'raw-signal' as 'post-risk-policy'
        }), /post-risk-policy/);
        assert.throws(() => adaptPostRiskDecisionToShadowIntent(allowed({ approvedLots: 0 })), /approvedLots/);
        assert.throws(() => adaptPostRiskDecisionToShadowIntent(allowed({ approvedLots: 1.5 })), /approvedLots/);
    });

    it('keeps the same order identity for an exact decision replay', () => {
        const first = adaptPostRiskDecisionToShadowIntent(allowed());
        const replay = adaptPostRiskDecisionToShadowIntent({ ...allowed() });
        assert.equal(replay.intent?.id, first.intent?.id);
        assert.deepEqual(replay, first);
    });
});
