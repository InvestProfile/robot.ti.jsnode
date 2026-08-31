import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_MARGIN_SCENARIO_POLICIES, applyMarginScenarioEvent, marginRiskSnapshot } from '../virtual/margin';
import { createBrokerMarketMark } from '../market-observation/types';
import { openShadowScenarioStates } from './shadow-scenario-fanout';
import type { CompleteShadowSourceTick } from './shadow-source-outbox';
import type { ObservationExperimentConfigV2 } from './observation-persistence';
import { applyQualifiedMarksToScenarios, buildQualifiedBenchmarkEvidence, prepareQualifiedShadowTick } from './qualified-shadow-evidence';

const config: ObservationExperimentConfigV2 = {
    experimentId: 'qualified-e1', scenarios: Object.freeze([{ scenarioId: '1.0x', leverage: 1 }, { scenarioId: '1.2x', leverage: 1.2 }, { scenarioId: '1.5x', leverage: 1.5 }]),
    startingCashKopecks: '1000000', executionPolicy: { feeBasisPoints: 10, slippageBasisPoints: 10, maxQuoteAgeMs: 5000 },
    marginPolicies: DEFAULT_MARGIN_SCENARIO_POLICIES, benchmarkId: 'TMOS-price-proxy', configVersion: 2,
    evidenceConfig: { configVersion: 2, marketDataSource: 't-invest-market-data-readonly', sessionPolicyVersion: 't-invest-session-v1-open-only',
        benchmarkInstrumentUid: 'uid-benchmark', benchmarkMethodology: 'normalized-price-return',
        benchmarkReturnScope: 'price-only-excludes-dividends-fees-and-total-return', maxMarkAgeMs: 5000, maxInterInstrumentSkewMs: 1000 }
};
const sourceTick: CompleteShadowSourceTick = {
    sourceTickId: 'tick-1', startedAt: '2026-08-31T12:00:00.000Z', completedAt: '2026-08-31T12:00:02.000Z',
    expectedEventCount: 1, policyVersion: 'post-risk-v2-rounded-number-price-captured-after-read', configFingerprint: 'a'.repeat(64), payloadFingerprint: 'b'.repeat(64),
    events: [{ kind: 'decision', eventId: 'event-1', decisionId: 'decision-1', sourceAccountId: 'source', instrumentId: 'uid-position',
        action: 'hold', status: 'hold', approvedLots: 0, lotSize: 1, reason: 'test', evaluatedAt: '2026-08-31T12:00:00.000Z',
        quote: { bidKopecks: 99n, askKopecks: 101n, markKopecks: 100n, quoteObservedAt: '2026-08-31T12:00:00.000Z', quoteTimestampQuality: 'captured-after-read' } }]
};
const marketMark = (uid: string, price: bigint) => createBrokerMarketMark({ observationId: 'obs-' + uid, sourceIdentity: 'src-' + uid, instrumentUid: uid,
    brokerObservedAt: '2026-08-31T12:00:01.000Z', receivedAt: '2026-08-31T12:00:01.500Z',
    bidKopecks: price - 1n, askKopecks: price + 1n, markKopecks: price, source: 't-invest-market-data-readonly', sessionStatus: 'open' });

describe('qualified shadow evidence orchestration', () => {
    it('qualifies one shared as-of mark set for source, positions and benchmark', async () => {
        const initial = openShadowScenarioStates(config, sourceTick.startedAt);
        const bought = applyMarginScenarioEvent(initial[0].margin, { id: 'buy-1', kind: 'buy', instrumentId: 'uid-position', lotSize: 1, quantityLots: 1, executionPriceKopecks: 100n, feeKopecks: 0n, occurredAt: sourceTick.startedAt });
        assert.equal(bought.outcome, 'applied');
        const states = Object.freeze([{ ...initial[0], margin: bought.state }, initial[1], initial[2]]);
        const marks = [marketMark('uid-position', 110n), marketMark('uid-benchmark', 200n)];
        const prepared = await prepareQualifiedShadowTick({ config, sourceTick, states, loader: { async loadAsOf(input) {
            assert.deepEqual(input.instrumentUids, ['uid-benchmark', 'uid-position']); return marks;
        } } });
        assert.equal(prepared.qualification.quality, 'qualified');
        if (prepared.qualification.quality !== 'qualified') return;
        const marked = applyQualifiedMarksToScenarios(states, prepared.qualification);
        assert.equal(marked[0].margin.positions[0].markPriceKopecks, 110n);
        assert.equal(marginRiskSnapshot(marked[0].margin).equityKopecks > marginRiskSnapshot(states[0].margin).equityKopecks, true);
        const benchmark = buildQualifiedBenchmarkEvidence({ config, markSet: prepared.qualification, states: marked });
        assert.equal(benchmark.points.length, 3);
        assert.equal(new Set(benchmark.points.map(item => item.point.observationId)).size, 1);
        assert.equal(new Set(benchmark.points.map(item => item.payloadFingerprint)).size, 3);
        assert.deepEqual(buildQualifiedBenchmarkEvidence({ config, markSet: prepared.qualification, states: marked }), benchmark);
        assert.deepEqual(applyQualifiedMarksToScenarios(marked, prepared.qualification), marked);
    });

    it('fails closed with shared rejection when required coverage is missing', async () => {
        const states = openShadowScenarioStates(config, sourceTick.startedAt);
        const prepared = await prepareQualifiedShadowTick({ config, sourceTick, states, loader: { async loadAsOf() { return [marketMark('uid-benchmark', 200n)]; } } });
        assert.equal(prepared.qualification.quality, 'rejected');
        if (prepared.qualification.quality === 'rejected') assert.deepEqual(prepared.qualification.reasons, ['MISSING_REQUIRED_MARK:uid-position']);
    });



    it('rejects blank instrument UIDs instead of silently shrinking required coverage', async () => {
        const invalid = { ...sourceTick, events: [{ ...sourceTick.events[0], instrumentId: ' ' }] } as CompleteShadowSourceTick;
        await assert.rejects(() => prepareQualifiedShadowTick({
            config, sourceTick: invalid, states: openShadowScenarioStates(config, sourceTick.startedAt),
            loader: { async loadAsOf() { throw new Error('loader must not run'); } }
        }), /instrument UIDs must be non-empty/);
    });

    it('rejects benchmark observations before a persisted baseline or last point', async () => {
        const states = openShadowScenarioStates(config, sourceTick.startedAt);
        const prepared = await prepareQualifiedShadowTick({ config, sourceTick, states, loader: {
            async loadAsOf() { return [marketMark('uid-position', 110n), marketMark('uid-benchmark', 200n)]; }
        } });
        assert.equal(prepared.qualification.quality, 'qualified');
        if (prepared.qualification.quality !== 'qualified') return;
        const markSet = prepared.qualification;
        assert.throws(() => buildQualifiedBenchmarkEvidence({
            config, markSet, states,
            persistedBaseline: { observationId: 'later-baseline', brokerObservedAt: '2026-08-31T12:00:01.001Z', markKopecks: 200n }
        }), /must not precede or collide with persisted baseline/);
        const initial = buildQualifiedBenchmarkEvidence({ config, markSet, states });
        const laterPoint = { ...initial.points[0].point, observationId: 'later-point', brokerObservedAt: '2026-08-31T12:00:01.001Z' };
        assert.throws(() => buildQualifiedBenchmarkEvidence({
            config, markSet, states, persistedBaseline: initial.baseline,
            persistedLastPoints: initial.points.map((item, index) => index === 0 ? { ...item, point: laterPoint } : item)
        }), /strictly chronological/);
    });

    it('reuses an identical persisted last benchmark point idempotently', async () => {
        const states = openShadowScenarioStates(config, sourceTick.startedAt);
        const prepared = await prepareQualifiedShadowTick({ config, sourceTick, states, loader: {
            async loadAsOf() { return [marketMark('uid-position', 110n), marketMark('uid-benchmark', 200n)]; }
        } });
        assert.equal(prepared.qualification.quality, 'qualified');
        if (prepared.qualification.quality !== 'qualified') return;
        const first = buildQualifiedBenchmarkEvidence({ config, markSet: prepared.qualification, states });
        assert.deepEqual(buildQualifiedBenchmarkEvidence({ config, markSet: prepared.qualification, states,
            persistedBaseline: first.baseline, persistedLastPoints: first.points }), first);
    });


    it('rejects baseline identity conflicts, timestamp collisions and inexact scenario history', async () => {
        const states = openShadowScenarioStates(config, sourceTick.startedAt);
        const prepared = await prepareQualifiedShadowTick({ config, sourceTick, states, loader: {
            async loadAsOf() { return [marketMark('uid-position', 110n), marketMark('uid-benchmark', 200n)]; }
        } });
        assert.equal(prepared.qualification.quality, 'qualified');
        if (prepared.qualification.quality !== 'qualified') return;
        const markSet = prepared.qualification;
        assert.throws(() => buildQualifiedBenchmarkEvidence({
            config, markSet, states,
            persistedBaseline: { observationId: markSet.benchmarkMark.observationId,
                brokerObservedAt: markSet.benchmarkMark.brokerObservedAt, markKopecks: 201n }
        }), /baseline observation ID conflict/);
        assert.throws(() => buildQualifiedBenchmarkEvidence({
            config, markSet, states,
            persistedBaseline: { observationId: 'different-at-same-time',
                brokerObservedAt: markSet.benchmarkMark.brokerObservedAt, markKopecks: 200n }
        }), /collide with persisted baseline/);
        const first = buildQualifiedBenchmarkEvidence({ config, markSet, states });
        assert.throws(() => buildQualifiedBenchmarkEvidence({
            config, markSet, states, persistedBaseline: first.baseline
        }), /requires the exact last-point scenario set/);
        assert.throws(() => buildQualifiedBenchmarkEvidence({
            config, markSet, states, persistedBaseline: first.baseline,
            persistedLastPoints: first.points.slice(0, 2)
        }), /exact scenario set/);
        assert.throws(() => buildQualifiedBenchmarkEvidence({
            config, markSet, states, persistedBaseline: first.baseline,
            persistedLastPoints: [...first.points, { scenarioId: 'unknown', point: first.points[0].point }]
        }), /exact scenario set/);
    });
});
