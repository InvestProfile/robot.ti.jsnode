import { decodeSandboxMoney } from './sandbox-adapter';

export type SandboxLifecycleState = 'pending' | 'partial' | 'filled' | 'cancelled' | 'rejected' | 'unknown';
export type SandboxKnownLifecycleState = Exclude<SandboxLifecycleState, 'unknown'>;

export interface SandboxOrderIdentity {
    readonly accountId: string;
    readonly clientOrderId: string;
    readonly brokerOrderId: string;
    readonly orderedLots: number;
}

export interface SandboxOrderReadRequest extends SandboxOrderIdentity {
    readonly environment: 't-invest-sandbox';
}

export interface SandboxOrderReadObservation {
    readonly accountId: string;
    readonly clientOrderId: string;
    readonly brokerOrderId: string;
    readonly state: SandboxLifecycleState;
    readonly cumulativeFilledLots: number;
    readonly cumulativeGrossKopecks: string;
    readonly reason?: string;
}

export interface SandboxOrderReadPort {
    readOrder(request: SandboxOrderReadRequest): Promise<unknown>;
}

export interface SandboxReconciliationSnapshot extends SandboxOrderIdentity {
    readonly state: SandboxKnownLifecycleState;
    readonly cumulativeFilledLots: number;
    readonly cumulativeGrossKopecks: bigint;
    readonly reason?: string;
}

export interface SandboxReconcileRequest extends SandboxOrderIdentity {
    readonly reconciliationId: string;
}

export interface SandboxReconcileResult {
    readonly reconciliationId: string;
    readonly identity: SandboxOrderIdentity;
    readonly status: 'reconciled' | 'reconcile-required';
    readonly reason?: string;
    readonly snapshot?: SandboxReconciliationSnapshot;
    readonly resubmitAllowed: false;
}

export interface SandboxBatchResult {
    readonly reconciliationId: string;
    readonly result?: SandboxReconcileResult;
    readonly error?: string;
}

const TERMINAL = new Set<SandboxKnownLifecycleState>(['filled', 'cancelled', 'rejected']);

const requireText = (name: string, value: unknown): string => {
    if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
        throw new TypeError(`${name} must be a trimmed non-empty string`);
    }
    return value;
};

const requireLots = (name: string, value: unknown, allowZero = false): number => {
    if (!Number.isSafeInteger(value) || (allowZero ? Number(value) < 0 : Number(value) <= 0)) {
        throw new TypeError(`${name} must be ${allowZero ? 'a non-negative' : 'a positive'} safe integer`);
    }
    return Number(value);
};

const identityKey = (identity: SandboxOrderIdentity) => [
    identity.accountId, identity.clientOrderId, identity.brokerOrderId
].map(value => `${value.length}:${value}`).join('|');

const requestFingerprint = (request: SandboxReconcileRequest) => [
    request.accountId, request.clientOrderId, request.brokerOrderId, String(request.orderedLots)
].map(value => `${value.length}:${value}`).join('|');

const frozenIdentity = (source: SandboxOrderIdentity): SandboxOrderIdentity => Object.freeze({
    accountId: requireText('accountId', source.accountId),
    clientOrderId: requireText('clientOrderId', source.clientOrderId),
    brokerOrderId: requireText('brokerOrderId', source.brokerOrderId),
    orderedLots: requireLots('orderedLots', source.orderedLots)
});

const required = (
    request: SandboxReconcileRequest,
    reason: string,
    snapshot?: SandboxReconciliationSnapshot
): SandboxReconcileResult => Object.freeze({
    reconciliationId: request.reconciliationId,
    identity: frozenIdentity(request),
    status: 'reconcile-required',
    reason,
    ...(snapshot === undefined ? {} : { snapshot }),
    resubmitAllowed: false
});

const parseObservation = (
    source: unknown,
    expected: SandboxOrderIdentity
): { observation?: SandboxOrderReadObservation & { cumulativeGrossKopecksValue: bigint }; error?: string } => {
    if (!source || typeof source !== 'object') return { error: 'malformed sandbox order observation' };
    const value = source as Partial<SandboxOrderReadObservation>;
    try {
        const accountId = requireText('observation.accountId', value.accountId);
        const clientOrderId = requireText('observation.clientOrderId', value.clientOrderId);
        const brokerOrderId = requireText('observation.brokerOrderId', value.brokerOrderId);
        if (accountId !== expected.accountId || clientOrderId !== expected.clientOrderId
            || brokerOrderId !== expected.brokerOrderId) {
            return { error: 'sandbox order identity mismatch; account/client/broker isolation preserved' };
        }
        if (!['pending', 'partial', 'filled', 'cancelled', 'rejected', 'unknown'].includes(String(value.state))) {
            return { error: 'malformed sandbox lifecycle state' };
        }
        const cumulativeFilledLots = requireLots('cumulativeFilledLots', value.cumulativeFilledLots, true);
        const cumulativeGrossKopecksValue = decodeSandboxMoney(value.cumulativeGrossKopecks as string);
        if (value.reason !== undefined) requireText('reason', value.reason);
        return { observation: {
            accountId, clientOrderId, brokerOrderId,
            state: value.state as SandboxLifecycleState,
            cumulativeFilledLots,
            cumulativeGrossKopecks: value.cumulativeGrossKopecks as string,
            cumulativeGrossKopecksValue,
            ...(value.reason === undefined ? {} : { reason: value.reason })
        } };
    } catch {
        return { error: 'malformed sandbox order observation' };
    }
};

const applyObservation = (
    identity: SandboxOrderIdentity,
    previous: SandboxReconciliationSnapshot | undefined,
    observation: SandboxOrderReadObservation & { cumulativeGrossKopecksValue: bigint }
): { snapshot?: SandboxReconciliationSnapshot; error?: string } => {
    if (observation.state === 'unknown') return { error: observation.reason ?? 'sandbox order state is unknown' };
    if (observation.cumulativeFilledLots > identity.orderedLots) return { error: 'filled lots exceed ordered lots' };
    if (observation.state === 'pending' && observation.cumulativeFilledLots !== 0) return { error: 'pending order reports fills' };
    if (observation.state === 'partial'
        && (observation.cumulativeFilledLots === 0 || observation.cumulativeFilledLots >= identity.orderedLots)) {
        return { error: 'partial order has invalid cumulative filled lots' };
    }
    if (observation.state === 'filled' && observation.cumulativeFilledLots !== identity.orderedLots) {
        return { error: 'filled order does not match ordered lots' };
    }
    if (previous) {
        if (TERMINAL.has(previous.state) && observation.state !== previous.state) {
            return { error: `terminal state ${previous.state} cannot transition to ${observation.state}` };
        }
        if (TERMINAL.has(previous.state)
            && (observation.cumulativeFilledLots !== previous.cumulativeFilledLots
                || observation.cumulativeGrossKopecksValue !== previous.cumulativeGrossKopecks)) {
            return { error: `terminal state ${previous.state} totals are immutable` };
        }
        if (observation.cumulativeFilledLots < previous.cumulativeFilledLots
            || observation.cumulativeGrossKopecksValue < previous.cumulativeGrossKopecks) {
            return { error: 'cumulative fill totals cannot decrease' };
        }
        if (previous.state === 'partial' && observation.state === 'pending') {
            return { error: 'lifecycle state cannot regress from partial to pending' };
        }
    }
    return { snapshot: Object.freeze({
        ...frozenIdentity(identity),
        state: observation.state,
        cumulativeFilledLots: observation.cumulativeFilledLots,
        cumulativeGrossKopecks: observation.cumulativeGrossKopecksValue,
        ...(observation.reason === undefined ? {} : { reason: observation.reason })
    }) };
};

export class DeterministicSandboxReconciler {
    readonly #port: SandboxOrderReadPort;
    readonly #orders = new Map<string, SandboxReconciliationSnapshot>();
    readonly #attempts = new Map<string, { fingerprint: string; result: Promise<SandboxReconcileResult> }>();

    constructor(port: SandboxOrderReadPort, restored: readonly SandboxReconciliationSnapshot[] = []) {
        if (!port || typeof port.readOrder !== 'function') throw new TypeError('sandbox order read port is required');
        this.#port = port;
        for (const snapshot of restored) {
            const identity = frozenIdentity(snapshot);
            if (!['pending', 'partial', 'filled', 'cancelled', 'rejected'].includes(String(snapshot.state))) {
                throw new Error('invalid restored sandbox lifecycle state');
            }
            if (typeof snapshot.cumulativeGrossKopecks !== 'bigint' || snapshot.cumulativeGrossKopecks < 0n) {
                throw new TypeError('restored cumulativeGrossKopecks must be a non-negative bigint');
            }
            const validated = applyObservation(identity, undefined, {
                ...snapshot,
                state: snapshot.state,
                cumulativeGrossKopecks: snapshot.cumulativeGrossKopecks.toString(10),
                cumulativeGrossKopecksValue: snapshot.cumulativeGrossKopecks
            });
            if (!validated.snapshot) throw new Error(`invalid restored sandbox snapshot: ${validated.error}`);
            const key = identityKey(identity);
            if (this.#orders.has(key)) throw new Error(`duplicate restored sandbox order: ${key}`);
            this.#orders.set(key, validated.snapshot);
        }
    }

    reconcile(request: SandboxReconcileRequest): Promise<SandboxReconcileResult> {
        requireText('reconciliationId', request.reconciliationId);
        const identity = frozenIdentity(request);
        const fingerprint = requestFingerprint(request);
        const existingAttempt = this.#attempts.get(request.reconciliationId);
        if (existingAttempt) {
            if (existingAttempt.fingerprint !== fingerprint) {
                throw new Error(`sandbox reconciliation ID conflict: ${request.reconciliationId}`);
            }
            return existingAttempt.result;
        }
        const key = identityKey(identity);
        const previous = this.#orders.get(key);
        const result = this.#port.readOrder(Object.freeze({
            environment: 't-invest-sandbox', ...identity
        })).then(source => {
            const parsed = parseObservation(source, identity);
            if (!parsed.observation) return required(request, parsed.error as string, previous);
            const applied = applyObservation(identity, previous, parsed.observation);
            if (!applied.snapshot) return required(request, applied.error as string, previous);
            this.#orders.set(key, applied.snapshot);
            return Object.freeze({
                reconciliationId: request.reconciliationId,
                identity,
                status: 'reconciled' as const,
                snapshot: applied.snapshot,
                resubmitAllowed: false as const
            });
        }).catch(() => required(request, 'sandbox order read failed; reconcile required', previous));
        this.#attempts.set(request.reconciliationId, { fingerprint, result });
        return result;
    }

    async reconcileBatch(requests: readonly SandboxReconcileRequest[]): Promise<readonly SandboxBatchResult[]> {
        return Object.freeze(await Promise.all(requests.map(async request => {
            try {
                return Object.freeze({ reconciliationId: request.reconciliationId, result: await this.reconcile(request) });
            } catch (error) {
                return Object.freeze({
                    reconciliationId: typeof request?.reconciliationId === 'string' ? request.reconciliationId : 'invalid',
                    error: error instanceof Error ? error.message : 'unknown reconciliation error'
                });
            }
        })));
    }

    snapshots(): readonly SandboxReconciliationSnapshot[] {
        return Object.freeze([...this.#orders.values()].sort((left, right) =>
            identityKey(left).localeCompare(identityKey(right))
        ));
    }
}
