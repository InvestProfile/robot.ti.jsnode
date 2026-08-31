import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { prepareMarketMarkCollectorRuntime } from './market-mark-collector-runtime.service';

describe('market mark collector runtime composition', () => {
    it('rejects an invalid lease name before creating the read-only client', () => {
        let created = 0;
        assert.throws(() => prepareMarketMarkCollectorRuntime({} as never, () => {
            created += 1;
            return {} as never;
        }, { leaseName: ' ', leaseTtlMs: 5_000, batchSize: 10, maxAttempts: 2,
            initialBackoffMs: 10, maxBackoffMs: 100 }), /leaseName is required/);
        assert.equal(created, 0);
    });

    it('accepts only a managed structural read-only client factory and constructs without broker calls', async () => {
        let created = 0;
        let brokerCalls = 0;
        let closeCalls = 0;
        const runtime = prepareMarketMarkCollectorRuntime({} as never, () => {
            created += 1;
            return {
                getTradingStatuses: async () => { brokerCalls += 1; return {}; },
                getOrderBook: async () => { brokerCalls += 1; return {} as never; },
                close: async () => { closeCalls += 1; }
            };
        }, { ownerId: 'worker-1', leaseName: 'qualified-marks', leaseTtlMs: 5_000,
            batchSize: 10, maxAttempts: 2, initialBackoffMs: 10, maxBackoffMs: 100 });
        assert.equal(typeof runtime.collectOnce, 'function');
        assert.equal(created, 1);
        assert.equal(brokerCalls, 0);
        await runtime.close();
        await runtime.close();
        assert.equal(closeCalls, 1);
    });

    it('propagates client cleanup failures through the runtime lifecycle', async () => {
        const failure = new Error('client close failed');
        const runtime = prepareMarketMarkCollectorRuntime({} as never, () => ({
            getTradingStatuses: async () => ({}),
            getOrderBook: async () => ({} as never),
            close: async () => { throw failure; }
        }), { ownerId: 'worker-1', leaseName: 'qualified-marks', leaseTtlMs: 5_000,
            batchSize: 10, maxAttempts: 2, initialBackoffMs: 10, maxBackoffMs: 100 });
        await assert.rejects(runtime.close(), error => error === failure);
    });
});
