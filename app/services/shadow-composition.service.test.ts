import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { adaptPostRiskDecisionToShadowIntent } from '../paper/shadow-intent.adapter';
import type { ShadowObservationStore, ShadowVirtualExecutionPort } from '../paper/shadow-runner';
import { createDisabledShadowRunner } from './shadow-composition.service';

describe('shadow composition', () => {
    it('cannot activate persistence or execution through its public factory', async () => {
        let observations = 0;
        let executions = 0;
        const store: ShadowObservationStore = {
            async append() { observations += 1; }
        };
        const execution: ShadowVirtualExecutionPort = {
            async execute(intent) {
                executions += 1;
                return {
                    status: 'rejected', orderId: intent.id,
                    reason: 'invalid-order', rejectedAt: intent.submittedAt
                };
            }
        };
        const runner = createDisabledShadowRunner(store, execution);
        const adaptation = adaptPostRiskDecisionToShadowIntent({
            decisionStage: 'post-risk-policy', decisionId: 'decision-1',
            virtualAccountId: 'paper-1', instrumentId: 'SBER',
            evaluatedAt: '2026-08-29T10:00:00Z', action: 'buy', status: 'allowed',
            approvedLots: 1, reason: 'allowed'
        });

        assert.deepEqual(await runner.run({ adaptation }), { status: 'disabled' });
        assert.equal(observations, 0);
        assert.equal(executions, 0);
    });
});
