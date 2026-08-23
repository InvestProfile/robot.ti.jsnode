export type Kopecks = bigint;

export type VirtualLedgerEventKind =
    | 'account-opened'
    | 'deposit'
    | 'fee'
    | 'interest'
    | 'trade-cash';

interface VirtualLedgerEventBase {
    readonly id: string;
    readonly virtualAccountId: string;
    readonly occurredAt: string;
    readonly kind: VirtualLedgerEventKind;
    readonly amountKopecks: Kopecks;
}

export interface AccountOpenedEvent extends VirtualLedgerEventBase {
    readonly kind: 'account-opened';
}

export interface DepositEvent extends VirtualLedgerEventBase {
    readonly kind: 'deposit';
}

export interface FeeEvent extends VirtualLedgerEventBase {
    readonly kind: 'fee';
    readonly reason: string;
}

export interface InterestEvent extends VirtualLedgerEventBase {
    readonly kind: 'interest';
    readonly reason: string;
}

export interface TradeCashEvent extends VirtualLedgerEventBase {
    readonly kind: 'trade-cash';
    readonly direction: 'credit' | 'debit';
    readonly tradeReference: string;
}

export type VirtualLedgerEvent =
    | AccountOpenedEvent
    | DepositEvent
    | FeeEvent
    | InterestEvent
    | TradeCashEvent;

export interface VirtualEventIndex {
    readonly size: number;
    has(id: string): boolean;
    get(id: string): VirtualLedgerEvent | undefined;
}

export interface VirtualCashAccountState {
    readonly virtualAccountId: string;
    readonly cashKopecks: Kopecks;
    readonly entries: readonly VirtualLedgerEvent[];
    readonly eventIndex: VirtualEventIndex;
}

export interface ImmutablePositionMark {
    readonly instrumentId: string;
    readonly marketValueKopecks: Kopecks;
}

export interface VirtualAccountValuation {
    readonly cashKopecks: Kopecks;
    readonly positionsValueKopecks: Kopecks;
    readonly equityKopecks: Kopecks;
}

export type DuplicateEventPolicy = 'reject' | 'ignore';

export type StoredVirtualLedgerEvent = Omit<VirtualLedgerEvent, 'amountKopecks'> & {
    readonly amountKopecks: string;
};

/**
 * Persistence adapters must enforce a unique index on
 * (virtualAccountId, eventId). Domain conflict checks do not replace it.
 */
export const VIRTUAL_LEDGER_PERSISTENCE_UNIQUE_KEY =
    Object.freeze(['virtualAccountId', 'eventId'] as const);
