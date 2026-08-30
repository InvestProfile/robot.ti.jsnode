import assert from 'node:assert/strict';
import test from 'node:test';
import {
    applyObservationTick, evaluateObservationGate, ObservationScenarioSnapshot,
    openObservationRunner, replayObservationTicks
} from './observation-runner';

const snapshot = (overrides: Partial<ObservationScenarioSnapshot> = {}): ObservationScenarioSnapshot => ({
    virtualAccountId: 'account-1', scenarioId: 'cash', equityKopecks: 100_000n,
    closedVirtualTrades: 0, invariantViolationCount: 0, unknownUnreconciledOrderCount: 0,
    marginBreachCount: 0, feesIncluded: true, slippageIncluded: true,
    financingIncluded: true, benchmarkAvailable: true, ...overrides
});

test('short observation stays below the minimum evidence gate', () => {
    let state = openObservationRunner('experiment-1');
    state = applyObservationTick(state, { tickId: 't1', observedAt: '2026-08-01T00:00:00Z', snapshots: [snapshot()] });
    state = applyObservationTick(state, { tickId: 't2', observedAt: '2026-08-03T00:00:00Z', snapshots: [snapshot({ closedVirtualTrades: 4 })] });
    const gate = evaluateObservationGate(state.scenarios[0]);
    assert.equal(gate.qualified, false);
    assert.deepEqual(gate.reasons, ['MINIMUM_CALENDAR_DAYS_NOT_MET', 'MINIMUM_CLOSED_TRADES_NOT_MET']);
});

test('replay is deterministic, restart-idempotent, isolated, and tracks drawdown', () => {
    const ticks = [
        { tickId: 't1', observedAt: '2026-08-01T00:00:00Z', snapshots: [snapshot(), snapshot({ virtualAccountId: 'account-2', scenarioId: 'margin', equityKopecks: 200_000n })] },
        { tickId: 't2', observedAt: '2026-08-14T00:00:00Z', snapshots: [snapshot({ equityKopecks: 90_000n, closedVirtualTrades: 30 }), snapshot({ virtualAccountId: 'account-2', scenarioId: 'margin', equityKopecks: 220_000n, closedVirtualTrades: 31 })] }
    ] as const;
    const replayed = replayObservationTicks('experiment-1', ticks);
    assert.strictEqual(applyObservationTick(replayed, ticks[1]), replayed);
    assert.equal(replayed.scenarios[0].maximumDrawdownKopecks, 10_000n);
    assert.equal(replayed.scenarios[0].maximumDrawdownBps, 1_000);
    assert.equal(replayed.scenarios[1].maximumDrawdownKopecks, 0n);
    assert.deepEqual(replayObservationTicks('experiment-1', ticks), replayed);
});

test('conflicting replay and cross-snapshot duplicates fail closed', () => {
    const state = applyObservationTick(openObservationRunner('e'), { tickId: 't1', observedAt: '2026-08-01T00:00:00Z', snapshots: [snapshot()] });
    assert.throws(() => applyObservationTick(state, { tickId: 't1', observedAt: '2026-08-01T00:00:00Z', snapshots: [snapshot({ equityKopecks: 1n })] }), /conflict/);
    assert.throws(() => applyObservationTick(openObservationRunner('e'), { tickId: 't2', observedAt: '2026-08-01T00:00:00Z', snapshots: [snapshot(), snapshot()] }), /duplicate/);
});

test('counts distinct UTC calendar days and preserves historical evidence failures', () => {
    let state = applyObservationTick(openObservationRunner('calendar'), {
        tickId: 'd1', observedAt: '2026-08-01T23:59:59Z', snapshots: [snapshot({ feesIncluded: false })]
    });
    state = applyObservationTick(state, {
        tickId: 'd14', observedAt: '2026-08-14T00:00:01Z', snapshots: [snapshot({ closedVirtualTrades: 30, marginBreachCount: 1 })]
    });
    const gate = evaluateObservationGate(state.scenarios[0]);
    assert.equal(gate.calendarDays, 14);
    assert.deepEqual(gate.reasons, ['FEES_NOT_INCLUDED']);
    assert.throws(() => applyObservationTick(state, {
        tickId: 'counter-regression', observedAt: '2026-08-15T00:00:01Z',
        snapshots: [snapshot({ closedVirtualTrades: 31, marginBreachCount: 0, invariantViolationCount: 0 })]
    }), /strictly chronological|cannot decrease/);
});
