import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    mapBuyPreviewToShadowIntent,
    mapSellBrainItemToShadowIntent
} from './shadow-decision-mapper.service';

const identity = {
    decisionId: 'tick-1:SBER:buy',
    virtualAccountId: 'experiment-1x',
    evaluatedAt: '2026-08-29T10:00:00Z'
};

describe('current pipeline to shadow decision mapping', () => {
    it('uses the buy-preview post-risk quantity only when allowed', () => {
        const allowed = mapBuyPreviewToShadowIntent({
            accountId: 'live-source', instrumentUid: 'SBER-uid', status: 'allowed',
            reason: 'all gates passed', quantityLots: 2, remainingCashRub: 10_000,
            dailyOrdersCount: 0, dailyOrdersRub: 0,
            signal: { action: 'buy', source: 'score-buy', confidence: 0.8, reason: 'score', profitPercent: 0 }
        }, identity);
        assert.equal(allowed.intent?.quantityLots, 2);

        const blocked = mapBuyPreviewToShadowIntent({
            accountId: 'live-source', instrumentUid: 'SBER-uid', status: 'blocked',
            reason: 'daily loss guard', quantityLots: 9, remainingCashRub: 10_000,
            dailyOrdersCount: 3, dailyOrdersRub: 5_000
        }, { ...identity, decisionId: 'tick-2:SBER:buy' });
        assert.equal(blocked.intent, undefined);
        assert.equal(blocked.observation.reason, 'daily loss guard');
    });

    it('uses sell-brain orderLots after robot-owned-lot policy', () => {
        const result = mapSellBrainItemToShadowIntent({
            instrumentUid: 'SBER-uid', action: 'sell', status: 'allowed',
            source: 'stop-loss', reason: 'sell policy allowed one robot lot', orderLots: 1
        }, { ...identity, decisionId: 'tick-3:SBER:sell' });
        assert.equal(result.intent?.side, 'sell');
        assert.equal(result.intent?.quantityLots, 1);
    });

    it('does not turn blocked or hold sell-brain rows into orders', () => {
        const blocked = mapSellBrainItemToShadowIntent({
            figi: 'SBER-figi', action: 'sell', status: 'blocked',
            reason: 'robot-owned lot policy blocked', orderLots: 10
        }, { ...identity, decisionId: 'tick-4:SBER:sell' });
        const hold = mapSellBrainItemToShadowIntent({
            figi: 'SBER-figi', action: 'hold', status: 'hold', reason: 'hold-winner'
        }, { ...identity, decisionId: 'tick-5:SBER:hold' });
        assert.equal(blocked.intent, undefined);
        assert.equal(hold.intent, undefined);
    });
});
