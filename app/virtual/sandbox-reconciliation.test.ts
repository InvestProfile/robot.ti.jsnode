import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
    DeterministicSandboxReconciler, SandboxOrderReadObservation,
    SandboxOrderReadPort, SandboxOrderReadRequest, SandboxReconcileRequest
} from './sandbox-reconciliation';

const request = (overrides: Partial<SandboxReconcileRequest> = {}): SandboxReconcileRequest => ({
    reconciliationId: 'reconcile-1', accountId: 'account-a', clientOrderId: 'client-a',
    brokerOrderId: 'broker-a', orderedLots: 3, ...overrides
});

const observation = (overrides: Partial<SandboxOrderReadObservation> = {}): SandboxOrderReadObservation => ({
    accountId: 'account-a', clientOrderId: 'client-a', brokerOrderId: 'broker-a',
    state: 'pending', cumulativeFilledLots: 0, cumulativeGrossKopecks: '0', ...overrides
});

class SequencePort implements SandboxOrderReadPort {
    readonly requests: SandboxOrderReadRequest[] = [];
    constructor(private readonly responses: unknown[]) {}
    async readOrder(value: SandboxOrderReadRequest) {
        this.requests.push(value);
        if (this.responses.length === 0) throw new Error('no observation');
        return this.responses.shift();
    }
}

describe('deterministic sandbox reconciliation', () => {
    it('reconciles pending, partial and filled lifecycle with lossless cumulative amounts', async () => {
        const huge = '123456789012345678901234567890';
        const port = new SequencePort([
            observation(),
            observation({ state: 'partial', cumulativeFilledLots: 1, cumulativeGrossKopecks: huge }),
            observation({ state: 'filled', cumulativeFilledLots: 3, cumulativeGrossKopecks: `${BigInt(huge) * 3n}` })
        ]);
        const reconciler = new DeterministicSandboxReconciler(port);
        assert.strictEqual((await reconciler.reconcile(request())).snapshot?.state, 'pending');
        const partial = await reconciler.reconcile(request({ reconciliationId: 'reconcile-2' }));
        assert.strictEqual(partial.snapshot?.cumulativeGrossKopecks, BigInt(huge));
        const filled = await reconciler.reconcile(request({ reconciliationId: 'reconcile-3' }));
        assert.deepStrictEqual([
            filled.snapshot?.state, filled.snapshot?.cumulativeFilledLots,
            filled.snapshot?.cumulativeGrossKopecks
        ], ['filled', 3, BigInt(huge) * 3n]);
    });

    it('isolates account, client and broker identities', async () => {
        for (const mismatch of [
            { accountId: 'account-b' }, { clientOrderId: 'client-b' }, { brokerOrderId: 'broker-b' }
        ]) {
            const result = await new DeterministicSandboxReconciler(
                new SequencePort([observation(mismatch)])
            ).reconcile(request());
            assert.strictEqual(result.status, 'reconcile-required');
            assert.match(result.reason as string, /identity mismatch/);
            assert.strictEqual(result.resubmitAllowed, false);
        }
    });

    it('never resubmits unknown and makes exact retries idempotent', async () => {
        const port = new SequencePort([observation({ state: 'unknown', reason: 'broker state unavailable' })]);
        const reconciler = new DeterministicSandboxReconciler(port);
        const first = reconciler.reconcile(request());
        const retry = reconciler.reconcile({ ...request() });
        assert.strictEqual(retry, first);
        const result = await retry;
        assert.deepStrictEqual([result.status, result.resubmitAllowed], ['reconcile-required', false]);
        assert.match(result.reason as string, /broker state unavailable/);
        assert.strictEqual(port.requests.length, 1);
    });

    it('rejects conflicting retry payloads before another read', () => {
        const port = new SequencePort([observation()]);
        const reconciler = new DeterministicSandboxReconciler(port);
        void reconciler.reconcile(request());
        assert.throws(() => reconciler.reconcile(request({ orderedLots: 4 })), /ID conflict/);
        assert.strictEqual(port.requests.length, 1);
    });

    it('keeps terminal states monotonic and cumulative fills non-decreasing', async () => {
        const port = new SequencePort([
            observation({ state: 'filled', cumulativeFilledLots: 3, cumulativeGrossKopecks: '30000' }),
            observation({ state: 'cancelled', cumulativeFilledLots: 3, cumulativeGrossKopecks: '30000' })
        ]);
        const reconciler = new DeterministicSandboxReconciler(port);
        const filled = await reconciler.reconcile(request());
        const regression = await reconciler.reconcile(request({ reconciliationId: 'reconcile-2' }));
        assert.strictEqual(regression.status, 'reconcile-required');
        assert.match(regression.reason as string, /terminal state filled/);
        assert.strictEqual(regression.snapshot, filled.snapshot);

        const decreasing = new DeterministicSandboxReconciler(new SequencePort([
            observation({ state: 'partial', cumulativeFilledLots: 2, cumulativeGrossKopecks: '20000' }),
            observation({ state: 'partial', cumulativeFilledLots: 1, cumulativeGrossKopecks: '10000' })
        ]));
        await decreasing.reconcile(request());
        assert.match((await decreasing.reconcile(request({ reconciliationId: 'reconcile-2' }))).reason as string, /cannot decrease/);
    });

    it('restores snapshots and replays deterministically after restart', async () => {
        const first = new DeterministicSandboxReconciler(new SequencePort([
            observation({ state: 'partial', cumulativeFilledLots: 1, cumulativeGrossKopecks: '10000' })
        ]));
        await first.reconcile(request());
        const restored = new DeterministicSandboxReconciler(new SequencePort([
            observation({ state: 'filled', cumulativeFilledLots: 3, cumulativeGrossKopecks: '30000' })
        ]), first.snapshots());
        const result = await restored.reconcile(request({ reconciliationId: 'after-restart' }));
        assert.deepStrictEqual(result.snapshot, {
            accountId: 'account-a', clientOrderId: 'client-a', brokerOrderId: 'broker-a', orderedLots: 3,
            state: 'filled', cumulativeFilledLots: 3, cumulativeGrossKopecks: 30000n
        });
    });

    it('rejects malformed restored snapshots and immutable terminal total changes', async () => {
        assert.throws(() => new DeterministicSandboxReconciler(new SequencePort([]), [{
            ...request(), state: 'filled', cumulativeFilledLots: 2, cumulativeGrossKopecks: 20n
        }]), /invalid restored/);
        const reconciler = new DeterministicSandboxReconciler(new SequencePort([
            observation({ state: 'filled', cumulativeFilledLots: 3, cumulativeGrossKopecks: '30000' }),
            observation({ state: 'filled', cumulativeFilledLots: 3, cumulativeGrossKopecks: '30001' })
        ]));
        await reconciler.reconcile(request());
        const changed = await reconciler.reconcile(request({ reconciliationId: 'terminal-change' }));
        assert.match(changed.reason ?? '', /totals are immutable/);
        assert.equal(changed.status, 'reconcile-required');
    });

    it('isolates per-order errors in a deterministic batch', async () => {
        const port = new SequencePort([
            observation(),
            observation({ accountId: 'account-b', clientOrderId: 'client-b', brokerOrderId: 'broker-b' })
        ]);
        const reconciler = new DeterministicSandboxReconciler(port);
        const results = await reconciler.reconcileBatch([
            request(),
            request({ reconciliationId: 'reconcile-b', accountId: 'account-b', clientOrderId: 'client-b', brokerOrderId: 'broker-b' }),
            request({ reconciliationId: '' })
        ]);
        assert.deepStrictEqual(results.map(value => value.result?.status ?? 'error'), ['reconciled', 'reconciled', 'error']);
        assert.match(results[2].error as string, /reconciliationId/);
    });

    it('fails closed for malformed lifecycle and fill observations', async () => {
        for (const bad of [
            observation({ state: 'partial', cumulativeFilledLots: 0 }),
            observation({ state: 'filled', cumulativeFilledLots: 2 }),
            { ...observation(), cumulativeGrossKopecks: '01' },
            { ...observation(), state: 'surprise' }
        ]) {
            const result = await new DeterministicSandboxReconciler(new SequencePort([bad])).reconcile(request());
            assert.strictEqual(result.status, 'reconcile-required');
            assert.strictEqual(result.resubmitAllowed, false);
        }
    });
});
