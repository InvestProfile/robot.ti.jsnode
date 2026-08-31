import { createHash } from 'node:crypto';
import { adaptPostRiskDecisionToShadowIntent } from './shadow-intent.adapter';
import { ShadowRunner } from './shadow-runner';
import type { CompleteShadowSourceTick, ShadowSourceEvent } from './shadow-source-outbox';
import type { ClaimedShadowSourceTick } from './shadow-source-outbox';
import type { VirtualObservationRuntime } from './shadow-composition';
import type { ObservationExperimentConfig, ObservationExperimentConfigV2 } from './observation-persistence';
import {
    applyQualifiedMarksToScenarios,
    buildQualifiedBenchmarkEvidence,
    prepareQualifiedShadowTick,
    type PersistedScenarioBenchmarkPoint,
    type QualifiedMarketEvidenceLoader
} from './qualified-shadow-evidence';
import type { MarketMarkQualificationReason, QualifiedMarketMarkSet } from './qualified-market-mark-set';
import type { BenchmarkBaseline } from '../virtual/benchmark';
import {
    applyMarginScenarioEvent,
    marginRiskSnapshot,
    MarginScenarioState,
    openMarginScenario
} from '../virtual/margin';
import {
    DeterministicVirtualExecutionSimulator,
    VirtualExecutionResult,
    VirtualFill
} from '../virtual/execution';
import type { ObservationTick } from '../virtual/observation-runner';

export interface ShadowLiquidationPlan {
    readonly planId: string;
    readonly createdAt: string;
    readonly instrumentIds: readonly string[];
}

export interface ShadowSafetyAuditEntry {
    readonly auditId: string;
    readonly occurredAt: string;
    readonly outcome: 'planned' | 'applied' | 'rejected';
    readonly reason: string;
}

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
    readonly safetyMode: 'normal' | 'reduce-only';
    readonly liquidationPlan?: ShadowLiquidationPlan;
    readonly liquidationFailureCount: number;
    readonly safetyAudit: readonly ShadowSafetyAuditEntry[];
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

export interface QualifiedFanoutEvidenceLoader extends QualifiedMarketEvidenceLoader {
    loadBenchmarkHistory(experimentId: string): Promise<
        Readonly<{ baseline?: undefined; lastPoints?: undefined }>
        | Readonly<{ baseline: BenchmarkBaseline; lastPoints: readonly PersistedScenarioBenchmarkPoint[] }>
    >;
}

export type ShadowMarketEvidenceResult = Readonly<{
    quality: 'qualified';
    markSet: QualifiedMarketMarkSet;
    benchmark: ReturnType<typeof buildQualifiedBenchmarkEvidence>;
    sessionPolicyVersion: ObservationExperimentConfigV2['evidenceConfig']['sessionPolicyVersion'];
    benchmarkInstrumentUid: string;
    initialEquityKopecks: bigint;
}> | Readonly<{
    quality: 'rejected';
    sourceTickId: string;
    valuationAt: string;
    reasons: readonly MarketMarkQualificationReason[];
}>;

export interface AtomicShadowFanoutCommit {
    readonly experimentId: string;
    readonly sourceTick: CompleteShadowSourceTick;
    readonly previous: readonly ShadowScenarioState[];
    readonly next: readonly ShadowScenarioState[];
    readonly evidenceTick: ObservationTick;
    readonly marketEvidence?: ShadowMarketEvidenceResult;
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
        safetyMode: 'normal',
        liquidationFailureCount: 0,
        safetyAudit: Object.freeze([]),
        qualityReasons: Object.freeze('configVersion' in config && config.configVersion === 2
            ? [] : ['BENCHMARK_NOT_IMPLEMENTED']),
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

const liquidationOrder = (state: ShadowScenarioState) => [...state.margin.positions].sort((left, right) => {
    const leftValue = left.markPriceKopecks * BigInt(left.lotSize) * BigInt(left.quantityLots);
    const rightValue = right.markPriceKopecks * BigInt(right.lotSize) * BigInt(right.quantityLots);
    if (leftValue !== rightValue) return leftValue > rightValue ? -1 : 1;
    return left.instrumentId.localeCompare(right.instrumentId);
});

const executePendingLiquidation = (
    state: ShadowScenarioState,
    tick: CompleteShadowSourceTick,
    config: ObservationExperimentConfig
): ShadowScenarioState => {
    const plan = state.liquidationPlan;
    if (!plan) return state;
    state = accrueInterest(state, tick.completedAt, `pm07:${tick.sourceTickId}`);
    const quotes = new Map(tick.events.map(event => [event.instrumentId, event.quote]));
    const simulator = new DeterministicVirtualExecutionSimulator();
    const fills: { instrumentId: string; fill?: VirtualFill; reason?: string }[] = plan.instrumentIds.map(instrumentId => {
        const quote = quotes.get(instrumentId);
        const position = state.margin.positions.find(item => item.instrumentId === instrumentId);
        if (!quote || !position) return { instrumentId, reason: `missing liquidation input: ${instrumentId}` };
        const execution = simulator.execute({
            id: `liquidate:${plan.planId}:${instrumentId}`,
            virtualAccountId: state.virtualAccountId,
            instrumentId,
            side: 'sell',
            quantityLots: position.quantityLots,
            submittedAt: tick.completedAt
        }, {
            instrumentId,
            bidKopecks: quote.bidKopecks,
            askKopecks: quote.askKopecks,
            lotSize: position.lotSize,
            observedAt: quote.quoteObservedAt
        }, {
            now: tick.completedAt,
            cashKopecks: state.margin.cashKopecks,
            availableLots: position.quantityLots
        }, config.executionPolicy);
        return execution.status === 'filled' ? { instrumentId, fill: execution.fill }
            : { instrumentId, reason: `liquidation execution rejected: ${instrumentId}: ${execution.reason}` };
    });
    const failure = fills.find(item => item.reason !== undefined);
    let margin = state.margin;
    let appliedCount = 0;
    let failureReason: string | undefined = failure?.reason;
    if (!failureReason) {
        for (const candidate of fills) {
            if (marginRiskSnapshot(margin).maintenanceSatisfied) break;
            if (!candidate.fill) throw new Error(`prevalidated liquidation fill missing: ${candidate.instrumentId}`);
            const fill = candidate.fill;
            const applied = applyMarginScenarioEvent(margin, {
                id: `forced-${fill.orderId}`,
                kind: 'sell', instrumentId: fill.instrumentId, quantityLots: fill.quantityLots,
                executionPriceKopecks: fill.executionPriceKopecks, feeKopecks: fill.feeKopecks,
                occurredAt: fill.filledAt
            });
            if (applied.outcome === 'rejected') {
                failureReason = `liquidation margin rejected: ${fill.instrumentId}: ${applied.reason ?? 'unknown'}`;
                break;
            }
            margin = applied.state;
            appliedCount += 1;
        }
    }
    const rejected = failureReason !== undefined;
    return applyQuality(Object.freeze({
        ...state,
        margin: rejected ? state.margin : margin,
        safetyMode: rejected ? 'reduce-only' : 'normal',
        ...(rejected ? { liquidationPlan: plan } : { liquidationPlan: undefined }),
        liquidationFailureCount: state.liquidationFailureCount + (rejected ? 1 : 0),
        closedVirtualTrades: state.closedVirtualTrades + (rejected ? 0 : appliedCount),
        safetyAudit: Object.freeze([...state.safetyAudit, Object.freeze({
            auditId: `liquidation:${tick.sourceTickId}:${state.scenarioId}`,
            occurredAt: tick.completedAt,
            outcome: rejected ? 'rejected' : 'applied',
            reason: failureReason ?? 'forced liquidation restored maintenance margin with configured execution costs'
        })])
    }), rejected ? ['LIQUIDATION_EXECUTION_FAILED'] : []);
};

const executeQualifiedPendingLiquidation = (
    state: ShadowScenarioState,
    tick: CompleteShadowSourceTick,
    config: ObservationExperimentConfig,
    markSet: QualifiedMarketMarkSet
): ShadowScenarioState => {
    const plan = state.liquidationPlan;
    if (plan === undefined) return state;
    const marks = new Map(markSet.marks.map(mark => [mark.instrumentUid, mark]));
    const simulator = new DeterministicVirtualExecutionSimulator();
    const fills: { instrumentId: string; fill?: VirtualFill; reason?: string }[] = plan.instrumentIds.map(instrumentId => {
        const mark = marks.get(instrumentId);
        const position = state.margin.positions.find(item => item.instrumentId === instrumentId);
        if (mark === undefined || position === undefined) {
            return { instrumentId, reason: `missing qualified liquidation input: ${instrumentId}` };
        }
        const execution = simulator.execute({
            id: `liquidate:${plan.planId}:${instrumentId}`, virtualAccountId: state.virtualAccountId, instrumentId,
            side: "sell", quantityLots: position.quantityLots, submittedAt: tick.completedAt
        }, {
            instrumentId, bidKopecks: mark.bidKopecks, askKopecks: mark.askKopecks, lotSize: position.lotSize,
            observedAt: mark.brokerObservedAt
        }, { now: tick.completedAt, cashKopecks: state.margin.cashKopecks, availableLots: position.quantityLots },
        config.executionPolicy);
        return execution.status === "filled" ? { instrumentId, fill: execution.fill }
            : { instrumentId, reason: `qualified liquidation execution rejected: ${instrumentId}: ${execution.reason}` };
    });
    const failure = fills.find(item => item.reason !== undefined);
    let margin = state.margin;
    let appliedCount = 0;
    let failureReason: string | undefined = failure?.reason;
    if (failureReason === undefined) {
        for (const candidate of fills) {
            if (marginRiskSnapshot(margin).maintenanceSatisfied) break;
            if (candidate.fill === undefined) throw new Error(`prevalidated qualified liquidation fill missing: ${candidate.instrumentId}`);
            const fill = candidate.fill;
            const applied = applyMarginScenarioEvent(margin, {
                id: `forced-${fill.orderId}`, kind: "sell", instrumentId: fill.instrumentId,
                quantityLots: fill.quantityLots, executionPriceKopecks: fill.executionPriceKopecks,
                feeKopecks: fill.feeKopecks, occurredAt: fill.filledAt
            });
            if (applied.outcome === "rejected") {
                failureReason = `qualified liquidation margin rejected: ${fill.instrumentId}: ${applied.reason ?? "unknown"}`;
                break;
            }
            margin = applied.state;
            appliedCount += 1;
        }
    }
    const rejected = failureReason !== undefined;
    return applyQuality(Object.freeze({
        ...state, margin: rejected ? state.margin : margin, safetyMode: rejected ? "reduce-only" : "normal",
        ...(rejected ? { liquidationPlan: plan } : { liquidationPlan: undefined }),
        liquidationFailureCount: state.liquidationFailureCount + (rejected ? 1 : 0),
        closedVirtualTrades: state.closedVirtualTrades + (rejected ? 0 : appliedCount),
        safetyAudit: Object.freeze([...state.safetyAudit, Object.freeze({
            auditId: `liquidation:${tick.sourceTickId}:${state.scenarioId}`, occurredAt: tick.completedAt,
            outcome: rejected ? "rejected" : "applied",
            reason: failureReason ?? "qualified forced liquidation restored maintenance margin with configured execution costs"
        })])
    }), rejected ? ["LIQUIDATION_EXECUTION_FAILED"] : []);
};


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
    config: ObservationExperimentConfig,
    applySourceQuoteMark = true
): Promise<ShadowScenarioState> => {
    let state = accrueInterest(source, event.evaluatedAt, event.eventId);
    if (applySourceQuoteMark) state = applyMark(state, event);
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
    if (state.safetyMode === 'reduce-only' && adaptation.intent?.side === 'buy') {
        return applyQuality(Object.freeze({
            ...state,
            rejectedExecutionCount: state.rejectedExecutionCount + 1,
            decisionAudit: Object.freeze([...state.decisionAudit, Object.freeze({
                eventId: event.eventId, decisionId: event.decisionId, action: event.action, status: event.status,
                executionStatus: 'margin-rejected' as const, rejectionReason: 'scenario is reduce-only'
            })])
        }), ['SCENARIO_REDUCE_ONLY_REJECTION']);
    }
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
            if (fill.side === 'sell' && marginRiskSnapshot(applied.state).maintenanceSatisfied) {
                state = Object.freeze({ ...state, safetyMode: 'normal', liquidationPlan: undefined });
            }
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

const isTickScopedMarketQualityReason = (reason: string): boolean =>
    reason === 'MARK_SET_SKEW_EXCEEDED'
    || ['MISSING_REQUIRED_MARK:', 'STALE_MARK:', 'CROSSED_MARK:', 'OUT_OF_SPREAD_MARK:',
        'INVALID_MARK_FINGERPRINT:', 'SESSION_STATUS_NOT_QUALIFIED:'].some(prefix => reason.startsWith(prefix));

const clearTickScopedMarketQualityReasons = (state: ShadowScenarioState): ShadowScenarioState => Object.freeze({
    ...state,
    qualityReasons: Object.freeze(state.qualityReasons.filter(reason => !isTickScopedMarketQualityReason(reason)))
});

export class ShadowScenarioFanoutProcessor {
    constructor(
        private readonly config: ObservationExperimentConfig,
        private readonly repository: AtomicShadowFanoutRepository,
        private readonly qualifiedEvidenceLoader?: QualifiedFanoutEvidenceLoader
    ) {}

    async process(sourceTick: CompleteShadowSourceTick): Promise<ObservationTick> {
        if (await this.repository.hasCheckpoint(this.config.experimentId, sourceTick)) {
            return Object.freeze({ tickId: `fanout:${sourceTick.sourceTickId}`, observedAt: sourceTick.completedAt, snapshots: Object.freeze([]) });
        }
        const previous = await this.repository.loadOrInitialize(this.config, sourceTick.startedAt);
        if (previous.length !== 3) throw new Error("atomic fanout requires exactly three scenario states");
        const v2Config = isQualifiedEvidenceConfig(this.config) ? this.config : undefined;
        if (v2Config && this.qualifiedEvidenceLoader === undefined) {
            throw new Error("qualified evidence loader is required for v2 observation experiments");
        }
        const prepared = v2Config ? await prepareQualifiedShadowTick({
            config: v2Config, sourceTick, states: previous, loader: this.qualifiedEvidenceLoader!
        }) : undefined;
        let next: readonly ShadowScenarioState[];
        let marketEvidence: ShadowMarketEvidenceResult | undefined;

        if (v2Config === undefined) {
            next = previous.map(state => executePendingLiquidation(state, sourceTick, this.config));
            const explicitMarks = new Set(sourceTick.events.filter(event => event.kind === "mark").map(event => event.instrumentId));
            for (const event of sourceTick.events) {
                next = await Promise.all(next.map(async scenario => {
                    let state = applyQuality(scenario, qualityForEvent(event));
                    if (event.kind === "mark") {
                        state = accrueInterest(state, event.markedAt, event.eventId);
                        return applyMark(state, event);
                    }
                    return processDecision(state, event, this.config);
                }));
            }
            next = next.map(state => {
                const missing = state.margin.positions.some(position => explicitMarks.has(position.instrumentId) === false);
                return applyQuality(state, missing ? ["MISSING_MARK_EVENT"] : []);
            });
        } else {
            next = previous;
            for (const event of sourceTick.events) {
                next = await Promise.all(next.map(async scenario => {
                    const state = applyQuality(scenario, qualityForEvent(event));
                    return event.kind === "decision" ? processDecision(state, event, this.config, false) : state;
                }));
            }
            next = next.map(clearTickScopedMarketQualityReasons);
            if (prepared?.qualification.quality === "rejected") {
                const rejectionReasons = prepared.qualification.reasons;
                next = next.map(state => applyQuality(state, rejectionReasons));
                marketEvidence = Object.freeze({
                    quality: "rejected", sourceTickId: sourceTick.sourceTickId,
                    valuationAt: sourceTick.completedAt, reasons: rejectionReasons
                });
            } else if (prepared?.qualification.quality === "qualified") {
                const markSet = prepared.qualification;
                next = next.map(state => accrueInterest(state, sourceTick.completedAt, `qualified:${sourceTick.sourceTickId}`));
                next = applyQualifiedMarksToScenarios(next, markSet);
                next = next.map(state => executeQualifiedPendingLiquidation(state, sourceTick, this.config, markSet));
            } else {
                throw new Error("v2 market evidence preparation missing");
            }
        }

        next = next.map(state => {
            const before = previous.find(item => item.scenarioId === state.scenarioId);
            if (before === undefined) throw new Error(`missing previous scenario: ${state.scenarioId}`);
            const priorRisk = marginRiskSnapshot(before.margin);
            const risk = marginRiskSnapshot(state.margin);
            if (risk.reconciled === false) throw new Error(`scenario accounting invariant corrupted: ${state.scenarioId}`);
            const newlyBreached = priorRisk.maintenanceSatisfied && risk.maintenanceSatisfied === false;
            const plan = newlyBreached ? Object.freeze({
                planId: `pm07:${sourceTick.sourceTickId}:${state.scenarioId}`,
                createdAt: sourceTick.completedAt,
                instrumentIds: Object.freeze(liquidationOrder(state).map(position => position.instrumentId))
            }) : state.liquidationPlan;
            return Object.freeze({
                ...state,
                invariantViolationCount: state.invariantViolationCount,
                marginBreachCount: state.marginBreachCount + (newlyBreached ? 1 : 0),
                safetyMode: newlyBreached ? "reduce-only" : state.safetyMode,
                ...(plan ? { liquidationPlan: plan } : {}),
                safetyAudit: newlyBreached ? Object.freeze([...state.safetyAudit, Object.freeze({
                    auditId: `plan:${sourceTick.sourceTickId}:${state.scenarioId}`,
                    occurredAt: sourceTick.completedAt, outcome: "planned" as const,
                    reason: "maintenance margin breached; deterministic virtual liquidation planned"
                })]) : state.safetyAudit
            });
        });

        if (v2Config && prepared?.qualification.quality === "qualified") {
            const history = await this.qualifiedEvidenceLoader!.loadBenchmarkHistory(v2Config.experimentId);
            marketEvidence = Object.freeze({
                quality: "qualified",
                markSet: prepared.qualification,
                benchmark: buildQualifiedBenchmarkEvidence({
                    config: v2Config, markSet: prepared.qualification, states: next,
                    ...(history.baseline ? { persistedBaseline: history.baseline } : {}),
                    ...(history.lastPoints ? { persistedLastPoints: history.lastPoints } : {})
                }),
                sessionPolicyVersion: v2Config.evidenceConfig.sessionPolicyVersion,
                benchmarkInstrumentUid: v2Config.evidenceConfig.benchmarkInstrumentUid,
                initialEquityKopecks: BigInt(v2Config.startingCashKopecks)
            });
        }
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
                    financingIncluded: state.margin.policy.leverage === "1x" || state.margin.policy.annualInterestBps > 0,
                    benchmarkAvailable: marketEvidence?.quality === "qualified",
                    evidenceQualityReasons: state.qualityReasons
                });
            }))
        });
        await this.repository.commit({ experimentId: this.config.experimentId, sourceTick, previous, next, evidenceTick,
            ...(marketEvidence ? { marketEvidence } : {}) });
        return evidenceTick;
    }
}


const configHasExplicitCosts = (config: ObservationExperimentConfig) =>
    Number.isSafeInteger(config.executionPolicy.feeBasisPoints) && config.executionPolicy.feeBasisPoints >= 0;

const isQualifiedEvidenceConfig = (config: ObservationExperimentConfig): config is ObservationExperimentConfigV2 =>
    'configVersion' in config && config.configVersion === 2;

export interface CompletedShadowTickSource {
    claimNext(consumerId: string, leaseMs: number): Promise<ClaimedShadowSourceTick | undefined>;
}

export class OutboxShadowFanoutRuntime implements VirtualObservationRuntime {
    private running?: Promise<ObservationTick | undefined>;

    constructor(
        private readonly source: CompletedShadowTickSource,
        private readonly processor: ShadowScenarioFanoutProcessor,
        private readonly consumerId: string,
        private readonly claimLeaseMs: number,
        private readonly maxBatchSize: number = 100
    ) {
        if (!Number.isSafeInteger(maxBatchSize) || maxBatchSize <= 0 || maxBatchSize > 1_000) {
            throw new Error('shadow fanout maxBatchSize must be an integer between 1 and 1000');
        }
    }

    async initialize() { return undefined; }

    async tick(): Promise<ObservationTick | undefined> {
        if (this.running) return this.running;
        this.running = this.consumeBatch();
        try { return await this.running; } finally { this.running = undefined; }
    }

    private async consumeBatch(): Promise<ObservationTick | undefined> {
        let latest: ObservationTick | undefined;
        for (let index = 0; index < this.maxBatchSize; index += 1) {
            const claimed = await this.source.claimNext(this.consumerId, this.claimLeaseMs);
            if (!claimed) break;
            latest = await this.processor.process(claimed.tick);
            if (!await claimed.acknowledge()) throw new Error(`source acknowledgement lease lost: ${claimed.tick.sourceTickId}`);
        }
        return latest;
    }
}
