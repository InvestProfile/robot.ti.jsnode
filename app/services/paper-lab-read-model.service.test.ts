import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    decodePaperLabCursor,
    encodePaperLabCursor,
    filterCompleteBenchmarkPointSets,
    PaperLabReadModelService,
    SequelizePaperLabReadModelStore,
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
        const source = SequelizePaperLabReadModelStore.prototype.loadObservationRows.toString();
        assert.match(source, /COUNT\(DISTINCT scenario_id\) = 3/);
        assert.match(source, /ARRAY_AGG\(scenario_id ORDER BY scenario_id\) = ARRAY\['1\.0x', '1\.2x', '1\.5x'\]/);
    });

    it('filters partial benchmark sets while preserving every row at the complete-set boundary', () => {
        const rows = [
            { mark_set_id: 'old', scenario_id: '1.0x' },
            { mark_set_id: 'new', scenario_id: '1.0x' },
            { mark_set_id: 'new', scenario_id: '1.2x' },
            { mark_set_id: 'new', scenario_id: '1.5x' },
            { mark_set_id: 'bad', scenario_id: '1.0x' },
            { mark_set_id: 'bad', scenario_id: '1.2x' },
            { mark_set_id: 'bad', scenario_id: '2.0x' }
        ];
        assert.deepEqual(filterCompleteBenchmarkPointSets(rows), rows.slice(1, 4));
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
                    states: [], ticks: [], checkpoint: undefined, benchmarkPoints: [],
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
            marketEvidence: { configVersion: number; quality: string; rejectionReasons: string[] };
        };
        assert.equal(monitoring.state, 'INSUFFICIENT-EVIDENCE');
        assert.equal(monitoring.worker.state, 'stale');
        assert.equal(monitoring.parity.complete, false);
        assert.equal(monitoring.source.backlog, 7);
        assert.equal(monitoring.source.failures, 2);
        assert.equal(monitoring.benchmark.state, 'configured-unavailable');
        assert.deepEqual(monitoring.marketEvidence, { configVersion: 1, quality: 'missing', rejectionReasons: [] });
        assert.equal(monitoring.reasons.includes('WORKER_HEARTBEAT_STALE'), true);
        assert.equal(monitoring.reasons.includes('THREE_SCENARIO_PARITY_FAILED'), true);
    });

    it('exposes lossless v2 benchmark points and exact latest market rejection reasons', async () => {
        const tick = (id: string, evidence?: object) => JSON.stringify({
            tickId: id, observedAt: `2026-08-02T10:0${id}:00Z`, snapshots: [],
            ...(evidence ? { marketEvidence: evidence } : {})
        });
        const store = {
            ...emptyStore(async () => []),
            async loadObservationRows() {
                return {
                    experiment: { experiment_id: 'exp-v2', config_fingerprint: 'b'.repeat(64),
                        config_json: JSON.stringify({ configVersion: 2, benchmarkId: 'IMOEX' }),
                        created_at: '2026-08-02T09:00:00Z', updated_at: '2026-08-02T10:02:00Z' },
                    lease: { owner_id: 'worker', expires_at: '2026-08-02T11:00:00Z', updated_at: '2026-08-02T10:02:00Z' },
                    states: [], checkpoint: undefined, source: [],
                    ticks: [
                        { observed_at: '2026-08-02T10:01:00Z', updated_at: '2026-08-02T10:01:00Z',
                            payload_json: tick('1', { quality: 'qualified' }) },
                        { observed_at: '2026-08-02T10:02:00Z', updated_at: '2026-08-02T10:02:00Z',
                            payload_json: tick('2', { quality: 'rejected', reasons: ['MARK_TOO_OLD', 'SESSION_CLOSED'] }) }
                    ],
                    benchmarkPoints: [{ scenario_id: '1.0x', mark_set_id: 'c'.repeat(64),
                        valuation_at: '2026-08-02T10:01:30Z',
                        scenario_equity_kopecks: '9007199254740993123',
                        benchmark_equity_kopecks: '9007199254740993999',
                        scenario_pnl_kopecks: '-123', benchmark_pnl_kopecks: '753',
                        scenario_return_bps: '-9007199254740993123',
                        benchmark_return_bps: '9007199254740993999',
                        excess_pnl_kopecks: '-876', excess_return_bps: '-18014398509481987122' }]
                };
            }
        } as PaperLabReadModelStore;
        const payload = await new PaperLabReadModelService(store, () => new Date('2026-08-02T10:03:00Z'))
            .load('virtual:exp-v2:1.0x', 50);
        const observation = payload.observation as { marketEvidence: { configVersion: number; quality: string;
            rejectionReasons: string[] }; benchmark: { curve: { scenarioEquityKopecks: string; excessReturnBps: string }[] } };
        assert.deepEqual(observation.marketEvidence, { configVersion: 2, quality: 'rejected',
            rejectionReasons: ['MARK_TOO_OLD', 'SESSION_CLOSED'] });
        assert.equal(observation.benchmark.curve[0].scenarioEquityKopecks, '9007199254740993123');
        assert.equal(observation.benchmark.curve[0].excessReturnBps, '-18014398509481987122');
    });
});
