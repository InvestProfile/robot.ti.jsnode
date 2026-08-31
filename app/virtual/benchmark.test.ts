import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    applyQualifiedBenchmarkObservation,
    BENCHMARK_METHODOLOGY,
    BENCHMARK_RETURN_SCOPE,
    openNormalizedPriceBenchmark,
    QualifiedBenchmarkObservation,
    replayQualifiedBenchmarkObservations
} from './benchmark';

const observation = (
    observationId: string,
    brokerObservedAt: string,
    markKopecks: bigint,
    scenarioEquityKopecks: bigint
): QualifiedBenchmarkObservation => ({ observationId, brokerObservedAt, markKopecks, scenarioEquityKopecks });

describe('normalized price benchmark', () => {
    it('immutably fixes the first qualified broker-timestamped mark as baseline', () => {
        const opened = openNormalizedPriceBenchmark('IMOEX-price', 1_000_000n);
        const first = applyQualifiedBenchmarkObservation(opened,
            observation('mark-1', '2026-08-31T07:00:00.123Z', 12_345n, 1_000_000n));
        const second = applyQualifiedBenchmarkObservation(first,
            observation('mark-2', '2026-08-31T07:01:00.123Z', 12_400n, 1_001_000n));

        assert.equal(opened.baseline, undefined);
        assert.deepEqual(second.baseline, first.baseline);
        assert.equal(second.baseline?.brokerObservedAt, '2026-08-31T07:00:00.123Z');
        assert.ok(Object.isFrozen(second));
        assert.ok(Object.isFrozen(second.baseline));
        assert.ok(Object.isFrozen(second.points));
        assert.ok(second.points.every(Object.isFrozen));
    });

    it('uses only BigInt arithmetic and floors normalized benchmark equity', () => {
        const state = replayQualifiedBenchmarkObservations('benchmark', 10n, [
            observation('base', '2026-08-31T07:00:00Z', 3n, 10n),
            observation('next', '2026-08-31T07:01:00Z', 4n, 15n)
        ]);
        const point = state.points[1];

        assert.equal(point.benchmarkEquityKopecks, 13n);
        assert.equal(point.benchmarkPnlKopecks, 3n);
        assert.equal(point.scenarioPnlKopecks, 5n);
        assert.equal(point.scenarioReturnBps, 5_000n);
        assert.equal(point.benchmarkReturnBps, 3_333n);
        assert.equal(point.excessPnlKopecks, 2n);
        assert.equal(point.excessReturnBps, 1_667n);
        Object.values(point).forEach(value => assert.notEqual(typeof value, 'number'));
    });

    it('supports negative pnl and returns without floating point', () => {
        const state = replayQualifiedBenchmarkObservations('benchmark', 100n, [
            observation('base', '2026-08-31T07:00:00Z', 100n, 100n),
            observation('loss', '2026-08-31T07:01:00Z', 80n, 70n)
        ]);
        const point = state.points[1];
        assert.equal(point.benchmarkPnlKopecks, -20n);
        assert.equal(point.scenarioPnlKopecks, -30n);
        assert.equal(point.benchmarkReturnBps, -2_000n);
        assert.equal(point.scenarioReturnBps, -3_000n);
        assert.equal(point.excessPnlKopecks, -10n);
        assert.equal(point.excessReturnBps, -1_000n);
    });

    it('is deterministic and payload-idempotent, but rejects an ID conflict', () => {
        const events = [
            observation('base', '2026-08-31T07:00:00Z', 100n, 1_000n),
            observation('next', '2026-08-31T07:01:00Z', 101n, 1_020n)
        ];
        const first = replayQualifiedBenchmarkObservations('benchmark', 1_000n, events);
        const replay = replayQualifiedBenchmarkObservations('benchmark', 1_000n, events);
        assert.deepEqual(replay, first);
        assert.equal(applyQualifiedBenchmarkObservation(first, events[1]), first);
        assert.throws(() => applyQualifiedBenchmarkObservation(first,
            { ...events[1], markKopecks: 102n }), /benchmark observation ID conflict/);
    });

    it('rejects non-broker timestamps, invalid money and non-chronological replay', () => {
        const opened = openNormalizedPriceBenchmark('benchmark', 100n);
        assert.throws(() => applyQualifiedBenchmarkObservation(opened,
            observation('bad-time', '2026-08-31T07:00:00+03:00', 100n, 100n)), /brokerObservedAt/);
        assert.throws(() => applyQualifiedBenchmarkObservation(opened,
            observation('bad-mark', '2026-08-31T07:00:00Z', 0n, 100n)), /markKopecks/);
        assert.throws(() => applyQualifiedBenchmarkObservation(opened,
            observation('bad-equity', '2026-08-31T07:00:00Z', 100n, -1n)), /scenarioEquityKopecks/);
        const first = applyQualifiedBenchmarkObservation(opened,
            observation('first', '2026-08-31T07:01:00Z', 100n, 100n));
        assert.throws(() => applyQualifiedBenchmarkObservation(first,
            observation('older', '2026-08-31T07:00:00Z', 100n, 100n)), /strictly chronological/);
    });

    it('states price-only methodology and never claims total return', () => {
        const state = openNormalizedPriceBenchmark('benchmark', 100n);
        assert.equal(state.methodology, BENCHMARK_METHODOLOGY);
        assert.equal(state.returnScope, BENCHMARK_RETURN_SCOPE);
        assert.equal(state.methodology, 'normalized-price-return');
        assert.match(state.returnScope, /excludes-dividends-fees-and-total-return/);
    });

    it('uses mathematical floor for fractional negative return bps boundaries', () => {
        const state = replayQualifiedBenchmarkObservations('benchmark', 3n, [
            observation('base', '2026-08-31T07:00:00Z', 3n, 3n),
            observation('loss', '2026-08-31T07:01:00Z', 2n, 2n)
        ]);
        const point = state.points[1];
        assert.equal(point.scenarioReturnBps, -3_334n);
        assert.equal(point.benchmarkReturnBps, -3_334n);
        assert.equal(point.excessReturnBps, 0n);
    });
});
