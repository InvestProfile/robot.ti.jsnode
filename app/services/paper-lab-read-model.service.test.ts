import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    decodePaperLabCursor,
    encodePaperLabCursor,
    PaperLabReadModelService,
    PaperLabReadModelStore,
    parsePaperLabLimit,
    serializePaperKopecks
} from './paper-lab-read-model.service';

const emptyStore = (listAccounts: PaperLabReadModelStore['listAccounts']): PaperLabReadModelStore => ({
    listAccounts,
    async findAccount() { return null; },
    async listOrders() { return []; },
    async listFills() { return []; },
    async listReconciliationFills() { return []; },
    async listReconciliationLedger() { return []; },
    async listDecisions() { return []; },
    async listObservationAccounts() { return []; },
    async loadObservationRows() { return undefined; }
});

describe('Paper Lab bounded read model', () => {
    it('serializes bigint money losslessly', () => {
        assert.equal(serializePaperKopecks(9_007_199_254_740_993n), '9007199254740993');
    });

    it('uses bounded integer limits', () => {
        assert.equal(parsePaperLabLimit(null), 50);
        assert.equal(parsePaperLabLimit('999'), 200);
        assert.throws(() => parsePaperLabLimit('1.5'), /positive integer/);
    });

    it('binds opaque cursors to their account', () => {
        const encoded = encodePaperLabCursor({ virtualAccountId: 'paper-a', offset: 50 });
        assert.deepEqual(decodePaperLabCursor(encoded, 'paper-a'), { virtualAccountId: 'paper-a', offset: 50 });
        assert.throws(() => decodePaperLabCursor(encoded, 'paper-b'), /account mismatch/);
    });

    it('single-flights identical reads and keeps account-list queries bounded', async () => {
        let calls = 0;
        let release: (() => void) | undefined;
        const gate = new Promise<void>(resolve => { release = resolve; });
        const service = new PaperLabReadModelService(emptyStore(async limit => {
            calls += 1;
            assert.equal(limit, 50);
            await gate;
            return [];
        }), () => new Date('2026-08-30T10:00:00Z'));
        const first = service.load(undefined, 200);
        const second = service.load(undefined, 200);
        release?.();
        assert.strictEqual(await first, await second);
        assert.equal(calls, 1);
    });

    it('expires cache deterministically after TTL', async () => {
        let now = Date.parse('2026-08-30T10:00:00Z');
        let calls = 0;
        const service = new PaperLabReadModelService(emptyStore(async () => { calls += 1; return []; }), () => new Date(now), 100);
        await service.load(undefined, 50);
        now += 99;
        await service.load(undefined, 50);
        assert.equal(calls, 1);
        now += 1;
        await service.load(undefined, 50);
        assert.equal(calls, 2);
    });

    it('renders missing and stale observation evidence as insufficient, never qualified', async () => {
        const store = {
            ...emptyStore(async () => []),
            async loadObservationRows() {
                return {
                    experiment: {
                        experiment_id: 'exp-1', config_fingerprint: 'a'.repeat(64),
                        config_json: JSON.stringify({ experimentId: 'exp-1', scenarios: [
                            { scenarioId: '1.0x', leverage: 1 }, { scenarioId: '1.2x', leverage: 1.2 },
                            { scenarioId: '1.5x', leverage: 1.5 }
                        ], startingCashKopecks: '100000000', benchmarkId: 'IMOEX' }),
                        created_at: '2026-08-01T00:00:00Z', updated_at: '2026-08-01T00:00:00Z'
                    },
                    lease: { owner_id: 'worker', expires_at: '2026-08-01T00:10:00Z', updated_at: '2026-08-01T00:00:00Z' },
                    states: [], ticks: [], checkpoint: undefined,
                    source: [{ status: 'backlog', count: '7', latest_at: '2026-08-01T00:00:00Z' },
                        { status: 'failed', count: '2', latest_at: '2026-08-01T00:01:00Z' }]
                };
            }
        } as PaperLabReadModelStore;
        const service = new PaperLabReadModelService(store, () => new Date('2026-08-02T00:00:00Z'));
        const payload = await service.load('virtual:exp-1:1.0x', 50);
        const monitoring = payload.observation as {
            state: string; worker: { state: string }; parity: { complete: boolean };
            source: { backlog: number; failures: number }; benchmark: { state: string }; reasons: string[];
        };
        assert.equal(monitoring.state, 'INSUFFICIENT-EVIDENCE');
        assert.equal(monitoring.worker.state, 'stale');
        assert.equal(monitoring.parity.complete, false);
        assert.equal(monitoring.source.backlog, 7);
        assert.equal(monitoring.source.failures, 2);
        assert.equal(monitoring.benchmark.state, 'configured-unavailable');
        assert.equal(monitoring.reasons.includes('WORKER_HEARTBEAT_STALE'), true);
        assert.equal(monitoring.reasons.includes('THREE_SCENARIO_PARITY_FAILED'), true);
    });
});
