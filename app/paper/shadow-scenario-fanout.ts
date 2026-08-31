import { createHash } from 'node:crypto';
import { adaptPostRiskDecisionToShadowIntent } from './shadow-intent.adapter';
import { ShadowRunner } from './shadow-runner';
import type { CompleteShadowSourceTick, ShadowSourceEvent } from './shadow-source-outbox';
import type { ClaimedShadowSourceTick } from './shadow-source-outbox';
import type { VirtualObservationRuntime } from './shadow-composition';
import type { ObservationExperimentConfig } from './observation-persistence';
import {
    applyMarginScenarioEvent,
    marginRiskSnapshot,
    MarginScenarioState,
    openMarginScenario
} from '../virtual/margin';
import {
    DeterministicVirtualExecutionSimulator,
    VirtualExecutionResult
} from '../virtual/execution';
import type { ObservationTick } from '../virtual/observation-runner';

export const FANOUT_SCENARIO_IDS = Object.freeze(['1.0x', '1.2x', '1.5x'] as const);
export type FanoutScenarioId = typeof FANOUT_SCENARIO_IDS[number];

export interface ShadowScenarioState {
    readonly scenarioId: FanoutScenarioId;
    readonly virtualAccountId: string;
    readonly margin: MarginScenarioState;
    readonly closedVirtualTrades: number;
    readonly invariantViolationCount: number;
    readonly marginBreachCount: number;
    readonly rejectedExecutionCount: number;
    readonly qualityReasons: readonly string[];
    readonly decisionAudit: readonly {
        readonly eventId: string;
        readonly decisionId: string;
        readonly action: string;
        readonly status: string;
        readonly executionStatus: 'not-requested' | 'filled' | 'rejected' | 'margin-rejected';
        readonly rejectionReason?: string;
    }[];
}

export interface AtomicShadowFanoutCommit {
    readonly experimentId: string;
    readonly sourceTick: CompleteShadowSourceTick;
    readonly previous: readonly ShadowScenarioState[];
    readonly next: readonly ShadowScenarioState[];
    readonly evidenceTick: ObservationTick;
}

export interface AtomicShadowFanoutRepository {
    hasCheckpoint(experimentId: string, sourceTick: CompleteShadowSourceTick): Promise<boolean>;
    loadOrInitialize(config: ObservationExperimentConfig, openedAt: string): Promise<readonly ShadowScenarioState[]>;
    commit(input: AtomicShadowFanoutCommit): Promise<'applied' | 'idempotent'>;
}

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
export const shadowScenarioStateFingerprint = (state: ShadowScenarioState) => sha256(JSON.stringify(state, (_key, value) =>
    typeof value === 'bigint' ? value.toString() : value
));

const scenarioAccountId = (experimentId: string, scenarioId: FanoutScenarioId) =>
    `virtual:${experimentId}:${scenarioId}`;

export const openShadowScenarioStates = (
    config: ObservationExperimentConfig,
    openedAt: string
): readonly ShadowScenarioState[] => Object.freeze(FANOUT_SCENARIO_IDS.map((scenarioId, index) => {
    const policy = config.marginPolicies[index];
    if (!policy || (policy.leverage === '1x' ? '1.0x' : policy.leverage) !== scenarioId) {
        throw new Error(`experiment margin policy mismatch: ${scenarioId}`);
    }
    const virtualAccountId = scenarioAccountId(config.experimentId, scenarioId);
    return Object.freeze({
        scenarioId,
        virtualAccountId,
        margin: openMarginScenario({
            scenarioId,
            virtualAccountId,
            startingCashKopecks: BigInt(config.startingCashKopecks),
            policy,
            openedAt
        }),
        closedVirtualTrades: 0,
        invariantViolationCount: 0,
        marginBreachCount: 0,
        rejectedExecutionCount: 0,
        qualityReasons: Object.freeze(['BENCHMARK_NOT_IMPLEMENTED']),
        decisionAudit: Object.freeze([])
    });
}));

const qualityForEvent = (event: ShadowSourceEvent) => {
    const reasons: string[] = [];
    if (event.quote.quoteTimestampQuality === 'captured-after-read') reasons.push('QUOTE_TIMESTAMP_APPROXIMATE');
    if (event.quote.bidKopecks === event.quote.askKopecks) reasons.push('COLLAPSED_SPREAD');
    return reasons;
};

const availableLots = (state: ShadowScenarioState, instrumentId: string) =>
    state.margin.positions.find(position => position.instrumentId === instrumentId)?.quantityLots ?? 0;

const accrueInterest = (state: ShadowScenarioState, at: string, eventId: string): ShadowScenarioState => {
    if (state.margin.debtKopecks === 0n || state.margin.interestAccruedThroughAt === at) return state;
    const result = applyMarginScenarioEvent(state.margin, {
        id: `interest:${eventId}:${state.scenarioId}`,
        kind: 'interest',
        occurredAt: at,
        fromAt: state.margin.interestAccruedThroughAt,
        toAt: at
    });
    if (result.outcome === 'rejected') throw new Error(result.reason ?? 'margin interest rejected');
    return Object.freeze({ ...state, margin: result.state });
};

const applyMark = (state: ShadowScenarioState, event: ShadowSourceEvent): ShadowScenarioState => {
    if (!state.margin.positions.some(position => position.instrumentId === event.instrumentId)) return state;
    const at = event.kind === 'mark' ? event.markedAt : event.evaluatedAt;
    const result = applyMarginScenarioEvent(state.margin, {
        id: `mark:${event.eventId}:${state.scenarioId}`,
        kind: 'mark', instrumentId: event.instrumentId,
        occurredAt: at, observedAt: event.quote.quoteObservedAt,
        priceKopecks: event.quote.markKopecks
    });
    if (result.outcome === 'rejected') throw new Error(result.reason ?? 'margin mark rejected');
    return Object.freeze({ ...state, margin: result.state });
};

const processDecision = async (
    source: ShadowScenarioState,
    event: Extract<ShadowSourceEvent, { kind: 'decision' }>,
    config: ObservationExperimentConfig
): Promise<ShadowScenarioState> => {
    let state = accrueInterest(source, event.evaluatedAt, event.eventId);
    state = applyMark(state, event);
    let execution: VirtualExecutionResult | undefined;
    let marginRejectionReason: string | undefined;
    const simulator = new DeterministicVirtualExecutionSimulator();
    const runner = new ShadowRunner(true, { async append() { /* persisted with atomic scenario audit */ } }, {
        async execute(intent, quote, context, policy) {
            const risk = marginRiskSnapshot(state.margin);
            execution = simulator.execute(intent, quote, {
                now: context.now,
                cashKopecks: risk.buyingPowerKopecks,
                availableLots: context.availableLots
            }, policy);
            return execution;
        }
    });
    const adaptation = adaptPostRiskDecisionToShadowIntent({
        decisionStage: 'post-risk-policy',
        decisionId: `${event.decisionId}:${state.scenarioId}`,
        virtualAccountId: state.virtualAccountId,
        instrumentId: event.instrumentId,
        evaluatedAt: event.evaluatedAt,
        action: event.action,
        status: event.status,
        approvedLots: event.approvedLots || undefined,
        source: event.sourceAccountId,
        reason: event.reason
    });
    await runner.run({
        adaptation,
        ...(adaptation.intent ? {
            quote: {
                instrumentId: event.instrumentId,
                bidKopecks: event.quote.bidKopecks,
                askKopecks: event.quote.askKopecks,
                lotSize: event.lotSize,
                observedAt: event.quote.quoteObservedAt
            },
            availableLots: availableLots(state, event.instrumentId),
            policy: config.executionPolicy
        } : {})
    });
    if (execution?.status === 'filled') {
        const fill = execution.fill;
        const applied = applyMarginScenarioEvent(state.margin, fill.side === 'buy' ? {
            id: `execution:${event.eventId}:${state.scenarioId}`,
            kind: 'buy', instrumentId: fill.instrumentId, quantityLots: fill.quantityLots,
            executionPriceKopecks: fill.executionPriceKopecks, feeKopecks: fill.feeKopecks,
            occurredAt: fill.filledAt, lotSize: fill.lotSize
        } : {
            id: `execution:${event.eventId}:${state.scenarioId}`,
            kind: 'sell', instrumentId: fill.instrumentId, quantityLots: fill.quantityLots,
            executionPriceKopecks: fill.executionPriceKopecks, feeKopecks: fill.feeKopecks,
            occurredAt: fill.filledAt
        });
        if (applied.outcome === 'rejected') {
            marginRejectionReason = applied.reason ?? 'margin execution rejected';
            state = applyQuality(Object.freeze({
                ...state,
                margin: applied.state,
                rejectedExecutionCount: state.rejectedExecutionCount + 1
            }), ['SCENARIO_MARGIN_REJECTION']);
        } else {
            state = Object.freeze({ ...state, margin: applied.state,
                closedVirtualTrades: state.closedVirtualTrades + (fill.side === 'sell' ? 1 : 0) });
        }
    }
    return Object.freeze({
        ...state,
        decisionAudit: Object.freeze([...state.decisionAudit, Object.freeze({
            eventId: event.eventId,
            decisionId: event.decisionId,
            action: event.action,
            status: event.status,
            executionStatus: marginRejectionReason ? 'margin-rejected' : execution?.status ?? 'not-requested',
            ...(marginRejectionReason ? { rejectionReason: marginRejectionReason } : {})
        })])
    });
};

const applyQuality = (state: ShadowScenarioState, reasons: readonly string[]): ShadowScenarioState => Object.freeze({
    ...state,
    qualityReasons: Object.freeze([...new Set([...state.qualityReasons, ...reasons])].sort())
});

export class ShadowScenarioFanoutProcessor {
    constructor(
        private readonly config: ObservationExperimentConfig,
        private readonly repository: AtomicShadowFanoutRepository
    ) {}

    async process(sourceTick: CompleteShadowSourceTick): Promise<ObservationTick> {
        if (await this.repository.hasCheckpoint(this.config.experimentId, sourceTick)) {
            return Object.freeze({ tickId: `fanout:${sourceTick.sourceTickId}`, observedAt: sourceTick.completedAt, snapshots: Object.freeze([]) });
        }
        const previous = await this.repository.loadOrInitialize(this.config, sourceTick.startedAt);
        if (previous.length !== 3) throw new Error('atomic fanout requires exactly three scenario states');
        let next = [...previous];
        const explicitMarks = new Set(sourceTick.events.filter(event => event.kind === 'mark').map(event => event.instrumentId));
        for (const event of sourceTick.events) {
            next = await Promise.all(next.map(async scenario => {
                let state = applyQuality(scenario, qualityForEvent(event));
                if (event.kind === 'mark') {
                    state = accrueInterest(state, event.markedAt, event.eventId);
                    return applyMark(state, event);
                }
                return processDecision(state, event, this.config);
            }));
        }
        next = next.map(state => {
            const missing = state.margin.positions.some(position => !explicitMarks.has(position.instrumentId));
            return applyQuality(state, missing ? ['MISSING_MARK_EVENT'] : []);
        });
        next = next.map(state => {
            const before = previous.find(item => item.scenarioId === state.scenarioId);
            if (!before) throw new Error(`missing previous scenario: ${state.scenarioId}`);
            const priorRisk = marginRiskSnapshot(before.margin);
            const risk = marginRiskSnapshot(state.margin);
            if (!risk.reconciled) throw new Error(`scenario accounting invariant corrupted: ${state.scenarioId}`);
            return Object.freeze({
                ...state,
                invariantViolationCount: state.invariantViolationCount,
                marginBreachCount: state.marginBreachCount
                    + (priorRisk.maintenanceSatisfied && !risk.maintenanceSatisfied ? 1 : 0)
            });
        });
        const evidenceTick: ObservationTick = Object.freeze({
            tickId: `fanout:${sourceTick.sourceTickId}`,
            observedAt: sourceTick.completedAt,
            snapshots: Object.freeze(next.map(state => {
                const risk = marginRiskSnapshot(state.margin);
                return Object.freeze({
                    virtualAccountId: state.virtualAccountId,
                    scenarioId: state.scenarioId,
                    equityKopecks: risk.equityKopecks,
                    closedVirtualTrades: state.closedVirtualTrades,
                    invariantViolationCount: state.invariantViolationCount,
                    unknownUnreconciledOrderCount: 0,
                    marginBreachCount: state.marginBreachCount,
                    feesIncluded: configHasExplicitCosts(this.config),
                    slippageIncluded: this.config.executionPolicy.slippageBasisPoints > 0,
                    financingIncluded: state.margin.policy.leverage === '1x' || state.margin.policy.annualInterestBps > 0,
                    benchmarkAvailable: false,
                    evidenceQualityReasons: state.qualityReasons
                });
            }))
        });
        await this.repository.commit({ experimentId: this.config.experimentId, sourceTick, previous, next, evidenceTick });
        return evidenceTick;
    }
}

const configHasExplicitCosts = (config: ObservationExperimentConfig) =>
    Number.isSafeInteger(config.executionPolicy.feeBasisPoints) && config.executionPolicy.feeBasisPoints >= 0;

export interface CompletedShadowTickSource {
    claimNext(consumerId: string, leaseMs: number): Promise<ClaimedShadowSourceTick | undefined>;
}

export class OutboxShadowFanoutRuntime implements VirtualObservationRuntime {
    private running?: Promise<ObservationTick | undefined>;

    constructor(
        private readonly source: CompletedShadowTickSource,
        private readonly processor: ShadowScenarioFanoutProcessor,
        private readonly consumerId: string,
        private readonly claimLeaseMs: number
    ) {}

    async initialize() { return undefined; }

    async tick(): Promise<ObservationTick | undefined> {
        if (this.running) return this.running;
        this.running = this.consumeOne();
        try { return await this.running; } finally { this.running = undefined; }
    }

    private async consumeOne(): Promise<ObservationTick | undefined> {
        const claimed = await this.source.claimNext(this.consumerId, this.claimLeaseMs);
        if (!claimed) return undefined;
        const evidence = await this.processor.process(claimed.tick);
        if (!await claimed.acknowledge()) throw new Error(`source acknowledgement lease lost: ${claimed.tick.sourceTickId}`);
        return evidence;
    }
}
