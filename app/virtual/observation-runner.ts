export const MINIMUM_OBSERVATION_DAYS = 14;
export const MINIMUM_CLOSED_VIRTUAL_TRADES = 30;

export interface ObservationScenarioSnapshot {
    readonly virtualAccountId: string;
    readonly scenarioId: string;
    readonly equityKopecks: bigint;
    readonly closedVirtualTrades: number;
    readonly invariantViolationCount: number;
    readonly unknownUnreconciledOrderCount: number;
    readonly marginBreachCount: number;
    readonly feesIncluded: boolean;
    readonly slippageIncluded: boolean;
    readonly financingIncluded: boolean;
    readonly benchmarkAvailable: boolean;
}

export interface ObservationTick {
    readonly tickId: string;
    readonly observedAt: string;
    readonly snapshots: readonly ObservationScenarioSnapshot[];
}

export interface ObservationScenarioEvidence extends ObservationScenarioSnapshot {
    readonly firstObservedAt: string;
    readonly lastObservedAt: string;
    readonly peakEquityKopecks: bigint;
    readonly maximumDrawdownKopecks: bigint;
    readonly maximumDrawdownBps: number;
}

export interface ObservationRunnerState {
    readonly experimentId: string;
    readonly ticks: readonly ObservationTick[];
    readonly scenarios: readonly ObservationScenarioEvidence[];
}

export interface ObservationEvidenceGate {
    readonly virtualAccountId: string;
    readonly scenarioId: string;
    readonly calendarDays: number;
    readonly qualified: boolean;
    readonly reasons: readonly string[];
}

const requireId = (value: string, field: string) => {
    if (typeof value !== 'string' || !value || value.trim() !== value) throw new TypeError(`${field} must be trimmed and non-empty`);
};

const timestamp = (value: string, field: string) => {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) {
        throw new TypeError(`${field} must be an RFC3339 UTC timestamp`);
    }
    const result = Date.parse(value);
    if (!Number.isFinite(result)) throw new TypeError(`${field} must be valid`);
    return result;
};

const freeze = <T extends object>(value: T): Readonly<T> => Object.freeze(value);
const keyOf = (value: Pick<ObservationScenarioSnapshot, 'virtualAccountId' | 'scenarioId'>) =>
    `${value.virtualAccountId}\u0000${value.scenarioId}`;

const validateSnapshot = (snapshot: ObservationScenarioSnapshot) => {
    requireId(snapshot.virtualAccountId, 'virtualAccountId');
    requireId(snapshot.scenarioId, 'scenarioId');
    if (typeof snapshot.equityKopecks !== 'bigint') throw new TypeError('equityKopecks must be bigint');
    for (const [field, value] of Object.entries({
        closedVirtualTrades: snapshot.closedVirtualTrades,
        invariantViolationCount: snapshot.invariantViolationCount,
        unknownUnreconciledOrderCount: snapshot.unknownUnreconciledOrderCount,
        marginBreachCount: snapshot.marginBreachCount
    })) {
        if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${field} must be a non-negative safe integer`);
    }
    for (const [field, value] of Object.entries({
        feesIncluded: snapshot.feesIncluded,
        slippageIncluded: snapshot.slippageIncluded,
        financingIncluded: snapshot.financingIncluded,
        benchmarkAvailable: snapshot.benchmarkAvailable
    })) {
        if (typeof value !== 'boolean') throw new TypeError(`${field} must be boolean`);
    }
};

const fingerprint = (tick: ObservationTick) => JSON.stringify(tick, (_key, value) =>
    typeof value === 'bigint' ? value.toString() : value
);

export const openObservationRunner = (experimentId: string): ObservationRunnerState => {
    requireId(experimentId, 'experimentId');
    return freeze({ experimentId, ticks: freeze([] as ObservationTick[]), scenarios: freeze([] as ObservationScenarioEvidence[]) });
};

export const applyObservationTick = (state: ObservationRunnerState, source: ObservationTick): ObservationRunnerState => {
    requireId(source.tickId, 'tickId');
    const observedAtMs = timestamp(source.observedAt, 'observedAt');
    const normalized = freeze({
        tickId: source.tickId,
        observedAt: source.observedAt,
        snapshots: freeze([...source.snapshots].sort((a, b) => keyOf(a).localeCompare(keyOf(b))).map(item => freeze({ ...item })))
    });
    const existing = state.ticks.find(item => item.tickId === normalized.tickId);
    if (existing) {
        if (fingerprint(existing) !== fingerprint(normalized)) throw new Error(`observation tick ID conflict: ${normalized.tickId}`);
        return state;
    }
    const lastTick = state.ticks[state.ticks.length - 1];
    if (lastTick && observedAtMs <= timestamp(lastTick.observedAt, 'lastObservedAt')) {
        throw new Error('observation ticks must be strictly chronological');
    }
    const duplicateKeys = new Set<string>();
    const current = new Map(state.scenarios.map(item => [keyOf(item), item]));
    for (const snapshot of normalized.snapshots) {
        validateSnapshot(snapshot);
        const key = keyOf(snapshot);
        if (duplicateKeys.has(key)) throw new Error(`duplicate scenario snapshot: ${snapshot.scenarioId}`);
        duplicateKeys.add(key);
        const previous = current.get(key);
        if (previous && snapshot.closedVirtualTrades < previous.closedVirtualTrades) throw new Error('closed trade count cannot decrease');
        if (previous && snapshot.invariantViolationCount < previous.invariantViolationCount) throw new Error('invariant violation count cannot decrease');
        if (previous && snapshot.marginBreachCount < previous.marginBreachCount) throw new Error('margin breach count cannot decrease');
        const peak = previous && previous.peakEquityKopecks > snapshot.equityKopecks
            ? previous.peakEquityKopecks : snapshot.equityKopecks;
        const drawdown = peak > snapshot.equityKopecks ? peak - snapshot.equityKopecks : 0n;
        const drawdownBps = peak > 0n ? Number(drawdown * 10_000n / peak) : 0;
        current.set(key, freeze({
            ...snapshot,
            firstObservedAt: previous?.firstObservedAt ?? normalized.observedAt,
            lastObservedAt: normalized.observedAt,
            peakEquityKopecks: peak,
            maximumDrawdownKopecks: previous && previous.maximumDrawdownKopecks > drawdown
                ? previous.maximumDrawdownKopecks : drawdown,
            maximumDrawdownBps: Math.max(previous?.maximumDrawdownBps ?? 0, drawdownBps),
            feesIncluded: previous ? previous.feesIncluded && snapshot.feesIncluded : snapshot.feesIncluded,
            slippageIncluded: previous ? previous.slippageIncluded && snapshot.slippageIncluded : snapshot.slippageIncluded,
            financingIncluded: previous ? previous.financingIncluded && snapshot.financingIncluded : snapshot.financingIncluded,
            benchmarkAvailable: previous ? previous.benchmarkAvailable && snapshot.benchmarkAvailable : snapshot.benchmarkAvailable
        }));
    }
    return freeze({
        experimentId: state.experimentId,
        ticks: freeze([...state.ticks, normalized]),
        scenarios: freeze([...current.values()].sort((a, b) => keyOf(a).localeCompare(keyOf(b))))
    });
};

export const replayObservationTicks = (experimentId: string, ticks: readonly ObservationTick[]) =>
    ticks.reduce(applyObservationTick, openObservationRunner(experimentId));

export const evaluateObservationGate = (evidence: ObservationScenarioEvidence): ObservationEvidenceGate => {
    const first = timestamp(evidence.firstObservedAt, 'firstObservedAt');
    const last = timestamp(evidence.lastObservedAt, 'lastObservedAt');
    if (last < first) throw new Error('observation evidence time range is inverted');
    const utcDay = (value: string) => Date.parse(`${value.slice(0, 10)}T00:00:00Z`);
    const calendarDays = Math.floor((utcDay(evidence.lastObservedAt) - utcDay(evidence.firstObservedAt)) / 86_400_000) + 1;
    const reasons: string[] = [];
    if (calendarDays < MINIMUM_OBSERVATION_DAYS) reasons.push('MINIMUM_CALENDAR_DAYS_NOT_MET');
    if (evidence.closedVirtualTrades < MINIMUM_CLOSED_VIRTUAL_TRADES) reasons.push('MINIMUM_CLOSED_TRADES_NOT_MET');
    if (evidence.invariantViolationCount > 0) reasons.push('ACCOUNTING_INVARIANT_VIOLATIONS');
    if (evidence.unknownUnreconciledOrderCount > 0) reasons.push('UNKNOWN_UNRECONCILED_ORDERS');
    if (!evidence.feesIncluded) reasons.push('FEES_NOT_INCLUDED');
    if (!evidence.slippageIncluded) reasons.push('SLIPPAGE_NOT_INCLUDED');
    if (!evidence.financingIncluded) reasons.push('FINANCING_NOT_INCLUDED');
    if (!evidence.benchmarkAvailable) reasons.push('BENCHMARK_UNAVAILABLE');
    return freeze({
        virtualAccountId: evidence.virtualAccountId,
        scenarioId: evidence.scenarioId,
        calendarDays,
        qualified: reasons.length === 0,
        reasons: freeze(reasons)
    });
};
