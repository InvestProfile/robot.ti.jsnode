import { applyVirtualLedgerEvent, openVirtualCashAccount, replayVirtualLedger } from './ledger';
import { AccountOpenedEvent, DuplicateEventPolicy, StoredVirtualLedgerEvent, VirtualCashAccountState, VirtualLedgerEvent } from './types';
import { decodeVirtualLedgerEvent, encodeVirtualLedgerEvent } from './codecs';

export interface VirtualAccountRecord {
    readonly virtualAccountId: string;
    readonly name: string;
    readonly status: 'active' | 'closed';
    readonly openedAt: string;
}

export interface VirtualLedgerRepository {
    createAccount(account: VirtualAccountRecord, openingEvent: AccountOpenedEvent): Promise<VirtualCashAccountState>;
    append(event: VirtualLedgerEvent, duplicatePolicy?: DuplicateEventPolicy): Promise<VirtualCashAccountState>;
    load(virtualAccountId: string): Promise<VirtualCashAccountState>;
}

const eventFingerprint = (event: StoredVirtualLedgerEvent) => JSON.stringify(event);

/** DB-independent reference adapter for contract tests without production DB credentials. */
export class InMemoryVirtualLedgerRepository implements VirtualLedgerRepository {
    readonly #accounts = new Map<string, VirtualAccountRecord>();
    readonly #events = new Map<string, StoredVirtualLedgerEvent[]>();
    #writeQueue: Promise<void> = Promise.resolve();

    async #serialized<T>(operation: () => T | Promise<T>): Promise<T> {
        const previous = this.#writeQueue;
        let release: () => void = () => undefined;
        this.#writeQueue = new Promise<void>(resolve => { release = resolve; });
        await previous;
        try { return await operation(); } finally { release(); }
    }

    async createAccount(account: VirtualAccountRecord, openingEvent: AccountOpenedEvent) {
        return this.#serialized(() => {
            if (this.#accounts.has(account.virtualAccountId)) throw new Error(`virtual account already exists: ${account.virtualAccountId}`);
            if (openingEvent.virtualAccountId !== account.virtualAccountId) throw new Error('opening event account does not match account record');
            const state = openVirtualCashAccount(openingEvent);
            this.#accounts.set(account.virtualAccountId, Object.freeze({ ...account }));
            this.#events.set(account.virtualAccountId, [encodeVirtualLedgerEvent(state.entries[0])]);
            return state;
        });
    }

    async append(event: VirtualLedgerEvent, duplicatePolicy: DuplicateEventPolicy = 'reject') {
        return this.#serialized(() => {
            const stored = this.#events.get(event.virtualAccountId);
            if (!stored) throw new Error(`virtual account not found: ${event.virtualAccountId}`);
            const before = replayVirtualLedger(stored.map(decodeVirtualLedgerEvent));
            const after = applyVirtualLedgerEvent(before, event, duplicatePolicy);
            if (after !== before) stored.push(encodeVirtualLedgerEvent(after.entries[after.entries.length - 1]));
            return after;
        });
    }

    async load(virtualAccountId: string) {
        const stored = this.#events.get(virtualAccountId);
        if (!stored) throw new Error(`virtual account not found: ${virtualAccountId}`);
        return replayVirtualLedger(stored.map(event => decodeVirtualLedgerEvent({ ...event })));
    }

    storedEventFingerprint(virtualAccountId: string, eventId: string) {
        const event = this.#events.get(virtualAccountId)?.find(candidate => candidate.id === eventId);
        return event ? eventFingerprint(event) : undefined;
    }
}
