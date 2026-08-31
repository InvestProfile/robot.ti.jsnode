import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { QueryOptions, Transaction } from 'sequelize';
import { createBrokerMarketMark } from '../market-observation/types';
import { OBSERVATION_SCENARIOS, type ObservationExperimentConfigV2 } from '../paper/observation-persistence';
import { buildQualifiedBenchmarkEvidence } from '../paper/qualified-shadow-evidence';
import { qualifyMarketMarkSet } from '../paper/qualified-market-mark-set';
import {
    openShadowScenarioStates,
    type AtomicShadowFanoutCommit,
    type ShadowMarketEvidenceResult
} from '../paper/shadow-scenario-fanout';
import { DEFAULT_MARGIN_SCENARIO_POLICIES, marginRiskSnapshot } from '../virtual/margin';
import { SequelizeAtomicShadowFanoutRepository } from './sequelize-shadow-fanout.repository';

const config: ObservationExperimentConfigV2 = Object.freeze({
    experimentId: 'qualified-experiment', scenarios: OBSERVATION_SCENARIOS, startingCashKopecks: '1000000',
    executionPolicy: Object.freeze({ feeBasisPoints: 0, slippageBasisPoints: 0, maxQuoteAgeMs: 5000 }),
    marginPolicies: DEFAULT_MARGIN_SCENARIO_POLICIES, benchmarkId: 'benchmark', configVersion: 2,
    evidenceConfig: Object.freeze({
        configVersion: 2, marketDataSource: 't-invest-market-data-readonly',
        sessionPolicyVersion: 't-invest-session-v1-open-only', benchmarkInstrumentUid: 'benchmark-uid',
        benchmarkMethodology: 'normalized-price-return',
        benchmarkReturnScope: 'price-only-excludes-dividends-fees-and-total-return',
        maxMarkAgeMs: 5000, maxInterInstrumentSkewMs: 1000
    })
});
const at = '2026-08-31T12:00:01.000Z';
const states = openShadowScenarioStates(config, '2026-08-31T12:00:00.000Z');
const mark = createBrokerMarketMark({
    observationId: 'benchmark-observation', sourceIdentity: 'benchmark-source', instrumentUid: 'benchmark-uid',
    brokerObservedAt: at, receivedAt: at, bidKopecks: 99n, askKopecks: 101n, markKopecks: 100n,
    source: 't-invest-market-data-readonly', sessionStatus: 'open'
});
const markSet = (() => {
    const result = qualifyMarketMarkSet({
        sourceTickId: 'tick-1', valuationAt: at, requiredInstrumentUids: [],
        benchmarkInstrumentUid: 'benchmark-uid', marks: [mark], maxMarkAgeMs: 5000, maxInterInstrumentSkewMs: 1000
    });
    if (result.quality !== 'qualified') throw new Error('test fixture qualification failed');
    return result;
})();
const qualified: Extract<ShadowMarketEvidenceResult, { quality: 'qualified' }> = Object.freeze({
    quality: 'qualified', markSet,
    benchmark: buildQualifiedBenchmarkEvidence({ config, markSet, states }),
    sessionPolicyVersion: 't-invest-session-v1-open-only', benchmarkInstrumentUid: 'benchmark-uid',
    initialEquityKopecks: 1000000n
});
const sourceTick = Object.freeze({
    sourceTickId: 'tick-1', startedAt: '2026-08-31T12:00:00.000Z', completedAt: at,
    expectedEventCount: 0, policyVersion: 'post-risk-v1', configFingerprint: 'a'.repeat(64),
    payloadFingerprint: 'b'.repeat(64), events: Object.freeze([])
});
const snapshotsFor = (next: typeof states, reasons: readonly string[] = []) => Object.freeze(next.map(state => {
    const risk = marginRiskSnapshot(state.margin);
    return Object.freeze({
        virtualAccountId: state.virtualAccountId, scenarioId: state.scenarioId, equityKopecks: risk.equityKopecks,
        closedVirtualTrades: 0, invariantViolationCount: 0, unknownUnreconciledOrderCount: 0, marginBreachCount: 0,
        feesIncluded: true, slippageIncluded: true, financingIncluded: true, benchmarkAvailable: reasons.length === 0,
        evidenceQualityReasons: Object.freeze([...reasons])
    });
}));
const evidenceTick = Object.freeze({ tickId: 'fanout:tick-1', observedAt: at, snapshots: snapshotsFor(states) });
const commit = (
    marketEvidence?: ShadowMarketEvidenceResult,
    previous: typeof states = states,
    next: typeof states = states,
    tick = evidenceTick
): AtomicShadowFanoutCommit => Object.freeze({
    experimentId: config.experimentId, sourceTick, previous, next, evidenceTick: tick,
    ...(marketEvidence ? { marketEvidence } : {})
});
const encode = (value: unknown) => JSON.stringify(value, (_key, item) =>
    typeof item === 'bigint' ? { $bigint: item.toString() } : item
);

class FakeDatabase {
    readonly calls: { sql: string; replacements: Record<string, unknown> }[] = [];
    checkpointResponses: { source_payload_fingerprint: string }[][] = [[], []];
    baselineConflict = false;
    currentStates = states;
    configVersion: number | null | undefined = 2;

    async transaction<T>(callback: (transaction: Transaction) => Promise<T>) {
        return callback({} as Transaction);
    }

    async query<T>(sql: string, options: QueryOptions = {}): Promise<T[]> {
        const normalized = sql.replace(/\s+/g, ' ').trim();
        const replacements = (options.replacements ?? {}) as Record<string, unknown>;
        this.calls.push({ sql: normalized, replacements });
        if (normalized.includes('FROM virtual_observation_experiments')) {
            return (this.configVersion === undefined ? [] : [{ config_version: this.configVersion }]) as T[];
        }
        if (normalized.includes('FROM virtual_shadow_source_checkpoints')) {
            return (this.checkpointResponses.shift() ?? []) as T[];
        }
        if (normalized.includes('FROM virtual_shadow_scenario_states')) {
            return this.currentStates.map(state => ({
                scenario_id: state.scenarioId, state_fingerprint: 'unused', state_json: encode(state)
            })) as T[];
        }
        if (normalized.startsWith('SELECT baseline_mark_set_id')) {
            return [{
                baseline_mark_set_id: this.baselineConflict ? 'c'.repeat(64) : markSet.markSetId,
                observation_id: mark.observationId, mark_kopecks: mark.markKopecks.toString(),
                broker_observed_at: mark.brokerObservedAt, initial_equity_kopecks: '1000000',
                methodology: 'normalized-price-return',
                return_scope: 'price-only-excludes-dividends-fees-and-total-return',
                payload_fingerprint: mark.payloadFingerprint, market_payload_fingerprint: mark.payloadFingerprint
            }] as T[];
        }
        return [] as T[];
    }
}

const indexOf = (database: FakeDatabase, fragment: string) =>
    database.calls.findIndex(call => call.sql.includes(fragment));
const count = (database: FakeDatabase, fragment: string) =>
    database.calls.filter(call => call.sql.includes(fragment)).length;

describe('SequelizeAtomicShadowFanoutRepository qualified persistence', () => {
    it('locks first and writes qualified evidence before states, tick and checkpoint', async () => {
        const database = new FakeDatabase();
        const repository = new SequelizeAtomicShadowFanoutRepository(database as never);
        assert.equal(await repository.commit(commit(qualified)), 'applied');
        assert.equal(indexOf(database, 'pg_advisory_xact_lock'), 0);
        assert.equal(count(database, 'FROM virtual_shadow_source_checkpoints'), 2);
        assert(indexOf(database, 'INSERT INTO virtual_market_mark_sets') < indexOf(database, 'UPDATE virtual_shadow_scenario_states'));
        assert.equal(count(database, 'INSERT INTO virtual_market_mark_set_members'), 1);
        assert.equal(count(database, 'INSERT INTO virtual_normalized_benchmark_points'), 3);
        assert(indexOf(database, 'INSERT INTO virtual_normalized_benchmark_points')
            < indexOf(database, 'UPDATE virtual_shadow_scenario_states'));
        assert(indexOf(database, 'INSERT INTO virtual_observation_ticks')
            < indexOf(database, 'INSERT INTO virtual_shadow_source_checkpoints'));
        const baselineInsert = database.calls.find(call => call.sql.includes('INSERT INTO virtual_normalized_benchmark_baselines'));
        assert.equal(baselineInsert?.replacements.payloadFingerprint, mark.payloadFingerprint);
        const tickInsert = database.calls.find(call => call.sql.includes('INSERT INTO virtual_observation_ticks'));
        const payload = JSON.parse(String(tickInsert?.replacements.payloadJson));
        assert.equal(payload.marketEvidence.quality, 'qualified');
    });

    it('persists rejected evidence without qualified evidence rows and leaves v1 behavior evidence-free', async () => {
        const reason = 'MISSING_REQUIRED_MARK:uid' as const;
        const rejectedStates = Object.freeze(states.map(state => Object.freeze({
            ...state, qualityReasons: Object.freeze([reason])
        }))) as typeof states;
        const rejected = Object.freeze({
            quality: 'rejected' as const, sourceTickId: 'tick-1', valuationAt: at, reasons: Object.freeze([reason])
        });
        for (const [marketEvidence, next, tick] of [
            [rejected, rejectedStates, Object.freeze({
                ...evidenceTick, snapshots: snapshotsFor(rejectedStates, rejected.reasons)
            })],
            [undefined, states, evidenceTick]
        ] as const) {
            const database = new FakeDatabase();
            database.configVersion = marketEvidence === undefined ? null : 2;
            await new SequelizeAtomicShadowFanoutRepository(database as never).commit(commit(marketEvidence, states, next, tick));
            assert.equal(count(database, 'virtual_market_mark_sets'), 0);
            assert.equal(count(database, 'virtual_normalized_benchmark'), 0);
            assert.equal(count(database, 'INSERT INTO virtual_shadow_source_checkpoints'), 1);
            const tickInsert = database.calls.find(call => call.sql.includes('INSERT INTO virtual_observation_ticks'));
            const payload = JSON.parse(String(tickInsert?.replacements.payloadJson));
            assert.equal('marketEvidence' in payload, marketEvidence !== undefined);
            if (marketEvidence === undefined) assert.equal(tickInsert?.replacements.payloadJson, encode(evidenceTick));
        }
    });

    it('fails closed on an immutable baseline conflict before scenario state updates', async () => {
        const database = new FakeDatabase();
        database.baselineConflict = true;
        await assert.rejects(
            new SequelizeAtomicShadowFanoutRepository(database as never).commit(commit(qualified)),
            /immutable benchmark baseline conflict/
        );
        assert.equal(count(database, 'UPDATE virtual_shadow_scenario_states'), 0);
        assert.equal(count(database, 'INSERT INTO virtual_shadow_source_checkpoints'), 0);
    });

    it('rechecks checkpoint after state lock and returns idempotent without writes', async () => {
        const database = new FakeDatabase();
        database.configVersion = null;
        database.checkpointResponses = [[], [{ source_payload_fingerprint: sourceTick.payloadFingerprint }]];
        assert.equal(await new SequelizeAtomicShadowFanoutRepository(database as never).commit(commit()), 'idempotent');
        assert.equal(indexOf(database, 'pg_advisory_xact_lock'), 0);
        assert.equal(count(database, 'FROM virtual_shadow_source_checkpoints'), 2);
        assert.equal(count(database, 'UPDATE virtual_shadow_scenario_states'), 0);
        assert.equal(count(database, 'INSERT INTO virtual_shadow_source_checkpoints'), 0);
    });

    it('requires the exact unique scenario set for persisted, previous and next states', async () => {
        const duplicate = Object.freeze([states[0], states[0], states[2]]) as typeof states;
        for (const target of ['current', 'previous', 'next'] as const) {
            const database = new FakeDatabase();
            database.configVersion = null;
            if (target === 'current') database.currentStates = duplicate;
            const input = target === 'previous' ? commit(undefined, duplicate)
                : target === 'next' ? commit(undefined, states, duplicate) : commit();
            await assert.rejects(new SequelizeAtomicShadowFanoutRepository(database as never).commit(input),
                /must contain exactly 1\.0x, 1\.2x and 1\.5x/);
        }
    });

    it('rejects a noncanonical mark set ID and any mark/provenance or market fingerprint mismatch', async () => {
        const changedId = Object.freeze({ ...qualified, markSet: Object.freeze({
            ...qualified.markSet, markSetId: 'd'.repeat(64)
        }) });
        const changedMark = Object.freeze({ ...mark, observationId: 'tampered-observation' });
        const changedMarks = Object.freeze({ ...qualified, markSet: Object.freeze({
            ...qualified.markSet, marks: Object.freeze([changedMark])
        }) });
        const changedFingerprintMark = Object.freeze({ ...mark, markKopecks: 101n });
        const changedFingerprint = Object.freeze({ ...qualified, markSet: Object.freeze({
            ...qualified.markSet, marks: Object.freeze([changedFingerprintMark])
        }) });
        const changedBenchmark = Object.freeze({ ...qualified, markSet: Object.freeze({
            ...qualified.markSet, benchmarkMark: changedFingerprintMark
        }) });
        for (const [evidence, message] of [
            [changedId, /mark set ID mismatch/],
            [changedMarks, /mark\/provenance mismatch/],
            [changedFingerprint, /mark\/provenance mismatch/],
            [changedBenchmark, /benchmark mark fingerprint mismatch/]
        ] as const) {
            await assert.rejects(
                new SequelizeAtomicShadowFanoutRepository(new FakeDatabase() as never).commit(commit(evidence)),
                message
            );
        }
    });

    it('rejects benchmark equity that does not reconcile to matching next scenario state', async () => {
        const first = qualified.benchmark.points[0];
        const badPoint = Object.freeze({ ...first.point, scenarioEquityKopecks: first.point.scenarioEquityKopecks + 1n });
        const bad = Object.freeze({ ...qualified, benchmark: Object.freeze({
            ...qualified.benchmark,
            points: Object.freeze([Object.freeze({ ...first, point: badPoint }), ...qualified.benchmark.points.slice(1)])
        }) });
        await assert.rejects(
            new SequelizeAtomicShadowFanoutRepository(new FakeDatabase() as never).commit(commit(bad)),
            /scenario equity mismatch/
        );
    });

    it('rejects malformed or unpropagated rejected evidence', async () => {
        const reason = 'MISSING_REQUIRED_MARK:uid' as const;
        const rejectedStates = Object.freeze(states.map(state => Object.freeze({
            ...state, qualityReasons: Object.freeze([reason])
        }))) as typeof states;
        const goodTick = Object.freeze({ ...evidenceTick, snapshots: snapshotsFor(rejectedStates, [reason]) });
        const base = Object.freeze({ quality: 'rejected' as const, sourceTickId: 'tick-1', valuationAt: at,
            reasons: Object.freeze([reason]) });
        const cases = [
            Object.freeze({ ...base, sourceTickId: 'wrong' }),
            Object.freeze({ ...base, valuationAt: '2026-08-31T12:00:02.000Z' }),
            Object.freeze({ ...base, reasons: Object.freeze([]) }),
            Object.freeze({ ...base, reasons: Object.freeze([reason, reason]) }),
            Object.freeze({ ...base, reasons: Object.freeze([
                'STALE_MARK:uid' as const, 'MISSING_REQUIRED_MARK:uid' as const
            ]) })
        ];
        for (const evidence of cases) {
            await assert.rejects(new SequelizeAtomicShadowFanoutRepository(new FakeDatabase() as never)
                .commit(commit(evidence, states, rejectedStates, goodTick)));
        }
        await assert.rejects(new SequelizeAtomicShadowFanoutRepository(new FakeDatabase() as never)
            .commit(commit(base, states, states, goodTick)), /reason set mismatch/);
        await assert.rejects(new SequelizeAtomicShadowFanoutRepository(new FakeDatabase() as never)
            .commit(commit(base, states, rejectedStates, evidenceTick)), /reason set mismatch/);
    });

    it('binds market evidence presence to the persisted experiment config version', async () => {
        for (const [version, input, message] of [
            [undefined, commit(qualified), /config is missing/],
            [2, commit(), /requires market evidence/],
            [null, commit(qualified), /forbids market evidence/],
            [3, commit(qualified), /unsupported/]
        ] as const) {
            const database = new FakeDatabase();
            database.configVersion = version;
            await assert.rejects(new SequelizeAtomicShadowFanoutRepository(database as never).commit(input), message);
            assert.equal(indexOf(database, 'pg_advisory_xact_lock'), 0);
            assert.equal(count(database, 'FROM virtual_shadow_source_checkpoints'), 0);
        }
    });

    it('requires exact tick-scoped rejected reason sets in every state and snapshot', async () => {
        const reasons = Object.freeze(['MISSING_REQUIRED_MARK:uid'] as const);
        const extra = 'STALE_MARK:uid';
        const rejected = Object.freeze({ quality: 'rejected' as const, sourceTickId: 'tick-1', valuationAt: at, reasons });
        const next = Object.freeze(states.map(state => Object.freeze({
            ...state, qualityReasons: Object.freeze([...reasons, extra, 'QUOTE_TIMESTAMP_APPROXIMATE'])
        }))) as typeof states;
        const tickWithExtra = Object.freeze({
            ...evidenceTick, snapshots: snapshotsFor(next, [...reasons, extra, 'QUOTE_TIMESTAMP_APPROXIMATE'])
        });
        await assert.rejects(new SequelizeAtomicShadowFanoutRepository(new FakeDatabase() as never)
            .commit(commit(rejected, states, next, tickWithExtra)), /reason set mismatch/);
    });

    it('rejects noncanonical provenance order even when its mark-set hash matches that order', async () => {
        const positionMark = createBrokerMarketMark({
            observationId: 'position-observation', sourceIdentity: 'position-source', instrumentUid: 'position-uid',
            brokerObservedAt: at, receivedAt: at, bidKopecks: 49n, askKopecks: 51n, markKopecks: 50n,
            source: 't-invest-market-data-readonly', sessionStatus: 'open'
        });
        const qualifiedTwo = qualifyMarketMarkSet({
            sourceTickId: 'tick-1', valuationAt: at, requiredInstrumentUids: ['position-uid'],
            benchmarkInstrumentUid: 'benchmark-uid', marks: [mark, positionMark],
            maxMarkAgeMs: 5000, maxInterInstrumentSkewMs: 1000
        });
        assert.equal(qualifiedTwo.quality, 'qualified');
        if (qualifiedTwo.quality !== 'qualified') return;
        const reversed = Object.freeze([...qualifiedTwo.provenance].reverse());
        const reversedId = createHash('sha256').update(JSON.stringify({
            sourceTickId: qualifiedTwo.sourceTickId, valuationAt: qualifiedTwo.valuationAt, provenance: reversed
        })).digest('hex');
        const evidence = Object.freeze({ ...qualified, markSet: Object.freeze({
            ...qualifiedTwo, provenance: reversed, markSetId: reversedId
        }) });
        await assert.rejects(new SequelizeAtomicShadowFanoutRepository(new FakeDatabase() as never)
            .commit(commit(evidence)), /canonically sorted/);
    });
});
