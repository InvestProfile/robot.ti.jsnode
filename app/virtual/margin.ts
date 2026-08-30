import { normalizeRfc3339Timestamp } from './codecs';

export type MarginScenarioLeverage = '1x' | '1.2x' | '1.5x';
export type MarginScenarioEvent = MarginBuyEvent | MarginSellEvent | MarginMarkEvent | MarginInterestEvent;

export interface MarginScenarioPolicy {
    readonly leverage: MarginScenarioLeverage;
    readonly version: string;
    readonly initialMarginBps: number;
    readonly maintenanceMarginBps: number;
    readonly annualInterestBps: number;
    readonly allowBorrowedAveragingDown: boolean;
    readonly markMaxAgeSeconds: number;
}

export interface MarginPositionState {
    readonly instrumentId: string;
    readonly lotSize: number;
    readonly quantityLots: number;
    readonly costBasisKopecks: bigint;
    readonly markPriceKopecks: bigint;
    readonly markObservedAt: string;
}

interface MarginEventBase {
    readonly id: string;
    readonly occurredAt: string;
}

export interface MarginBuyEvent extends MarginEventBase {
    readonly kind: 'buy';
    readonly instrumentId: string;
    readonly lotSize: number;
    readonly quantityLots: number;
    readonly executionPriceKopecks: bigint;
    readonly feeKopecks: bigint;
}

export interface MarginSellEvent extends MarginEventBase {
    readonly kind: 'sell';
    readonly instrumentId: string;
    readonly quantityLots: number;
    readonly executionPriceKopecks: bigint;
    readonly feeKopecks: bigint;
}

export interface MarginMarkEvent extends MarginEventBase {
    readonly kind: 'mark';
    readonly instrumentId: string;
    readonly priceKopecks: bigint;
    readonly observedAt: string;
}

export interface MarginInterestEvent extends MarginEventBase {
    readonly kind: 'interest';
    readonly fromAt: string;
    readonly toAt: string;
}

export interface MarginAuditEntry {
    readonly eventId: string;
    readonly occurredAt: string;
    readonly kind: MarginScenarioEvent['kind'];
    readonly fingerprint: string;
    readonly event: MarginScenarioEvent;
    readonly outcome: 'applied' | 'rejected';
    readonly reason?: string;
    readonly debtKopecks: bigint;
    readonly cashKopecks: bigint;
}

export interface MarginScenarioState {
    readonly scenarioId: string;
    readonly virtualAccountId: string;
    readonly policy: MarginScenarioPolicy;
    readonly openedAt: string;
    readonly lastEventAt: string;
    readonly interestAccruedThroughAt: string;
    readonly cashKopecks: bigint;
    readonly debtKopecks: bigint;
    readonly accruedInterestKopecks: bigint;
    readonly interestRemainderNumerator: bigint;
    readonly realizedPnlKopecks: bigint;
    readonly positions: readonly MarginPositionState[];
    readonly audit: readonly MarginAuditEntry[];
}

export interface MarginRiskSnapshot {
    readonly positionsValueKopecks: bigint;
    readonly grossExposureKopecks: bigint;
    readonly equityKopecks: bigint;
    readonly initialRequirementKopecks: bigint;
    readonly maintenanceRequirementKopecks: bigint;
    readonly initialMarginBufferKopecks: bigint;
    readonly maintenanceMarginBufferKopecks: bigint;
    readonly fundsSufficient: boolean;
    readonly maintenanceSatisfied: boolean;
    readonly buyingPowerKopecks: bigint;
    readonly assetsKopecks: bigint;
    readonly liabilitiesKopecks: bigint;
    readonly reconciled: boolean;
}

export interface MarginApplyResult {
    readonly state: MarginScenarioState;
    readonly outcome: 'applied' | 'rejected' | 'idempotent';
    readonly reason?: string;
    readonly risk: MarginRiskSnapshot;
}

export const DEFAULT_MARGIN_SCENARIO_POLICIES: readonly MarginScenarioPolicy[] = Object.freeze([
    Object.freeze({ leverage: '1x', version: 'pm06-v1', initialMarginBps: 10_000, maintenanceMarginBps: 7_500, annualInterestBps: 0, allowBorrowedAveragingDown: false, markMaxAgeSeconds: 300 }),
    Object.freeze({ leverage: '1.2x', version: 'pm06-v1', initialMarginBps: 8_334, maintenanceMarginBps: 6_667, annualInterestBps: 1_800, allowBorrowedAveragingDown: false, markMaxAgeSeconds: 300 }),
    Object.freeze({ leverage: '1.5x', version: 'pm06-v1', initialMarginBps: 6_667, maintenanceMarginBps: 5_000, annualInterestBps: 1_800, allowBorrowedAveragingDown: false, markMaxAgeSeconds: 300 })
]);

export const MARGIN_INTEREST_DENOMINATOR = 10_000n * 31_536_000n;

const requireTrimmed = (value: string, field: string) => {
    if (typeof value !== 'string' || !value || value.trim() !== value) throw new TypeError(`${field} must be trimmed and non-empty`);
};
const requirePositiveInteger = (value: number, field: string) => {
    if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${field} must be a positive safe integer`);
};
const requireNonNegativeMoney = (value: bigint, field: string) => {
    if (typeof value !== 'bigint' || value < 0n) throw new TypeError(`${field} must be a non-negative bigint`);
};
const bpsAmountCeil = (amount: bigint, bps: number) => ceilDiv(amount * BigInt(bps), 10_000n);
const ceilDiv = (numerator: bigint, denominator: bigint) =>
    numerator === 0n ? 0n : (numerator + denominator - 1n) / denominator;

const validatePolicy = (policy: MarginScenarioPolicy) => {
    if (!['1x', '1.2x', '1.5x'].includes(policy.leverage)) throw new TypeError('unsupported margin leverage');
    requireTrimmed(policy.version, 'policy.version');
    requirePositiveInteger(policy.markMaxAgeSeconds, 'policy.markMaxAgeSeconds');
    const minimumInitial = policy.leverage === '1x' ? 10_000 : policy.leverage === '1.2x' ? 8_334 : 6_667;
    if (policy.initialMarginBps < minimumInitial) throw new Error('initial margin is below conservative leverage boundary');
    for (const [field, value] of [
        ['initialMarginBps', policy.initialMarginBps],
        ['maintenanceMarginBps', policy.maintenanceMarginBps],
        ['annualInterestBps', policy.annualInterestBps]
    ] as const) {
        if (!Number.isSafeInteger(value) || value < 0 || value > 10_000) throw new TypeError(`${field} is invalid`);
    }
    if (policy.initialMarginBps < policy.maintenanceMarginBps || policy.initialMarginBps === 0) {
        throw new Error('initial margin must be positive and not below maintenance margin');
    }
};

const canonicalEvent = (event: MarginScenarioEvent): MarginScenarioEvent => {
    requireTrimmed(event.id, 'event.id');
    const occurredAt = normalizeRfc3339Timestamp(event.occurredAt);
    if (event.kind === 'interest') {
        const fromAt = normalizeRfc3339Timestamp(event.fromAt);
        const toAt = normalizeRfc3339Timestamp(event.toAt);
        if (occurredAt !== toAt || Date.parse(toAt) <= Date.parse(fromAt)) throw new Error('invalid interest time boundary');
        return Object.freeze({ ...event, occurredAt, fromAt, toAt });
    }
    requireTrimmed(event.instrumentId, 'event.instrumentId');
    if (event.kind === 'mark') {
        requireNonNegativeMoney(event.priceKopecks, 'event.priceKopecks');
        if (event.priceKopecks === 0n) throw new TypeError('event.priceKopecks must be positive');
        const observedAt = normalizeRfc3339Timestamp(event.observedAt);
        if (Date.parse(observedAt) > Date.parse(occurredAt)) throw new Error('future margin mark');
        return Object.freeze({ ...event, occurredAt, observedAt });
    }
    requirePositiveInteger(event.quantityLots, 'event.quantityLots');
    requireNonNegativeMoney(event.executionPriceKopecks, 'event.executionPriceKopecks');
    if (event.executionPriceKopecks === 0n) throw new TypeError('event.executionPriceKopecks must be positive');
    requireNonNegativeMoney(event.feeKopecks, 'event.feeKopecks');
    if (event.kind === 'buy') requirePositiveInteger(event.lotSize, 'event.lotSize');
    return Object.freeze({ ...event, occurredAt });
};

const MARGIN_EVENT_PHASE: Readonly<Record<MarginScenarioEvent['kind'], number>> = Object.freeze({
    interest: 0, mark: 1, sell: 2, buy: 3
});

const eventFingerprint = (event: MarginScenarioEvent) => JSON.stringify(event, (_key, value) =>
    typeof value === 'bigint' ? value.toString() : value
);

const positionValue = (position: MarginPositionState) =>
    position.markPriceKopecks * BigInt(position.lotSize) * BigInt(position.quantityLots);

const validateMarginState = (state: MarginScenarioState) => {
    requireTrimmed(state.scenarioId, 'state.scenarioId');
    requireTrimmed(state.virtualAccountId, 'state.virtualAccountId');
    validatePolicy(state.policy);
    requireNonNegativeMoney(state.cashKopecks, 'state.cashKopecks');
    requireNonNegativeMoney(state.debtKopecks, 'state.debtKopecks');
    requireNonNegativeMoney(state.accruedInterestKopecks, 'state.accruedInterestKopecks');
    requireNonNegativeMoney(state.interestRemainderNumerator, 'state.interestRemainderNumerator');
    if (state.interestRemainderNumerator >= MARGIN_INTEREST_DENOMINATOR) {
        throw new Error('interest remainder must be below denominator');
    }
    const ids = new Set<string>();
    for (const position of state.positions) {
        requireTrimmed(position.instrumentId, 'position.instrumentId');
        if (ids.has(position.instrumentId)) throw new Error('duplicate margin position');
        ids.add(position.instrumentId);
        requirePositiveInteger(position.lotSize, 'position.lotSize');
        requirePositiveInteger(position.quantityLots, 'position.quantityLots');
        requireNonNegativeMoney(position.costBasisKopecks, 'position.costBasisKopecks');
        requireNonNegativeMoney(position.markPriceKopecks, 'position.markPriceKopecks');
        if (position.markPriceKopecks === 0n) throw new Error('zero margin position mark');
        normalizeRfc3339Timestamp(position.markObservedAt);
    }
};

export const marginRiskSnapshot = (state: MarginScenarioState): MarginRiskSnapshot => {
    validateMarginState(state);
    const positionsValueKopecks = state.positions.reduce((sum, position) => sum + positionValue(position), 0n);
    const roundedInterestPayable = state.accruedInterestKopecks
        + (state.interestRemainderNumerator > 0n ? 1n : 0n);
    const liabilitiesKopecks = state.debtKopecks + roundedInterestPayable;
    const equityKopecks = state.cashKopecks + positionsValueKopecks - liabilitiesKopecks;
    const initialRequirementKopecks = bpsAmountCeil(positionsValueKopecks, state.policy.initialMarginBps);
    const maintenanceRequirementKopecks = bpsAmountCeil(positionsValueKopecks, state.policy.maintenanceMarginBps);
    const buyingCapacity = state.policy.initialMarginBps === 0 ? 0n : equityKopecks * 10_000n / BigInt(state.policy.initialMarginBps);
    const buyingPowerKopecks = buyingCapacity > positionsValueKopecks ? buyingCapacity - positionsValueKopecks : 0n;
    const assetsKopecks = state.cashKopecks + positionsValueKopecks;
    return Object.freeze({
        positionsValueKopecks,
        grossExposureKopecks: positionsValueKopecks,
        equityKopecks,
        initialRequirementKopecks,
        maintenanceRequirementKopecks,
        initialMarginBufferKopecks: equityKopecks - initialRequirementKopecks,
        maintenanceMarginBufferKopecks: equityKopecks - maintenanceRequirementKopecks,
        fundsSufficient: equityKopecks >= initialRequirementKopecks,
        maintenanceSatisfied: equityKopecks >= maintenanceRequirementKopecks,
        buyingPowerKopecks,
        assetsKopecks,
        liabilitiesKopecks,
        reconciled: assetsKopecks === equityKopecks + liabilitiesKopecks
    });
};

export const openMarginScenario = (input: {
    scenarioId: string;
    virtualAccountId: string;
    startingCashKopecks: bigint;
    policy: MarginScenarioPolicy;
    openedAt: string;
}): MarginScenarioState => {
    requireTrimmed(input.scenarioId, 'scenarioId');
    requireTrimmed(input.virtualAccountId, 'virtualAccountId');
    requireNonNegativeMoney(input.startingCashKopecks, 'startingCashKopecks');
    validatePolicy(input.policy);
    const openedAt = normalizeRfc3339Timestamp(input.openedAt);
    return Object.freeze({
        scenarioId: input.scenarioId,
        virtualAccountId: input.virtualAccountId,
        policy: Object.freeze({ ...input.policy }),
        openedAt,
        lastEventAt: openedAt,
        interestAccruedThroughAt: openedAt,
        cashKopecks: input.startingCashKopecks,
        debtKopecks: 0n,
        accruedInterestKopecks: 0n,
        interestRemainderNumerator: 0n,
        realizedPnlKopecks: 0n,
        positions: Object.freeze([]),
        audit: Object.freeze([])
    });
};

const withAudit = (
    state: MarginScenarioState,
    event: MarginScenarioEvent,
    fingerprint: string,
    outcome: 'applied' | 'rejected',
    reason?: string
): MarginScenarioState => Object.freeze({
    ...state,
    lastEventAt: Date.parse(event.occurredAt) > Date.parse(state.lastEventAt) ? event.occurredAt : state.lastEventAt,
    positions: Object.freeze(state.positions.map(position => Object.freeze({ ...position }))),
    audit: Object.freeze([...state.audit, Object.freeze({
        eventId: event.id, occurredAt: event.occurredAt, kind: event.kind,
        fingerprint, event, outcome, reason, debtKopecks: state.debtKopecks, cashKopecks: state.cashKopecks
    })])
});

const markValidationError = (state: MarginScenarioState, at: string) => {
    const atMs = Date.parse(at);
    for (const position of state.positions) {
        if (position.markPriceKopecks <= 0n) return 'zero mark: ' + position.instrumentId;
        const markMs = Date.parse(position.markObservedAt);
        if (markMs > atMs) return 'future mark: ' + position.instrumentId;
        if (atMs - markMs > state.policy.markMaxAgeSeconds * 1000) return 'stale mark: ' + position.instrumentId;
    }
    return undefined;
};

const reject = (state: MarginScenarioState, event: MarginScenarioEvent, fingerprint: string, reason: string): MarginApplyResult => {
    const rejected = withAudit(state, event, fingerprint, 'rejected', reason);
    return Object.freeze({ state: rejected, outcome: 'rejected', reason, risk: marginRiskSnapshot(rejected) });
};

export const applyMarginScenarioEvent = (
    source: MarginScenarioState,
    sourceEvent: MarginScenarioEvent
): MarginApplyResult => {
    validatePolicy(source.policy);
    const event = canonicalEvent(sourceEvent);
    const fingerprint = eventFingerprint(event);
    const existing = source.audit.find(entry => entry.eventId === event.id);
    if (existing) {
        if (existing.fingerprint !== fingerprint) throw new Error(`margin event ID conflict: ${event.id}`);
        return Object.freeze({ state: source, outcome: 'idempotent', reason: existing.reason, risk: marginRiskSnapshot(source) });
    }

    if (Date.parse(event.occurredAt) < Date.parse(source.lastEventAt)) {
        return reject(source, event, fingerprint, 'out-of-order margin event');
    }
    const lastAppliedAtTimestamp = [...source.audit].reverse().find(entry =>
        entry.outcome === 'applied' && entry.occurredAt === event.occurredAt
    );
    if (lastAppliedAtTimestamp && MARGIN_EVENT_PHASE[event.kind] < MARGIN_EVENT_PHASE[lastAppliedAtTimestamp.kind]) {
        return reject(source, event, fingerprint, 'same-timestamp margin phase order violation');
    }

    let next: MarginScenarioState;
    if (event.kind === 'mark') {
        const position = source.positions.find(item => item.instrumentId === event.instrumentId);
        if (!position) return reject(source, event, fingerprint, 'position not found');
        next = Object.freeze({ ...source, positions: Object.freeze(source.positions.map(item =>
            item.instrumentId === event.instrumentId ? Object.freeze({ ...item, markPriceKopecks: event.priceKopecks, markObservedAt: event.observedAt }) : item
        )) });
    } else if (event.kind === 'interest') {
        if (event.fromAt !== source.interestAccruedThroughAt) {
            return reject(source, event, fingerprint, 'interest boundary mismatch');
        }
        const elapsedSeconds = BigInt((Date.parse(event.toAt) - Date.parse(event.fromAt)) / 1000);
        const interestNumerator = source.interestRemainderNumerator
            + source.debtKopecks * BigInt(source.policy.annualInterestBps) * elapsedSeconds;
        const interest = interestNumerator / MARGIN_INTEREST_DENOMINATOR;
        const interestRemainderNumerator = interestNumerator % MARGIN_INTEREST_DENOMINATOR;
        next = Object.freeze({
            ...source, accruedInterestKopecks: source.accruedInterestKopecks + interest,
            interestRemainderNumerator, interestAccruedThroughAt: event.toAt
        });
    } else if (event.kind === 'buy') {
        const markError = markValidationError(source, event.occurredAt);
        if (markError) return reject(source, event, fingerprint, markError);
        const preRisk = marginRiskSnapshot(source);
        if (!preRisk.reconciled || !preRisk.fundsSufficient) return reject(source, event, fingerprint, 'pre-fill margin check failed');
        if (source.debtKopecks > 0n && source.interestAccruedThroughAt !== event.occurredAt) {
            return reject(source, event, fingerprint, 'interest must be accrued through trade time');
        }
        const existingPosition = source.positions.find(item => item.instrumentId === event.instrumentId);
        if (existingPosition && existingPosition.lotSize !== event.lotSize) {
            return reject(source, event, fingerprint, 'lot size mismatch');
        }
        const gross = event.executionPriceKopecks * BigInt(event.lotSize) * BigInt(event.quantityLots);
        const total = gross + event.feeKopecks;
        const borrowed = total > source.cashKopecks ? total - source.cashKopecks : 0n;
        if (borrowed > 0n && source.policy.leverage === '1x') return reject(source, event, fingerprint, '1x scenario cannot create debt');
        if (borrowed > 0n && existingPosition && !source.policy.allowBorrowedAveragingDown) {
            const oldUnitCost = existingPosition.costBasisKopecks
                / BigInt(existingPosition.quantityLots * existingPosition.lotSize);
            if (existingPosition.markPriceKopecks < oldUnitCost) {
                return reject(source, event, fingerprint, 'averaging down with borrowed funds is disabled');
            }
        }
        const updatedPosition = Object.freeze({
            instrumentId: event.instrumentId,
            lotSize: event.lotSize,
            quantityLots: (existingPosition?.quantityLots ?? 0) + event.quantityLots,
            costBasisKopecks: (existingPosition?.costBasisKopecks ?? 0n) + total,
            markPriceKopecks: event.executionPriceKopecks,
            markObservedAt: event.occurredAt
        });
        const positions = existingPosition
            ? source.positions.map(item => item.instrumentId === event.instrumentId ? updatedPosition : item)
            : [...source.positions, updatedPosition];
        const candidate = Object.freeze({
            ...source,
            cashKopecks: total >= source.cashKopecks ? 0n : source.cashKopecks - total,
            debtKopecks: source.debtKopecks + borrowed,
            interestAccruedThroughAt: source.debtKopecks === 0n && borrowed > 0n ? event.occurredAt : source.interestAccruedThroughAt,
            positions: Object.freeze(positions)
        });
        if (!marginRiskSnapshot(candidate).fundsSufficient) {
            return reject(source, event, fingerprint, 'initial margin funds insufficient');
        }
        next = candidate;
    } else {
        if (source.debtKopecks > 0n && source.interestAccruedThroughAt !== event.occurredAt) {
            return reject(source, event, fingerprint, 'interest must be accrued through trade time');
        }
        const position = source.positions.find(item => item.instrumentId === event.instrumentId);
        if (!position || position.quantityLots < event.quantityLots) {
            return reject(source, event, fingerprint, 'sell exceeds long-only position');
        }
        const gross = event.executionPriceKopecks * BigInt(position.lotSize) * BigInt(event.quantityLots);
        if (event.feeKopecks > gross) return reject(source, event, fingerprint, 'sell fee exceeds proceeds');
        const net = gross - event.feeKopecks;
        const roundedInterestPayable = source.accruedInterestKopecks
            + (source.interestRemainderNumerator > 0n ? 1n : 0n);
        const interestRepaid = net > roundedInterestPayable ? roundedInterestPayable : net;
        const afterInterest = net - interestRepaid;
        const remainingAccruedInterest = interestRepaid >= source.accruedInterestKopecks
            ? 0n : source.accruedInterestKopecks - interestRepaid;
        const remainderSettled = interestRepaid > source.accruedInterestKopecks;
        const remainingInterestRemainder = remainderSettled ? 0n : source.interestRemainderNumerator;
        const principalRepaid = afterInterest > source.debtKopecks ? source.debtKopecks : afterInterest;
        const remainingLots = position.quantityLots - event.quantityLots;
        const removedCost = position.costBasisKopecks * BigInt(event.quantityLots) / BigInt(position.quantityLots);
        const positions = remainingLots === 0
            ? source.positions.filter(item => item.instrumentId !== event.instrumentId)
            : source.positions.map(item => item.instrumentId === event.instrumentId
                ? Object.freeze({ ...item, quantityLots: remainingLots, costBasisKopecks: item.costBasisKopecks - removedCost })
                : item);
        next = Object.freeze({
            ...source,
            cashKopecks: source.cashKopecks + net - interestRepaid - principalRepaid,
            debtKopecks: source.debtKopecks - principalRepaid,
            accruedInterestKopecks: remainingAccruedInterest,
            interestRemainderNumerator: remainingInterestRemainder,
            interestAccruedThroughAt: event.occurredAt,
            realizedPnlKopecks: source.realizedPnlKopecks + net - removedCost,
            positions: Object.freeze(positions)
        });
    }
    const applied = withAudit(next, event, fingerprint, 'applied');
    return Object.freeze({ state: applied, outcome: 'applied', risk: marginRiskSnapshot(applied) });
};

export interface ParallelMarginScenarioState {
    readonly virtualAccountId: string;
    readonly scenarios: readonly MarginScenarioState[];
}

export const openDefaultMarginScenarios = (
    virtualAccountId: string,
    startingCashKopecks: bigint,
    openedAt: string,
    policies: readonly MarginScenarioPolicy[] = DEFAULT_MARGIN_SCENARIO_POLICIES
): ParallelMarginScenarioState => {
    if (new Set(policies.map(policy => policy.leverage)).size !== policies.length) {
        throw new Error('duplicate margin scenario leverage');
    }
    return Object.freeze({
        virtualAccountId,
        scenarios: Object.freeze(policies.map(policy => openMarginScenario({
            scenarioId: `${virtualAccountId}:${policy.leverage}`,
            virtualAccountId,
            startingCashKopecks,
            openedAt,
            policy
        })))
    });
};

export interface MarginScenarioFailedResult {
    readonly state: MarginScenarioState;
    readonly outcome: 'failed';
    readonly reason: string;
}

export type ParallelMarginApplyResult = MarginApplyResult | MarginScenarioFailedResult;

export const applyParallelMarginEvent = (
    state: ParallelMarginScenarioState,
    event: MarginScenarioEvent
): { readonly state: ParallelMarginScenarioState; readonly results: readonly ParallelMarginApplyResult[] } => {
    const results = Object.freeze(state.scenarios.map((scenario): ParallelMarginApplyResult => {
        try {
            return applyMarginScenarioEvent(scenario, event);
        } catch (error) {
            return Object.freeze({
                state: scenario, outcome: 'failed' as const,
                reason: error instanceof Error ? error.message : String(error)
            });
        }
    }));
    return Object.freeze({
        state: Object.freeze({ virtualAccountId: state.virtualAccountId, scenarios: Object.freeze(results.map(result => result.state)) }),
        results
    });
};

export const replayMarginScenario = (
    initial: MarginScenarioState,
    events: readonly MarginScenarioEvent[]
): MarginScenarioState => events.reduce(
    (state, event) => applyMarginScenarioEvent(state, event).state,
    initial
);
