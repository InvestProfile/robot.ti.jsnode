import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runMarketMarkCollectorWorker } from './market-mark-collector.worker';

const result = { acquired: true, requested: 0, received: 0, inserted: 0, duplicates: 0, batches: 0 };

describe('market mark collector worker', () => {
    it('is disabled by default and does not load dependencies', async () => {
        let loads = 0;
        const worker = await runMarketMarkCollectorWorker({}, async () => {
            loads += 1;
            throw new Error('must not load');
        });
        assert.equal(worker, undefined);
        assert.equal(loads, 0);
    });

    it('validates all bounded settings before loading dependencies', async () => {
        const base = { ROBOT_MARK_COLLECTOR_ENABLED: 'true', ROBOT_MARK_COLLECTOR_LEASE_NAME: 'marks' };
        const cases = [
            [{ ...base, ROBOT_MARK_COLLECTOR_INTERVAL_MS: '999' }, /INTERVAL_MS/],
            [{ ...base, ROBOT_MARK_COLLECTOR_BATCH_SIZE: '101' }, /BATCH_SIZE/],
            [{ ...base, ROBOT_MARK_COLLECTOR_MAX_ATTEMPTS: '11' }, /MAX_ATTEMPTS/],
            [{ ...base, ROBOT_MARK_COLLECTOR_INITIAL_BACKOFF_MS: '5000', ROBOT_MARK_COLLECTOR_MAX_BACKOFF_MS: '1000' }, /cannot exceed/],
            [{ ...base, ROBOT_MARK_COLLECTOR_INTERVAL_MS: '5000', ROBOT_MARK_COLLECTOR_LEASE_TTL_MS: '5000' }, /must exceed/]
        ] as const;
        for (const [env, pattern] of cases) {
            let loads = 0;
            await assert.rejects(runMarketMarkCollectorWorker(env, async () => {
                loads += 1;
                throw new Error('must not load');
            }), pattern);
            assert.equal(loads, 0);
        }
    });

    it('requires an explicit lease name before dependency loading', async () => {
        let loads = 0;
        await assert.rejects(runMarketMarkCollectorWorker({ ROBOT_MARK_COLLECTOR_ENABLED: 'on' }, async () => {
            loads += 1;
            throw new Error('must not load');
        }), /LEASE_NAME is required/);
        assert.equal(loads, 0);
    });

    it('runs immediately, prevents overlap, and gracefully waits before close', async () => {
        let collectCalls = 0;
        let closeCalls = 0;
        let release: (() => void) | undefined;
        const blocked = new Promise<void>(resolve => { release = resolve; });
        const worker = await runMarketMarkCollectorWorker({
            ROBOT_MARK_COLLECTOR_ENABLED: 'true', ROBOT_MARK_COLLECTOR_LEASE_NAME: 'marks',
            ROBOT_MARK_COLLECTOR_INTERVAL_MS: '1000', ROBOT_MARK_COLLECTOR_LEASE_TTL_MS: '3000'
        }, async () => ({ prepare: async options => {
            assert.equal(options.batchSize, 50);
            return {
                collectOnce: async () => { collectCalls += 1; await blocked; return result; },
                close: async () => { closeCalls += 1; }
            };
        } }));
        assert.ok(worker);
        await new Promise(resolve => setTimeout(resolve, 1_100));
        assert.equal(collectCalls, 1);
        const stopping = worker.stop();
        await new Promise(resolve => setTimeout(resolve, 0));
        assert.equal(closeCalls, 0);
        release?.();
        await stopping;
        assert.equal(closeCalls, 1);
    });

    it('fails closed and releases prepared resources after a collection error', async () => {
        const previousExitCode = process.exitCode;
        let closeCalls = 0;
        const originalError = console.error;
        console.error = () => undefined;
        try {
            const worker = await runMarketMarkCollectorWorker({
                ROBOT_MARK_COLLECTOR_ENABLED: 'true', ROBOT_MARK_COLLECTOR_LEASE_NAME: 'marks',
                ROBOT_MARK_COLLECTOR_INTERVAL_MS: '1000', ROBOT_MARK_COLLECTOR_LEASE_TTL_MS: '3000'
            }, async () => ({ prepare: async () => ({
                collectOnce: async () => { throw new Error('broker unavailable'); },
                close: async () => { closeCalls += 1; }
            }) }));
            assert.ok(worker);
            await new Promise(resolve => setTimeout(resolve, 20));
            assert.equal(process.exitCode, 1);
            await worker.stop();
            assert.equal(closeCalls, 1);
        } finally {
            console.error = originalError;
            process.exitCode = previousExitCode;
        }
    });

    it('fails closed and releases resources when collectOnce throws synchronously', async () => {
        const previousExitCode = process.exitCode;
        let closeCalls = 0;
        const originalError = console.error;
        console.error = () => undefined;
        try {
            const worker = await runMarketMarkCollectorWorker({
                ROBOT_MARK_COLLECTOR_ENABLED: 'true', ROBOT_MARK_COLLECTOR_LEASE_NAME: 'marks',
                ROBOT_MARK_COLLECTOR_INTERVAL_MS: '1000', ROBOT_MARK_COLLECTOR_LEASE_TTL_MS: '3000'
            }, async () => ({ prepare: async () => ({
                collectOnce: (() => { throw new Error('sync failure'); }) as never,
                close: async () => { closeCalls += 1; }
            }) }));
            assert.ok(worker);
            await new Promise(resolve => setTimeout(resolve, 20));
            assert.equal(process.exitCode, 1);
            await worker.stop();
            assert.equal(closeCalls, 1);
        } finally {
            console.error = originalError;
            process.exitCode = previousExitCode;
        }
    });

    it('handles close rejection without an unhandled rejection and fails closed', async () => {
        const previousExitCode = process.exitCode;
        const messages: string[] = [];
        const originalError = console.error;
        console.error = (...args: unknown[]) => { messages.push(String(args[0])); };
        try {
            const worker = await runMarketMarkCollectorWorker({
                ROBOT_MARK_COLLECTOR_ENABLED: 'true', ROBOT_MARK_COLLECTOR_LEASE_NAME: 'marks',
                ROBOT_MARK_COLLECTOR_INTERVAL_MS: '1000', ROBOT_MARK_COLLECTOR_LEASE_TTL_MS: '3000'
            }, async () => ({ prepare: async () => ({
                collectOnce: async () => { throw new Error('collection failed'); },
                close: async () => { throw new Error('close failed'); }
            }) }));
            assert.ok(worker);
            await new Promise(resolve => setTimeout(resolve, 20));
            assert.equal(process.exitCode, 1);
            assert.ok(messages.includes('Market mark collector cleanup failed:'));
            await assert.rejects(worker.stop(), /close failed/);
        } finally {
            console.error = originalError;
            process.exitCode = previousExitCode;
        }
    });
});
