import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ObservationTick } from '../virtual/observation-runner';
import {
    ObservationTickStore,
    PostRiskVirtualEvidenceSource,
    RestartSafeVirtualObservationRuntime,
    SchedulerClock,
    startVirtualObservationScheduler
} from './shadow-composition';

const tick = (tickId: string, observedAt: string): ObservationTick => ({
    tickId, observedAt, snapshots: [{
        virtualAccountId: 'account-1', scenarioId: '1.0x', equityKopecks: 10000n,
        closedVirtualTrades: 0, invariantViolationCount: 0,
        unknownUnreconciledOrderCount: 0, marginBreachCount: 0,
        feesIncluded: true, slippageIncluded: true, financingIncluded: true,
        benchmarkAvailable: false
    }]
});

const threeScenarioTick = (tickId: string, observedAt: string): ObservationTick => ({
    tickId,
    observedAt,
    snapshots: ['1.0x', '1.2x', '1.5x'].map((scenarioId, index) => ({
        virtualAccountId: `account-${index + 1}`, scenarioId,
        equityKopecks: 10000n + BigInt(index), closedVirtualTrades: index,
        invariantViolationCount: 0, unknownUnreconciledOrderCount: 0,
        marginBreachCount: 0, feesIncluded: true, slippageIncluded: true,
        financingIncluded: true, benchmarkAvailable: false
    }))
});

class MemoryStore implements ObservationTickStore {
    readonly ticks: ObservationTick[] = [];
    loads = 0;
    async load() { this.loads += 1; return this.ticks; }
    async append(_experimentId: string, value: ObservationTick) {
        const existing = this.ticks.find(item => item.tickId === value.tickId);
        if (!existing) this.ticks.push(value);
        else assert.deepEqual(existing, value);
    }
}

describe('virtual observation runtime composition', () => {
    it('has zero effects while disabled', () => {
        let factories = 0;
        let timers = 0;
        const clock: SchedulerClock = {
            setInterval() { timers += 1; return 1; },
            clearInterval() { timers -= 1; }
        };
        const process = startVirtualObservationScheduler({ enabled: false, intervalMs: 1000 }, () => {
            factories += 1;
            throw new Error('must not construct runtime');
        }, clock);
        process.stop();
        assert.equal(factories, 0);
        assert.equal(timers, 0);
    });

    it('persists before publishing state and resumes by replay after restart', async () => {
        const store = new MemoryStore();
        const queue = [
            threeScenarioTick('tick-1', '2026-08-30T10:00:00Z'),
            threeScenarioTick('tick-1', '2026-08-30T10:00:00Z'),
            threeScenarioTick('tick-2', '2026-08-30T10:01:00Z')
        ];
        const source: PostRiskVirtualEvidenceSource = { async collect() { return queue.shift() as ObservationTick; } };
        const first = new RestartSafeVirtualObservationRuntime('experiment-1', store, source);
        assert.equal((await first.tick()).ticks.length, 1);
        const restarted = new RestartSafeVirtualObservationRuntime('experiment-1', store, source);
        const recovered = await restarted.initialize();
        assert.equal(recovered.ticks.length, 1);
        assert.equal(recovered.ticks[0].tickId, 'tick-1');
        assert.deepEqual(recovered.scenarios.map(item => item.scenarioId), ['1.0x', '1.2x', '1.5x']);
        assert.equal((await restarted.tick()).ticks.length, 1);
        assert.equal(store.ticks.length, 1);
        assert.equal((await restarted.tick()).ticks.length, 2);
        assert.equal(store.ticks.length, 2);
    });

    it('publishes none of a three-scenario tick when atomic persistence fails', async () => {
        const store: ObservationTickStore = {
            async load() { return []; },
            async append() { throw new Error('database unavailable'); }
        };
        const source: PostRiskVirtualEvidenceSource = {
            async collect() { return threeScenarioTick('tick-1', '2026-08-30T10:00:00Z'); }
        };
        const runtime = new RestartSafeVirtualObservationRuntime('experiment-1', store, source);
        await assert.rejects(runtime.tick(), /database unavailable/);
        assert.equal((await runtime.initialize()).ticks.length, 0);
        assert.equal((await runtime.initialize()).scenarios.length, 0);
    });

    it('coalesces overlapping scheduler ticks', async () => {
        let release: (() => void) | undefined;
        let calls = 0;
        const store = new MemoryStore();
        const runtime = new RestartSafeVirtualObservationRuntime('experiment-1', store, {
            async collect() {
                calls += 1;
                await new Promise<void>(resolve => { release = resolve; });
                return tick('tick-1', '2026-08-30T10:00:00Z');
            }
        });
        let scheduled: (() => void) | undefined;
        const errors: unknown[] = [];
        startVirtualObservationScheduler({ enabled: true, intervalMs: 1000 }, () => runtime, {
            setInterval(task) { scheduled = task; return 1; }, clearInterval() { /* no-op */ }
        }, error => errors.push(error));
        await new Promise(resolve => setImmediate(resolve));
        scheduled?.();
        assert.equal(calls, 1);
        release?.();
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(errors.length, 0);
        assert.equal(store.ticks.length, 1);
    });
});
