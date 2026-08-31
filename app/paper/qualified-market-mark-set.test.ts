import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createBrokerMarketMark, MARKET_MARK_SOURCE, type BrokerMarketMark } from '../market-observation/types';
import {
    assertSameScenarioMarkSet,
    assignQualifiedMarkSetToScenarios,
    qualifyMarketMarkSet
} from './qualified-market-mark-set';

const mark = (instrumentUid: string, at: string, overrides: Record<string, unknown> = {}): BrokerMarketMark =>
    createBrokerMarketMark({
        observationId: `${instrumentUid}:${at}`, sourceIdentity: `stream:${instrumentUid}:${at}`,
        instrumentUid, brokerObservedAt: at, receivedAt: '2026-08-31T12:00:01.000Z',
        bidKopecks: 100n, askKopecks: 102n, markKopecks: 101n,
        source: MARKET_MARK_SOURCE, sessionStatus: 'open', ...overrides
    });

const request = (marks: readonly BrokerMarketMark[], overrides: Record<string, unknown> = {}) => ({
    sourceTickId: 'tick-1', valuationAt: '2026-08-31T12:00:00.000Z',
    requiredInstrumentUids: ['position-1'], benchmarkInstrumentUid: 'benchmark', marks,
    maxMarkAgeMs: 2_000, maxInterInstrumentSkewMs: 500, ...overrides
});

describe('qualified independent market mark set', () => {
    it('selects latest as-of marks without look-ahead and records immutable provenance', () => {
        const old = mark('position-1', '2026-08-31T11:59:59.500Z');
        const future = mark('position-1', '2026-08-31T12:00:00.001Z', { receivedAt: '2026-08-31T12:00:01.100Z' });
        const benchmark = mark('benchmark', '2026-08-31T11:59:59.700Z');
        const result = qualifyMarketMarkSet(request([future, old, benchmark]));
        assert.equal(result.quality, 'qualified');
        if (result.quality !== 'qualified') return;
        assert.equal(result.marks.find(item => item.instrumentUid === 'position-1')?.observationId, old.observationId);
        assert.equal(result.benchmarkMark.observationId, benchmark.observationId);
        assert.match(result.markSetId, /^[a-f0-9]{64}$/);
        assert.deepEqual(result.provenance.map(item => item.observationId).sort(), [old.observationId, benchmark.observationId].sort());
    });

    it('fails closed for missing coverage including benchmark and for future-only marks', () => {
        const future = mark('position-1', '2026-08-31T12:00:00.001Z');
        const result = qualifyMarketMarkSet(request([future]));
        assert.equal(result.quality, 'rejected');
        if (result.quality !== 'rejected') return;
        assert.deepEqual(result.reasons, ['MISSING_REQUIRED_MARK:benchmark', 'MISSING_REQUIRED_MARK:position-1']);
    });

    it('fails closed for stale and skewed marks', () => {
        const position = mark('position-1', '2026-08-31T11:59:55.000Z');
        const benchmark = mark('benchmark', '2026-08-31T11:59:59.900Z');
        const result = qualifyMarketMarkSet(request([position, benchmark]));
        assert.equal(result.quality, 'rejected');
        if (result.quality !== 'rejected') return;
        assert(result.reasons.includes('STALE_MARK:position-1'));
        assert(result.reasons.includes('MARK_SET_SKEW_EXCEEDED'));
    });

    it('requires every position exactly through de-duplicated required coverage', () => {
        const result = qualifyMarketMarkSet(request([
            mark('position-1', '2026-08-31T11:59:59.900Z'),
            mark('benchmark', '2026-08-31T11:59:59.900Z')
        ], { requiredInstrumentUids: ['position-1', 'position-2', 'position-1'] }));
        assert.equal(result.quality, 'rejected');
        if (result.quality === 'rejected') assert.deepEqual(result.reasons, ['MISSING_REQUIRED_MARK:position-2']);
    });

    it('assigns the exact same markSetId and provenance object to all scenarios', () => {
        const result = qualifyMarketMarkSet(request([
            mark('position-1', '2026-08-31T11:59:59.900Z'),
            mark('benchmark', '2026-08-31T11:59:59.900Z')
        ]));
        assert.equal(result.quality, 'qualified');
        if (result.quality !== 'qualified') return;
        const assignments = assignQualifiedMarkSetToScenarios(result, ['1.0x', '1.2x', '1.5x']);
        assert.equal(assertSameScenarioMarkSet(assignments), result.markSetId);
        assert.equal(assignments.every(item => item.provenance === result.provenance), true);
        assert.throws(() => assertSameScenarioMarkSet([
            assignments[0], { ...assignments[1], markSetId: 'different' }
        ]), /provenance mismatch/);
    });

    it('produces a deterministic markSetId for replay regardless of ingress ordering', () => {
        const position = mark('position-1', '2026-08-31T11:59:59.900Z');
        const benchmark = mark('benchmark', '2026-08-31T11:59:59.900Z');
        const first = qualifyMarketMarkSet(request([position, benchmark]));
        const replay = qualifyMarketMarkSet(request([benchmark, position]));
        assert.equal(first.quality, 'qualified');
        assert.equal(replay.quality, 'qualified');
        if (first.quality === 'qualified' && replay.quality === 'qualified') assert.equal(first.markSetId, replay.markSetId);
    });

    it('recomputes the canonical fingerprint and rejects a tampered payload', () => {
        const valid = mark('position-1', '2026-08-31T11:59:59.900Z');
        const tampered = Object.freeze({ ...valid, markKopecks: 100n });
        const result = qualifyMarketMarkSet(request([tampered, mark('benchmark', '2026-08-31T11:59:59.900Z')]));
        assert.equal(result.quality, 'rejected');
        if (result.quality === 'rejected') assert(result.reasons.includes('INVALID_MARK_FINGERPRINT:position-1'));
    });

    it('uses versioned open-only session policy and rejects closed and break marks by default', () => {
        for (const sessionStatus of ['closed', 'break'] as const) {
            const result = qualifyMarketMarkSet(request([
                mark('position-1', '2026-08-31T11:59:59.900Z', { sessionStatus }),
                mark('benchmark', '2026-08-31T11:59:59.900Z')
            ]));
            assert.equal(result.quality, 'rejected');
            if (result.quality === 'rejected') {
                const reason = 'SESSION_STATUS_NOT_QUALIFIED:position-1:' + sessionStatus;
                assert(result.reasons.includes(reason as typeof result.reasons[number]));
            }
        }
    });
});
