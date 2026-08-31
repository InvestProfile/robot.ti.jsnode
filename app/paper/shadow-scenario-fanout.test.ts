import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { CompleteShadowSourceTick, ShadowSourceDecisionEvent, ShadowSourceEvent } from './shadow-source-outbox';
import { OBSERVATION_SCENARIOS } from './observation-persistence';
import type { ObservationExperimentConfig, ObservationExperimentConfigV2 } from './observation-persistence';
import { createBrokerMarketMark } from '../market-observation/types';
import { DEFAULT_MARGIN_SCENARIO_POLICIES, marginRiskSnapshot } from '../virtual/margin';
import type { AtomicShadowFanoutCommit, AtomicShadowFanoutRepository, ShadowScenarioState } from './shadow-scenario-fanout';
import { openShadowScenarioStates, OutboxShadowFanoutRuntime, ShadowScenarioFanoutProcessor } from './shadow-scenario-fanout';
import { evaluateObservationGate, replayObservationTicks } from '../virtual/observation-runner';

const config: ObservationExperimentConfig = Object.freeze({
    experimentId: 'experiment-1',
    scenarios: OBSERVATION_SCENARIOS,
    startingCashKopecks: '100000000',
    executionPolicy: Object.freeze({ feeBasisPoints: 10, slippageBasisPoints: 10, maxQuoteAgeMs: 5_000 }),
    marginPolicies: DEFAULT_MARGIN_SCENARIO_POLICIES,
    benchmarkId: null
});

const v2Config: ObservationExperimentConfigV2 = Object.freeze({
    ...config, experimentId: 'experiment-v2', benchmarkId: 'benchmark-price-proxy', configVersion: 2,
    evidenceConfig: Object.freeze({
        configVersion: 2, marketDataSource: 't-invest-market-data-readonly',
        sessionPolicyVersion: 't-invest-session-v1-open-only', benchmarkInstrumentUid: 'benchmark-uid',
        benchmarkMethodology: 'normalized-price-return',
        benchmarkReturnScope: 'price-only-excludes-dividends-fees-and-total-return',
        maxMarkAgeMs: 5_000, maxInterInstrumentSkewMs: 1_000
    })
});

const marketMark = (instrumentUid: string, markKopecks: bigint, at = "2026-08-31T12:00:00.500Z", suffix = "1") =>
    createBrokerMarketMark({
        observationId: "observation:" + instrumentUid + ":" + suffix,
        sourceIdentity: "source:" + instrumentUid + ":" + suffix, instrumentUid,
        brokerObservedAt: at, receivedAt: at, bidKopecks: markKopecks - 1n, askKopecks: markKopecks + 1n,
        markKopecks, source: 't-invest-market-data-readonly', sessionStatus: 'open'
    });

const decision = (overrides: Partial<ShadowSourceDecisionEvent> = {}): ShadowSourceDecisionEvent => ({
    kind: 'decision', eventId: 'event-1', decisionId: 'decision-1', sourceAccountId: 'source-account',
    instrumentId: 'figi-1', action: 'buy', status: 'allowed', approvedLots: 2, lotSize: 10,
    reason: 'post-risk allowed', evaluatedAt: '2026-08-31T12:00:00.000Z',
    quote: { bidKopecks: 100n, askKopecks: 102n, markKopecks: 101n,
        quoteObservedAt: '2026-08-31T12:00:00.000Z', quoteTimestampQuality: 'captured-after-read' },
    ...overrides
});

const tick = (events: readonly ShadowSourceEvent[], sourceTickId = 'source-tick-1', at = '2026-08-31T12:00:01.000Z'): CompleteShadowSourceTick => ({
    sourceTickId, startedAt: new Date(Date.parse(at) - 1_000).toISOString(),
    completedAt: at, expectedEventCount: events.length,
    policyVersion: 'post-risk-v1', configFingerprint: 'a'.repeat(64),
    payloadFingerprint: sourceTickId.padEnd(64, 'b').slice(0, 64), events
});

class MemoryAtomicRepository implements AtomicShadowFanoutRepository {
    states?: readonly ShadowScenarioState[];
    readonly checkpoints = new Map<string, string>();
    commits = 0;
    lastCommit?: AtomicShadowFanoutCommit;
    failNext = false;

    async hasCheckpoint(_experimentId: string, source: CompleteShadowSourceTick) {
        const existing = this.checkpoints.get(source.sourceTickId);
        if (existing && existing !== source.payloadFingerprint) throw new Error('checkpoint conflict');
        return existing !== undefined;
    }

    async loadOrInitialize(source: ObservationExperimentConfig, openedAt: string) {
        this.states ??= openShadowScenarioStates(source, openedAt);
        return this.states;
    }

    async commit(input: AtomicShadowFanoutCommit): Promise<'applied' | 'idempotent'> {
        const existing = this.checkpoints.get(input.sourceTick.sourceTickId);
        if (existing) {
            if (existing !== input.sourceTick.payloadFingerprint) throw new Error('checkpoint conflict');
            return 'idempotent';
        }
        if (this.failNext) { this.failNext = false; throw new Error('simulated crash before commit'); }
        this.lastCommit = input;
        this.states = input.next;
        this.checkpoints.set(input.sourceTick.sourceTickId, input.sourceTick.payloadFingerprint);
        this.commits += 1;
        return 'applied';
    }
}

describe('three-scenario shadow fanout', () => {
    it('drains a bounded source batch per scheduler tick instead of growing backlog', async () => {
        const pending = [tick([], 'batch-1'), tick([], 'batch-2'), tick([], 'batch-3')];
        const acknowledged: string[] = [];
        const source = { async claimNext() {
            const next = pending.shift();
            if (!next) return undefined;
            return { tick: next, consumerId: 'worker',
                acknowledge: async () => { acknowledged.push(next.sourceTickId); return true; } };
        } };
        const processed: string[] = [];
        const processor = { async process(sourceTick: CompleteShadowSourceTick) {
            processed.push(sourceTick.sourceTickId);
            return { tickId: sourceTick.sourceTickId, observedAt: sourceTick.completedAt, snapshots: [] };
        } };
        const runtime = new OutboxShadowFanoutRuntime(source, processor as unknown as ShadowScenarioFanoutProcessor,
            'worker', 1_000, 2);
        assert.equal((await runtime.tick())?.tickId, 'batch-2');
        assert.deepEqual(processed, ['batch-1', 'batch-2']);
        assert.deepEqual(acknowledged, ['batch-1', 'batch-2']);
        assert.equal((await runtime.tick())?.tickId, 'batch-3');
        assert.deepEqual(processed, ['batch-1', 'batch-2', 'batch-3']);
        assert.deepEqual(acknowledged, processed);
        assert.equal(await runtime.tick(), undefined);
        assert.throws(() => new OutboxShadowFanoutRuntime(source, processor as unknown as ShadowScenarioFanoutProcessor,
            'worker', 1_000, 0), /maxBatchSize/);
    });

    it('atomically applies one logical allowed decision to exactly all three scenarios', async () => {
        const repository = new MemoryAtomicRepository();
        const evidence = await new ShadowScenarioFanoutProcessor(config, repository).process(tick([decision()]));
        assert.deepEqual(repository.states?.map(state => state.scenarioId), ['1.0x', '1.2x', '1.5x']);
        assert.equal(repository.states?.every(state => state.margin.positions[0]?.quantityLots === 2), true);
        assert.equal(repository.states?.every(state => state.decisionAudit.length === 1), true);
        assert.equal(evidence.snapshots.length, 3);
    });

    it('leaves no partial visibility on crash and replays the source tick once', async () => {
        const repository = new MemoryAtomicRepository();
        const processor = new ShadowScenarioFanoutProcessor(config, repository);
        const before = await repository.loadOrInitialize(config, tick([]).startedAt);
        repository.failNext = true;
        await assert.rejects(processor.process(tick([decision()])), /simulated crash/);
        assert.deepEqual(repository.states, before);
        await processor.process(tick([decision()]));
        await processor.process(tick([decision()]));
        assert.equal(repository.commits, 1);
        assert.equal(repository.states?.every(state => state.margin.positions.length === 1), true);
    });

    it('fans blocked and hold decisions without virtual execution', async () => {
        const repository = new MemoryAtomicRepository();
        const blocked = decision({ eventId: 'blocked', decisionId: 'blocked', status: 'blocked', approvedLots: 0 });
        const hold = decision({ eventId: 'hold', decisionId: 'hold', action: 'hold', status: 'hold', approvedLots: 0 });
        await new ShadowScenarioFanoutProcessor(config, repository).process(tick([blocked, hold]));
        assert.equal(repository.states?.every(state => state.margin.positions.length === 0), true);
        assert.equal(repository.states?.every(state => state.decisionAudit.every(audit => audit.executionStatus === 'not-requested')), true);
    });

    it('keeps approximate quotes, missing marks and absent benchmark below the evidence gate', async () => {
        const repository = new MemoryAtomicRepository();
        const evidence = await new ShadowScenarioFanoutProcessor(config, repository).process(tick([decision()]));
        const state = replayObservationTicks(config.experimentId, [evidence]);
        for (const scenario of state.scenarios) {
            const gate = evaluateObservationGate(scenario);
            assert.equal(gate.qualified, false);
            assert(gate.reasons.includes('QUOTE_TIMESTAMP_APPROXIMATE'));
            assert(gate.reasons.includes('MISSING_MARK_EVENT'));
            assert(gate.reasons.includes('BENCHMARK_NOT_IMPLEMENTED'));
        }
    });

    it('does not accept a configured benchmark ID before benchmark observations exist', async () => {
        const repository = new MemoryAtomicRepository();
        const configured = Object.freeze({ ...config, benchmarkId: 'IMOEX' });
        const evidence = await new ShadowScenarioFanoutProcessor(configured, repository).process(tick([decision()]));
        assert.equal(evidence.snapshots.every(snapshot => snapshot.benchmarkAvailable === false), true);
        assert.equal(evidence.snapshots.every(snapshot => snapshot.evidenceQualityReasons?.includes('BENCHMARK_NOT_IMPLEMENTED')), true);
    });

    it('uses buying power once and preserves fee headroom at exact leverage boundaries', async () => {
        const bounded = Object.freeze({
            ...config,
            startingCashKopecks: '1010',
            executionPolicy: Object.freeze({ feeBasisPoints: 100, slippageBasisPoints: 0, maxQuoteAgeMs: 5_000 })
        });
        const statuses = async (lots: number) => {
            const repository = new MemoryAtomicRepository();
            await new ShadowScenarioFanoutProcessor(bounded, repository).process(tick([
                decision({ approvedLots: lots, lotSize: 1, quote: { ...decision().quote, bidKopecks: 100n, askKopecks: 100n, markKopecks: 100n } })
            ], `boundary-${lots}`));
            return repository.states?.map(state => state.decisionAudit[0].executionStatus);
        };
        assert.deepEqual(await statuses(10), ['filled', 'filled', 'filled']);
        assert.deepEqual(await statuses(11), ['rejected', 'filled', 'filled']);
        assert.deepEqual(await statuses(12), ['rejected', 'rejected', 'filled']);
        assert.deepEqual(await statuses(14), ['rejected', 'rejected', 'filled']);
        assert.deepEqual(await statuses(15), ['rejected', 'rejected', 'rejected']);
    });

    it('keeps cumulative breach and invariant history through recovery and processor restart', async () => {
        const bounded = Object.freeze({
            ...config,
            startingCashKopecks: '1010',
            executionPolicy: Object.freeze({ feeBasisPoints: 100, slippageBasisPoints: 0, maxQuoteAgeMs: 5_000 })
        });
        const repository = new MemoryAtomicRepository();
        await new ShadowScenarioFanoutProcessor(bounded, repository).process(tick([
            decision({ approvedLots: 11, lotSize: 1, quote: { ...decision().quote, bidKopecks: 100n, askKopecks: 100n, markKopecks: 100n } })
        ], 'open', '2026-08-31T12:00:01.000Z'));
        repository.states = repository.states?.map(state => Object.freeze({ ...state, invariantViolationCount: 2 }));
        const lowMark: ShadowSourceEvent = {
            kind: 'mark', eventId: 'mark-low', sourceAccountId: 'source-account', instrumentId: 'figi-1',
            markedAt: '2026-08-31T12:01:00.000Z', quote: { bidKopecks: 10n, askKopecks: 10n, markKopecks: 10n,
                quoteObservedAt: '2026-08-31T12:01:00.000Z', quoteTimestampQuality: 'exact-source-timestamp' }
        };
        await new ShadowScenarioFanoutProcessor(bounded, repository).process(tick([lowMark], 'breach', '2026-08-31T12:01:00.000Z'));
        const afterBreach = repository.states?.map(state => state.marginBreachCount) ?? [];
        const recovery = { ...lowMark, eventId: 'mark-recovery', markedAt: '2026-08-31T12:02:00.000Z',
            quote: { ...lowMark.quote, bidKopecks: 100n, askKopecks: 100n, markKopecks: 100n,
                quoteObservedAt: '2026-08-31T12:02:00.000Z' } } as ShadowSourceEvent;
        await new ShadowScenarioFanoutProcessor(bounded, repository).process(tick([recovery], 'recovery', '2026-08-31T12:02:00.000Z'));
        assert.deepEqual(repository.states?.map(state => state.marginBreachCount), afterBreach);
        assert.equal(repository.states?.every(state => state.invariantViolationCount === 2), true);
        assert.equal(afterBreach.some(count => count > 0), true);
    });

    it('persists expected per-scenario margin rejection and commits all three scenarios', async () => {
        const repository = new MemoryAtomicRepository();
        const processor = new ShadowScenarioFanoutProcessor(config, repository);
        await processor.process(tick([decision({ approvedLots: 2, lotSize: 1 })], 'first-buy'));
        const evidence = await processor.process(tick([
            decision({ eventId: 'lot-conflict', decisionId: 'lot-conflict', approvedLots: 1, lotSize: 2,
                evaluatedAt: '2026-08-31T12:01:00.000Z', quote: { ...decision().quote,
                    quoteObservedAt: '2026-08-31T12:01:00.000Z' } })
        ], 'margin-reject', '2026-08-31T12:01:01.000Z'));
        assert.equal(repository.commits, 2);
        assert.equal(repository.states?.every(state => state.margin.positions[0]?.quantityLots === 2), true);
        assert.equal(repository.states?.every(state => state.decisionAudit.at(-1)?.executionStatus === 'margin-rejected'), true);
        assert.equal(repository.states?.every(state => state.margin.audit.at(-1)?.outcome === 'rejected'), true);
        assert.equal(evidence.snapshots.every(snapshot => snapshot.evidenceQualityReasons?.includes('SCENARIO_MARGIN_REJECTION')), true);
    });

    it('persists breach as reduce-only, then deterministically liquidates and recovers', async () => {
        const bounded = Object.freeze({ ...config, startingCashKopecks: '1010',
            executionPolicy: Object.freeze({ feeBasisPoints: 100, slippageBasisPoints: 100, maxQuoteAgeMs: 5_000 }) });
        const repository = new MemoryAtomicRepository();
        const processor = new ShadowScenarioFanoutProcessor(bounded, repository);
        await processor.process(tick([decision({ approvedLots: 14, lotSize: 1,
            quote: { ...decision().quote, bidKopecks: 100n, askKopecks: 100n, markKopecks: 100n } })], 'pm07-open'));
        const shock: ShadowSourceEvent = { kind: 'mark', eventId: 'pm07-shock', sourceAccountId: 'source-account',
            instrumentId: 'figi-1', markedAt: '2026-08-31T12:01:00.000Z', quote: { bidKopecks: 37n, askKopecks: 37n,
                markKopecks: 37n, quoteObservedAt: '2026-08-31T12:01:00.000Z', quoteTimestampQuality: 'exact-source-timestamp' } };
        await processor.process(tick([shock], 'pm07-shock', '2026-08-31T12:01:00.000Z'));
        const breached = repository.states?.find(state => state.scenarioId === '1.5x');
        assert.equal(breached?.safetyMode, 'reduce-only');
        assert.deepEqual(breached?.liquidationPlan?.instrumentIds, ['figi-1']);
        assert.equal(breached?.safetyAudit.at(-1)?.outcome, 'planned');

        await processor.process(tick([{ ...shock, eventId: 'pm07-liquidation-mark', markedAt: '2026-08-31T12:01:01.000Z',
            quote: { ...shock.quote, quoteObservedAt: '2026-08-31T12:01:01.000Z' } }], 'pm07-liquidate', '2026-08-31T12:01:01.000Z'));
        const recovered = repository.states?.find(state => state.scenarioId === '1.5x');
        assert.equal(recovered?.margin.positions.length, 0);
        assert.equal(recovered?.safetyMode, 'normal');
        assert.equal(recovered?.liquidationPlan, undefined);
        assert.equal(recovered?.marginBreachCount, 1);
        assert.equal(recovered?.liquidationFailureCount, 0);
        assert.equal(recovered?.safetyAudit.at(-1)?.outcome, 'applied');
        const liquidation = recovered?.margin.audit.find(entry => entry.eventId.includes('forced-liquidate:'));
        assert.equal(liquidation?.event.kind, 'sell');
        assert.equal(liquidation?.event.kind === 'sell' && liquidation.event.executionPriceKopecks, 36n);
        assert.equal(liquidation?.event.kind === 'sell' && liquidation.event.feeKopecks, 6n);
        const risk = recovered && marginRiskSnapshot(recovered.margin);
        assert.equal(risk?.equityKopecks, 78n);
        assert.equal(recovered?.margin.cashKopecks, 78n);
        assert.equal(recovered?.margin.debtKopecks, 0n);
        assert.equal(risk?.maintenanceSatisfied, true);
    });

    it('rejects averaging in reduce-only locally while preserving other scenarios and cumulative failures', async () => {
        const bounded = Object.freeze({ ...config, startingCashKopecks: '1010',
            executionPolicy: Object.freeze({ feeBasisPoints: 100, slippageBasisPoints: 0, maxQuoteAgeMs: 5_000 }) });
        const repository = new MemoryAtomicRepository();
        const processor = new ShadowScenarioFanoutProcessor(bounded, repository);
        await processor.process(tick([decision({ approvedLots: 14, lotSize: 1,
            quote: { ...decision().quote, bidKopecks: 100n, askKopecks: 100n, markKopecks: 100n } })], 'isolation-open'));
        const shock: ShadowSourceEvent = { kind: 'mark', eventId: 'isolation-shock', sourceAccountId: 'source-account',
            instrumentId: 'figi-1', markedAt: '2026-08-31T12:01:00.000Z', quote: { bidKopecks: 37n, askKopecks: 37n,
                markKopecks: 37n, quoteObservedAt: '2026-08-31T12:01:00.000Z', quoteTimestampQuality: 'exact-source-timestamp' } };
        await processor.process(tick([shock], 'isolation-shock', '2026-08-31T12:01:00.000Z'));
        await processor.process(tick([decision({ eventId: 'no-average', decisionId: 'no-average', instrumentId: 'figi-2',
            approvedLots: 1, lotSize: 1, evaluatedAt: '2026-08-31T12:01:01.000Z', quote: { ...decision().quote,
                quoteObservedAt: '2026-08-31T12:01:01.000Z' } })], 'isolation-buy', '2026-08-31T12:01:01.000Z'));
        const reduced = repository.states?.find(state => state.scenarioId === '1.5x');
        assert.equal(reduced?.decisionAudit.at(-1)?.rejectionReason, 'scenario is reduce-only');
        assert.equal(reduced?.margin.positions.some(position => position.instrumentId === 'figi-2'), false);
        assert.equal(reduced?.liquidationFailureCount, 1);
        assert.equal(repository.states?.filter(state => state.scenarioId !== '1.5x')
            .every(state => state.margin.positions.some(position => position.instrumentId === 'figi-2')), true);
    });

    it('keeps liquidation plan atomic across crash and applies replay once', async () => {
        const bounded = Object.freeze({ ...config, startingCashKopecks: '1010',
            executionPolicy: Object.freeze({ feeBasisPoints: 100, slippageBasisPoints: 0, maxQuoteAgeMs: 5_000 }) });
        const repository = new MemoryAtomicRepository();
        const processor = new ShadowScenarioFanoutProcessor(bounded, repository);
        await processor.process(tick([decision({ approvedLots: 14, lotSize: 1,
            quote: { ...decision().quote, bidKopecks: 100n, askKopecks: 100n, markKopecks: 100n } })], 'replay-open'));
        const shock: ShadowSourceEvent = { kind: 'mark', eventId: 'replay-shock', sourceAccountId: 'source-account',
            instrumentId: 'figi-1', markedAt: '2026-08-31T12:01:00.000Z', quote: { bidKopecks: 37n, askKopecks: 37n,
                markKopecks: 37n, quoteObservedAt: '2026-08-31T12:01:00.000Z', quoteTimestampQuality: 'exact-source-timestamp' } };
        await processor.process(tick([shock], 'replay-shock', '2026-08-31T12:01:00.000Z'));
        const before = repository.states;
        const liquidationTick = tick([{ ...shock, eventId: 'replay-liquidate', markedAt: '2026-08-31T12:01:01.000Z',
            quote: { ...shock.quote, quoteObservedAt: '2026-08-31T12:01:01.000Z' } }], 'replay-liquidate', '2026-08-31T12:01:01.000Z');
        repository.failNext = true;
        await assert.rejects(processor.process(liquidationTick), /simulated crash/);
        assert.deepEqual(repository.states, before);
        await processor.process(liquidationTick);
        await processor.process(liquidationTick);
        const state = repository.states?.find(item => item.scenarioId === '1.5x');
        assert.equal(state?.safetyAudit.filter(entry => entry.outcome === 'applied').length, 1);
        assert.equal(state?.margin.positions.length, 0);
    });

    it("keeps v1 initialization and evidence semantics unchanged", async () => {
        const initial = openShadowScenarioStates(config, "2026-08-31T12:00:00.000Z");
        assert.equal(initial.every(state => state.qualityReasons.length === 1
            && state.qualityReasons[0] === "BENCHMARK_NOT_IMPLEMENTED"), true);
        const repository = new MemoryAtomicRepository();
        const evidence = await new ShadowScenarioFanoutProcessor(config, repository).process(tick([decision()]));
        assert.equal(evidence.snapshots.every(snapshot => snapshot.benchmarkAvailable === false), true);
        assert.equal(repository.lastCommit?.marketEvidence, undefined);
    });

    it("fails closed for v2 when the qualified loader is absent", async () => {
        const repository = new MemoryAtomicRepository();
        await assert.rejects(new ShadowScenarioFanoutProcessor(v2Config, repository).process(tick([decision()])),
            /qualified evidence loader is required/);
        assert.equal(repository.commits, 0);
        assert.equal(repository.states?.every(state => state.qualityReasons.includes("BENCHMARK_NOT_IMPLEMENTED") === false), true);
    });

    it("uses execution-only source quotes then one shared qualified mark set", async () => {
        const repository = new MemoryAtomicRepository();
        let loads = 0;
        const evidence = await new ShadowScenarioFanoutProcessor(v2Config, repository, {
            async loadAsOf(input) {
                loads += 1;
                assert.deepEqual(input, { instrumentUids: ["benchmark-uid", "figi-1"],
                    valuationAt: "2026-08-31T12:00:01.000Z" });
                return [marketMark("figi-1", 120n), marketMark("benchmark-uid", 200n)];
            },
            async loadBenchmarkHistory() { return {}; }
        }).process(tick([decision()]));
        assert.equal(loads, 1);
        assert.equal(repository.states?.every(state => state.margin.positions[0]?.markPriceKopecks === 120n), true);
        assert.equal(repository.states?.every(state => state.margin.audit.some(entry => entry.eventId.startsWith("mark:event-1")) === false), true);
        assert.equal(repository.states?.every(state => state.margin.audit.some(entry => entry.eventId.startsWith("qualified-mark:"))), true);
        assert.equal(evidence.snapshots.every(snapshot => snapshot.benchmarkAvailable === true), true);
        const result = repository.lastCommit?.marketEvidence;
        assert.equal(result?.quality, "qualified");
        if (result?.quality !== "qualified") return;
        assert.equal(result.benchmark.points.length, 3);
        assert.equal(new Set(result.benchmark.points.map(item => item.point.observationId)).size, 1);
        assert.equal(result.markSet.sourceTickId, "source-tick-1");
        assert.equal(result.initialEquityKopecks, BigInt(v2Config.startingCashKopecks));
    });

    it("commits typed rejection while preserving virtual processing", async () => {
        const repository = new MemoryAtomicRepository();
        const evidence = await new ShadowScenarioFanoutProcessor(v2Config, repository, {
            async loadAsOf() { return [marketMark("benchmark-uid", 200n)]; },
            async loadBenchmarkHistory() { throw new Error("history must not load for rejection"); }
        }).process(tick([decision()]));
        assert.equal(repository.states?.every(state => state.margin.positions[0]?.quantityLots === 2), true);
        assert.equal(repository.states?.every(state => state.qualityReasons.includes("MISSING_REQUIRED_MARK:figi-1")), true);
        const result = repository.lastCommit?.marketEvidence;
        assert.deepEqual(result, { quality: "rejected", sourceTickId: "source-tick-1",
            valuationAt: "2026-08-31T12:00:01.000Z", reasons: ["MISSING_REQUIRED_MARK:figi-1"] });
        assert.equal(evidence.snapshots.every(snapshot => snapshot.benchmarkAvailable === false), true);
    });

    it("continues benchmark baseline and last points across ticks and processor restart", async () => {
        const repository = new MemoryAtomicRepository();
        let currentMarks = [marketMark("figi-1", 120n), marketMark("benchmark-uid", 200n)];
        const loader = {
            async loadAsOf() { return currentMarks; },
            async loadBenchmarkHistory() {
                const prior = repository.lastCommit?.marketEvidence;
                return prior?.quality === "qualified" ? { baseline: prior.benchmark.baseline,
                    lastPoints: prior.benchmark.points.map(item => ({ scenarioId: item.scenarioId, point: item.point })) } : {};
            }
        };
        await new ShadowScenarioFanoutProcessor(v2Config, repository, loader).process(tick([decision()]));
        const first = repository.lastCommit?.marketEvidence;
        assert.equal(first?.quality, "qualified");
        if (first?.quality !== "qualified") return;
        currentMarks = [marketMark("figi-1", 121n, "2026-08-31T12:00:01.500Z", "2"),
            marketMark("benchmark-uid", 210n, "2026-08-31T12:00:01.500Z", "2")];
        const hold = decision({ eventId: "event-2", decisionId: "decision-2", action: "hold", status: "hold", approvedLots: 0,
            evaluatedAt: "2026-08-31T12:00:01.000Z", quote: { ...decision().quote, quoteObservedAt: "2026-08-31T12:00:01.000Z" } });
        await new ShadowScenarioFanoutProcessor(v2Config, repository, loader)
            .process(tick([hold], "source-tick-2", "2026-08-31T12:00:02.000Z"));
        const second = repository.lastCommit?.marketEvidence;
        assert.equal(second?.quality, "qualified");
        if (second?.quality !== "qualified") return;
        assert.deepEqual(second.benchmark.baseline, first.benchmark.baseline);
        assert.equal(second.benchmark.points.every(item => item.point.observationId.endsWith(":2")), true);
        assert.equal(second.benchmark.points.every(item => item.point.benchmarkReturnBps === 500n), true);
    });



    it("keeps pending liquidation on rejection then sells from qualified bid in phase order", async () => {
        const boundedV2: ObservationExperimentConfigV2 = Object.freeze({
            ...v2Config, experimentId: "liquidation-v2", startingCashKopecks: "1010",
            executionPolicy: Object.freeze({ feeBasisPoints: 100, slippageBasisPoints: 100, maxQuoteAgeMs: 5_000 })
        });
        const repository = new MemoryAtomicRepository();
        let currentMarks = [marketMark("figi-1", 100n), marketMark("benchmark-uid", 200n)];
        let history: Awaited<ReturnType<import("./shadow-scenario-fanout").QualifiedFanoutEvidenceLoader["loadBenchmarkHistory"]>> = {};
        const captureHistory = () => {
            const result = repository.lastCommit?.marketEvidence;
            if (result?.quality === "qualified") history = { baseline: result.benchmark.baseline,
                lastPoints: result.benchmark.points.map(item => ({ scenarioId: item.scenarioId, point: item.point })) };
        };
        const loader = {
            async loadAsOf() { return currentMarks; },
            async loadBenchmarkHistory() { return history; }
        };
        const buy = decision({ approvedLots: 14, lotSize: 1,
            quote: { ...decision().quote, bidKopecks: 100n, askKopecks: 100n, markKopecks: 100n } });
        await new ShadowScenarioFanoutProcessor(boundedV2, repository, loader).process(tick([buy], "liq-1"));
        captureHistory();

        const sourceShock: ShadowSourceEvent = { kind: "mark", eventId: "source-shock", sourceAccountId: "source-account",
            instrumentId: "figi-1", markedAt: "2026-08-31T12:01:00.000Z", quote: { bidKopecks: 5n, askKopecks: 5n,
                markKopecks: 5n, quoteObservedAt: "2026-08-31T12:01:00.000Z", quoteTimestampQuality: "exact-source-timestamp" } };
        currentMarks = [marketMark("figi-1", 37n, "2026-08-31T12:00:59.500Z", "2"),
            marketMark("benchmark-uid", 190n, "2026-08-31T12:00:59.500Z", "2")];
        await new ShadowScenarioFanoutProcessor(boundedV2, repository, loader)
            .process(tick([sourceShock], "liq-2", "2026-08-31T12:01:00.000Z"));
        captureHistory();
        const planned = repository.states?.find(state => state.scenarioId === "1.5x");
        assert.equal(planned?.safetyMode, "reduce-only");
        assert.deepEqual(planned?.liquidationPlan?.instrumentIds, ["figi-1"]);

        currentMarks = [marketMark("benchmark-uid", 190n, "2026-08-31T12:01:59.500Z", "3")];
        await new ShadowScenarioFanoutProcessor(boundedV2, repository, loader)
            .process(tick([{ ...sourceShock, eventId: "source-rejected", markedAt: "2026-08-31T12:02:00.000Z",
                quote: { ...sourceShock.quote, quoteObservedAt: "2026-08-31T12:02:00.000Z" } }], "liq-3", "2026-08-31T12:02:00.000Z"));
        const rejected = repository.states?.find(state => state.scenarioId === "1.5x");
        assert.equal(rejected?.liquidationPlan?.planId, planned?.liquidationPlan?.planId);
        assert.equal(rejected?.safetyAudit.filter(entry => entry.outcome === "applied").length, 0);
        assert.deepEqual(repository.lastCommit?.marketEvidence, { quality: "rejected", sourceTickId: "liq-3",
            valuationAt: "2026-08-31T12:02:00.000Z", reasons: ["MISSING_REQUIRED_MARK:figi-1"] });

        currentMarks = [marketMark("figi-1", 37n, "2026-08-31T12:02:59.500Z", "4"),
            marketMark("benchmark-uid", 190n, "2026-08-31T12:02:59.500Z", "4")];
        await new ShadowScenarioFanoutProcessor(boundedV2, repository, loader)
            .process(tick([{ ...sourceShock, eventId: "source-qualified", markedAt: "2026-08-31T12:03:00.000Z",
                quote: { ...sourceShock.quote, quoteObservedAt: "2026-08-31T12:03:00.000Z" } }], "liq-4", "2026-08-31T12:03:00.000Z"));
        const liquidated = repository.states?.find(state => state.scenarioId === "1.5x");
        assert.equal(liquidated?.margin.positions.length, 0);
        const audit = liquidated?.margin.audit ?? [];
        const interestIndex = audit.findIndex(entry => entry.eventId === "interest:qualified:liq-4:1.5x");
        const markIndex = audit.findIndex(entry => entry.eventId.startsWith("qualified-mark:")
            && entry.event.kind === "mark" && entry.event.occurredAt === "2026-08-31T12:03:00.000Z");
        const sellIndex = audit.findIndex(entry => entry.eventId.includes("forced-liquidate:"));
        assert.equal(interestIndex >= 0 && interestIndex < markIndex && markIndex < sellIndex, true);
        const sell = audit[sellIndex]?.event;
        assert.equal(sell?.kind, "sell");
        assert.equal(sell?.kind === "sell" && sell.executionPriceKopecks, 35n);
        assert.equal(audit.some(entry => entry.eventId.includes("source-qualified")), false);
    });


    it("accrues debt at every v2 decision timestamp before the completed-at mark phase", async () => {
        const debtConfig: ObservationExperimentConfigV2 = Object.freeze({
            ...v2Config, experimentId: "decision-interest-v2", startingCashKopecks: "1010",
            executionPolicy: Object.freeze({ feeBasisPoints: 100, slippageBasisPoints: 0, maxQuoteAgeMs: 5_000 })
        });
        const repository = new MemoryAtomicRepository();
        let currentMarks = [marketMark("figi-1", 100n), marketMark("benchmark-uid", 200n)];
        let history: Awaited<ReturnType<import("./shadow-scenario-fanout").QualifiedFanoutEvidenceLoader["loadBenchmarkHistory"]>> = {};
        const loader = {
            async loadAsOf() { return currentMarks; },
            async loadBenchmarkHistory() { return history; }
        };
        const buy = decision({ approvedLots: 14, lotSize: 1,
            quote: { ...decision().quote, bidKopecks: 100n, askKopecks: 100n, markKopecks: 100n } });
        await new ShadowScenarioFanoutProcessor(debtConfig, repository, loader).process(tick([buy], "interest-1"));
        const first = repository.lastCommit?.marketEvidence;
        assert.equal(first?.quality, "qualified");
        if (first?.quality !== "qualified") return;
        history = { baseline: first.benchmark.baseline,
            lastPoints: first.benchmark.points.map(item => ({ scenarioId: item.scenarioId, point: item.point })) };
        currentMarks = [marketMark("figi-1", 100n, "2026-08-31T12:00:03.500Z", "interest-2"),
            marketMark("benchmark-uid", 200n, "2026-08-31T12:00:03.500Z", "interest-2")];
        const holdAt = (eventId: string, evaluatedAt: string) => decision({ eventId, decisionId: eventId,
            action: "hold", status: "hold", approvedLots: 0, evaluatedAt,
            quote: { ...decision().quote, quoteObservedAt: evaluatedAt } });
        await new ShadowScenarioFanoutProcessor(debtConfig, repository, loader).process(tick([
            holdAt("interest-decision-1", "2026-08-31T12:00:02.000Z"),
            holdAt("interest-decision-2", "2026-08-31T12:00:03.000Z")
        ], "interest-2", "2026-08-31T12:00:04.000Z"));
        const leveraged = repository.states?.find(state => state.scenarioId === "1.5x");
        const accrualTimes = leveraged?.margin.audit
            .filter(entry => entry.event.kind === "interest" && entry.event.occurredAt > "2026-08-31T12:00:01.000Z")
            .map(entry => entry.event.occurredAt);
        assert.deepEqual(accrualTimes, ["2026-08-31T12:00:02.000Z", "2026-08-31T12:00:03.000Z",
            "2026-08-31T12:00:04.000Z"]);
        const finalMark = leveraged?.margin.audit.find(entry => entry.event.kind === "mark"
            && entry.event.occurredAt === "2026-08-31T12:00:04.000Z");
        assert.equal(finalMark?.event.kind, "mark");
    });

    it("clears prior tick market rejection reasons when the next v2 tick qualifies", async () => {
        const repository = new MemoryAtomicRepository();
        let currentMarks = [marketMark("figi-1", 100n, "2026-08-31T11:59:50.000Z", "stale"),
            marketMark("benchmark-uid", 200n)];
        const loader = {
            async loadAsOf() { return currentMarks; },
            async loadBenchmarkHistory() { return {}; }
        };
        const firstHold = decision({ action: "hold", status: "hold", approvedLots: 0 });
        await new ShadowScenarioFanoutProcessor(v2Config, repository, loader).process(tick([firstHold], "stale-1"));
        assert.equal(repository.states?.every(state => state.qualityReasons.includes("STALE_MARK:figi-1")), true);
        assert.equal(repository.states?.every(state => state.qualityReasons.includes("QUOTE_TIMESTAMP_APPROXIMATE")), true);

        currentMarks = [marketMark("figi-1", 101n, "2026-08-31T12:00:01.500Z", "fresh"),
            marketMark("benchmark-uid", 201n, "2026-08-31T12:00:01.500Z", "fresh")];
        const secondHold = decision({ eventId: "fresh-event", decisionId: "fresh-decision", action: "hold", status: "hold",
            approvedLots: 0, evaluatedAt: "2026-08-31T12:00:01.000Z",
            quote: { ...decision().quote, quoteObservedAt: "2026-08-31T12:00:01.000Z" } });
        const evidence = await new ShadowScenarioFanoutProcessor(v2Config, repository, loader)
            .process(tick([secondHold], "fresh-2", "2026-08-31T12:00:02.000Z"));
        assert.equal(evidence.snapshots.every(snapshot => snapshot.benchmarkAvailable), true);
        assert.equal(repository.states?.every(state => state.qualityReasons.includes("STALE_MARK:figi-1") === false), true);
        assert.equal(repository.states?.every(state => state.qualityReasons.includes("QUOTE_TIMESTAMP_APPROXIMATE")), true);
        assert.equal(repository.lastCommit?.marketEvidence?.quality, "qualified");
    });

});
