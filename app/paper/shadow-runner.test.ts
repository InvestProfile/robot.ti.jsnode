import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { adaptPostRiskDecisionToShadowIntent } from './shadow-intent.adapter';
import { ShadowObservationStore, ShadowRunner, ShadowVirtualExecutionPort } from './shadow-runner';

const policy = { feeBasisPoints: 4, slippageBasisPoints: 2, maxQuoteAgeMs: 5_000 };
const quote = {
    instrumentId: 'SBER', bidKopecks: 29_900n, askKopecks: 30_000n,
    lotSize: 10, observedAt: '2026-08-29T10:00:00Z'
};
const adaptation = (status: 'allowed' | 'blocked' = 'allowed') =>
    adaptPostRiskDecisionToShadowIntent({
        decisionStage: 'post-risk-policy', decisionId: `decision-${status}`,
        virtualAccountId: 'paper-1', instrumentId: 'SBER',
        evaluatedAt: '2026-08-29T10:00:00Z', action: 'buy', status,
        approvedLots: status === 'allowed' ? 1 : undefined, reason: status
    });

const harness = (enabled: boolean) => {
    const observations: unknown[] = [];
    const executions: unknown[] = [];
    const store: ShadowObservationStore = {
        async append(value) { observations.push(value); }
    };
    const execution: ShadowVirtualExecutionPort = {
        async execute(intent, marketQuote, context, executionPolicy) {
            executions.push({ intent, marketQuote, context, executionPolicy });
            return Object.freeze({
                status: 'rejected' as const, orderId: intent.id,
                reason: 'insufficient-cash' as const, rejectedAt: context.now
            });
        }
    };
    return { runner: new ShadowRunner(enabled, store, execution), observations, executions };
};

describe('disabled-by-default shadow runner boundary', () => {
    it('has no side effects while disabled', async () => {
        const test = harness(false);
        assert.deepEqual(await test.runner.run({ adaptation: adaptation() }), { status: 'disabled' });
        assert.equal(test.observations.length, 0);
        assert.equal(test.executions.length, 0);
    });

    it('persists a blocked observation without requesting execution', async () => {
        const test = harness(true);
        const result = await test.runner.run({ adaptation: adaptation('blocked') });
        assert.equal(result.status, 'observed');
        assert.equal(test.observations.length, 1);
        assert.equal(test.executions.length, 0);
    });

    it('persists an allowed observation before virtual execution', async () => {
        const calls: string[] = [];
        const store: ShadowObservationStore = { async append() { calls.push('observation'); } };
        const execution: ShadowVirtualExecutionPort = {
            async execute(intent, _quote, context) {
                calls.push('execution');
                return { status: 'rejected', orderId: intent.id, reason: 'insufficient-cash', rejectedAt: context.now };
            }
        };
        const runner = new ShadowRunner(true, store, execution);
        const result = await runner.run({ adaptation: adaptation(), quote, availableLots: 0, policy });
        assert.equal(result.status, 'executed');
        assert.deepEqual(calls, ['observation', 'execution']);
    });

    it('fails closed when executable inputs are incomplete', async () => {
        const test = harness(true);
        await assert.rejects(test.runner.run({ adaptation: adaptation() }), /requires quote/);
        assert.equal(test.observations.length, 1);
        assert.equal(test.executions.length, 0);
    });
});
