import { describe, it } from 'node:test';
import assert from 'node:assert';
import { analyzeBuyQualityRow, parseEntryFactors } from './buy-quality-analysis';

const config = {
    buyAntiFomoMaxMomentumPercent: 3,
    buyAntiFomoMinBelowHighPercent: 1,
    buyAntiFomoMaxRangeMultiplier: 1.5
};

describe('buy-quality-analysis', () => {
    it('parses score-buy entry factors from the saved decision reason', () => {
        const factors = parseEntryFactors('score 76/70: base 71, adj 5, social 1, analyst 4, tech -2, trend 2.10%, momentum 1.40%, below high 0.78%, volatility 0.77%');

        assert.strictEqual(factors.score, 76);
        assert.strictEqual(factors.minScore, 70);
        assert.strictEqual(factors.baseScore, 71);
        assert.strictEqual(factors.totalAdjustment, 5);
        assert.strictEqual(factors.socialScoreAdjustment, 1);
        assert.strictEqual(factors.analystScoreAdjustment, 4);
        assert.strictEqual(factors.technicalScoreAdjustment, -2);
        assert.strictEqual(factors.momentumPercent, 1.4);
        assert.strictEqual(factors.belowHighPercent, 0.78);
        assert.strictEqual(factors.volatilityPercent, 0.77);
    });

    it('classifies near-peak stop exits and candidate filters', () => {
        const decision = analyzeBuyQualityRow({
            entryDecisionReason: 'score 76/70: base 71, adj 5, social 1, analyst 4, tech -2, trend 2.10%, momentum 1.40%, below high 0.78%, volatility 0.77%',
            exitSignalSource: 'broker-stop-loss',
            netPnlRub: -5.24
        }, config);

        assert.strictEqual(decision.nearPeak, true);
        assert.strictEqual(decision.stopExit, true);
        assert.strictEqual(decision.losing, true);
        assert.strictEqual(decision.currentAntiFomoBlocked, true);
        assert.deepStrictEqual(decision.candidateFilters, ['current anti-FOMO']);
    });

    it('marks positive near-high momentum as a pullback confirmation candidate when current filters pass', () => {
        const decision = analyzeBuyQualityRow({
            entryDecisionReason: 'score 74/70: base 74, adj 0, social 0, analyst 0, tech 0, trend 1.00%, momentum 0.40%, below high 0.50%, volatility 1.00%',
            exitSignalSource: 'stop-loss',
            netPnlRub: -3
        }, config);

        assert.strictEqual(decision.currentAntiFomoBlocked, false);
        assert.strictEqual(decision.tightRangeBlocked, false);
        assert.strictEqual(decision.pullbackConfirmationBlocked, true);
        assert.deepStrictEqual(decision.candidateFilters, ['pullback/confirmation']);
    });
});
