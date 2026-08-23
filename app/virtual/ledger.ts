import { normalizeRfc3339Timestamp } from './codecs';
import {
    DuplicateEventPolicy,
    VirtualCashAccountState,
    VirtualEventIndex,
    VirtualLedgerEvent
} from './types';

const EVENT_KINDS = new Set(['account-opened', 'deposit', 'fee', 'interest', 'trade-cash']);

const requireNonEmpty = (value: string, field: string) => {
    if (typeof value !== 'string' || value.trim().length === 0 || value !== value.trim()) {
        throw new TypeError(`${field} must be a trimmed non-empty string`);
    }
};

const canonicalizeEvent = (source: VirtualLedgerEvent): VirtualLedgerEvent => {
    if (!source || typeof source !== 'object') throw new TypeError('event must be an object');
    requireNonEmpty(source.id, 'event.id');
    requireNonEmpty(source.virtualAccountId, 'event.virtualAccountId');
    if (!EVENT_KINDS.has(source.kind)) {
        throw new TypeError('unsupported virtual ledger event kind: ' + String(source.kind));
    }
    if (typeof source.amountKopecks !== 'bigint' || source.amountKopecks <= 0n) {
        throw new TypeError('event.amountKopecks must be a positive bigint');
    }

    const base = {
        id: source.id,
        virtualAccountId: source.virtualAccountId,
        occurredAt: normalizeRfc3339Timestamp(source.occurredAt),
        kind: source.kind,
        amountKopecks: source.amountKopecks
    };

    if (source.kind === 'fee' || source.kind === 'interest') {
        requireNonEmpty(source.reason, `event.${source.kind}.reason`);
        return Object.freeze({ ...base, kind: source.kind, reason: source.reason });
    }
    if (source.kind === 'trade-cash') {
        if (source.direction !== 'credit' && source.direction !== 'debit') {
            throw new TypeError('event.trade-cash.direction must be credit or debit');
        }
        requireNonEmpty(source.tradeReference, 'event.trade-cash.tradeReference');
        return Object.freeze({
            ...base,
            kind: 'trade-cash',
            direction: source.direction,
            tradeReference: source.tradeReference
        });
    }
    return Object.freeze({ ...base, kind: source.kind });
};

const fingerprint = (event: VirtualLedgerEvent) => {
    const fields = [
        event.id,
        event.virtualAccountId,
        event.occurredAt,
        event.kind,
        event.amountKopecks.toString(10),
        event.kind === 'fee' || event.kind === 'interest' ? event.reason : '',
        event.kind === 'trade-cash' ? event.direction : '',
        event.kind === 'trade-cash' ? event.tradeReference : ''
    ];
    return fields.map(value => `${value.length}:${value}`).join('|');
};

class FrozenEventIndex implements VirtualEventIndex {
    readonly #byId: Map<string, VirtualLedgerEvent>;
    readonly size: number;

    constructor(entries: readonly VirtualLedgerEvent[]) {
        this.#byId = new Map(entries.map(entry => [entry.id, entry]));
        this.size = this.#byId.size;
        Object.freeze(this);
    }

    has(id: string) {
        return this.#byId.has(id);
    }

    get(id: string) {
        return this.#byId.get(id);
    }
}

const cashDelta = (event: VirtualLedgerEvent) => {
    if (event.kind === 'account-opened' || event.kind === 'deposit') return event.amountKopecks;
    if (event.kind === 'trade-cash' && event.direction === 'credit') return event.amountKopecks;
    return -event.amountKopecks;
};

const validateDuplicatePolicy = (policy: DuplicateEventPolicy) => {
    if (policy !== 'reject' && policy !== 'ignore') {
        throw new TypeError('duplicate policy must be reject or ignore');
    }
};

const validateCanonicalEntries = (
    virtualAccountId: string,
    entries: readonly VirtualLedgerEvent[]
) => {
    if (!Array.isArray(entries)) throw new TypeError('state.entries must be an array');
    const ids = new Set<string>();
    let cashKopecks = 0n;

    entries.forEach((entry, index) => {
        const canonical = canonicalizeEvent(entry);
        if (fingerprint(canonical) !== fingerprint(entry)) {
            throw new Error(`state entry ${entry.id} is not canonical`);
        }
        if (!Object.isFrozen(entry)) throw new Error(`state entry ${entry.id} must be frozen`);
        if (entry.virtualAccountId !== virtualAccountId) throw new Error('state entry account mismatch');
        if (index === 0 && entry.kind !== 'account-opened') {
            throw new Error('account-opened must be the first ledger event');
        }
        if (index > 0 && entry.kind === 'account-opened') {
            throw new Error('account-opened may occur exactly once');
        }
        if (ids.has(entry.id)) throw new Error(`duplicate ledger event ID in state: ${entry.id}`);
        ids.add(entry.id);
        cashKopecks += cashDelta(entry);
        if (cashKopecks < 0n) throw new Error(`state event ${entry.id} makes cash negative`);
    });

    return { cashKopecks, ids };
};

export const validateVirtualCashAccountState = (state: VirtualCashAccountState) => {
    if (!state || typeof state !== 'object') throw new TypeError('state must be an object');
    requireNonEmpty(state.virtualAccountId, 'state.virtualAccountId');
    if (!Object.isFrozen(state)) throw new Error('state must be frozen');
    if (!Object.isFrozen(state.entries)) throw new Error('state.entries must be frozen');
    if (typeof state.cashKopecks !== 'bigint' || state.cashKopecks < 0n) {
        throw new TypeError('state.cashKopecks must be a non-negative bigint');
    }
    if (!state.eventIndex || typeof state.eventIndex.get !== 'function' || typeof state.eventIndex.has !== 'function') {
        throw new TypeError('state.eventIndex must be a read-only event index');
    }

    const checked = validateCanonicalEntries(state.virtualAccountId, state.entries);
    if (state.entries.length === 0) throw new Error('virtual account must have an account-opened event');
    if (checked.cashKopecks !== state.cashKopecks) throw new Error('state cash does not reconcile with ledger');
    if (state.eventIndex.size !== checked.ids.size) throw new Error('state event index size mismatch');
    for (const entry of state.entries) {
        if (state.eventIndex.get(entry.id) !== entry) throw new Error(`state event index mismatch: ${entry.id}`);
    }
};

const makeState = (
    virtualAccountId: string,
    cashKopecks: bigint,
    entries: readonly VirtualLedgerEvent[],
    index?: VirtualEventIndex
): VirtualCashAccountState => Object.freeze({
    virtualAccountId,
    cashKopecks,
    entries: Object.freeze(entries),
    eventIndex: index ?? new FrozenEventIndex(entries)
});

const appendCanonical = (
    state: VirtualCashAccountState,
    event: VirtualLedgerEvent,
    duplicatePolicy: DuplicateEventPolicy
) => {
    const existing = state.eventIndex.get(event.id);
    if (existing) {
        if (fingerprint(existing) !== fingerprint(event)) {
            throw new Error(`virtual ledger event ID conflict: ${event.id}`);
        }
        if (duplicatePolicy === 'ignore') return state;
        throw new Error(`duplicate virtual ledger event: ${event.id}`);
    }
    if (state.entries.length === 0 && event.kind !== 'account-opened') {
        throw new Error('account-opened must be the first ledger event');
    }
    if (state.entries.length > 0 && event.kind === 'account-opened') {
        throw new Error('account-opened may occur exactly once');
    }
    if (event.virtualAccountId !== state.virtualAccountId) {
        throw new Error(`event account ${event.virtualAccountId} does not match ${state.virtualAccountId}`);
    }

    const cashKopecks = state.cashKopecks + cashDelta(event);
    if (cashKopecks < 0n) throw new Error(`event ${event.id} would make cash negative`);
    const entries = [...state.entries, event];
    return makeState(state.virtualAccountId, cashKopecks, entries);
};

export const openVirtualCashAccount = (
    event: VirtualLedgerEvent
): VirtualCashAccountState => {
    const canonical = canonicalizeEvent(event);
    if (canonical.kind !== 'account-opened') throw new Error('first event must be account-opened');
    return makeState(canonical.virtualAccountId, canonical.amountKopecks, [canonical]);
};

export const applyVirtualLedgerEvent = (
    state: VirtualCashAccountState,
    source: VirtualLedgerEvent,
    duplicatePolicy: DuplicateEventPolicy = 'reject'
): VirtualCashAccountState => {
    validateDuplicatePolicy(duplicatePolicy);
    validateVirtualCashAccountState(state);
    return appendCanonical(state, canonicalizeEvent(source), duplicatePolicy);
};

export const replayVirtualLedger = (
    events: readonly VirtualLedgerEvent[],
    duplicatePolicy: DuplicateEventPolicy = 'reject'
): VirtualCashAccountState => {
    validateDuplicatePolicy(duplicatePolicy);
    if (!Array.isArray(events) || events.length === 0) {
        throw new Error('virtual ledger requires account-opened as its first event');
    }

    const canonicalEntries: VirtualLedgerEvent[] = [];
    const byId = new Map<string, VirtualLedgerEvent>();
    let virtualAccountId = '';
    let cashKopecks = 0n;

    for (const source of events) {
        const event = canonicalizeEvent(source);
        const existing = byId.get(event.id);
        if (existing) {
            if (fingerprint(existing) !== fingerprint(event)) {
                throw new Error(`virtual ledger event ID conflict: ${event.id}`);
            }
            if (duplicatePolicy === 'ignore') continue;
            throw new Error(`duplicate virtual ledger event: ${event.id}`);
        }

        if (canonicalEntries.length === 0) {
            if (event.kind !== 'account-opened') throw new Error('account-opened must be the first ledger event');
            virtualAccountId = event.virtualAccountId;
        } else if (event.kind === 'account-opened') {
            throw new Error('account-opened may occur exactly once');
        }
        if (event.virtualAccountId !== virtualAccountId) throw new Error('ledger contains multiple virtual accounts');

        cashKopecks += cashDelta(event);
        if (cashKopecks < 0n) throw new Error(`event ${event.id} would make cash negative`);
        canonicalEntries.push(event);
        byId.set(event.id, event);
    }

    return makeState(
        virtualAccountId,
        cashKopecks,
        canonicalEntries,
        new FrozenEventIndex(canonicalEntries)
    );
};
