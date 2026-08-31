import type { BrokerMarketMark, MarketSessionStatus } from './types';

export interface ReadonlyMarketDataQuote {
    sourceObservationId: string;
    instrumentUid: string;
    brokerObservedAt: string;
    bidKopecks: bigint;
    askKopecks: bigint;
    sourceSequence?: string;
    sessionStatus: MarketSessionStatus;
}

export interface ReadonlyMarketDataPort {
    readOrderBookTop(instrumentUids: readonly string[]): Promise<readonly ReadonlyMarketDataQuote[]>;
}

export class CollectorLeaseOwnershipLostError extends Error {
    constructor(message = 'market mark collector lease lost: ownership invalid') {
        super(message);
        this.name = 'CollectorLeaseOwnershipLostError';
    }
}

export interface CollectorLeaseOwnershipProof {
    readonly ownerId: string;
    readonly fencingToken: bigint;
    readonly expiresAt: string;
}

export interface MarketMarkWritePort {
    /**
     * Persistence must atomically verify ownerId, monotonic fencingToken and unexpired
     * expiresAt against the authoritative lease row in the same transaction as append.
     * A stale or expired proof must throw CollectorLeaseOwnershipLostError before commit, including an in-flight write.
     * Persistence also owns identity/payload idempotency and rejects identity conflicts.
     */
    append(mark: BrokerMarketMark, ownership: CollectorLeaseOwnershipProof): Promise<'inserted' | 'duplicate'>;
}

export interface UniverseReadPort {
    readInstrumentUids(): Promise<readonly string[]>;
}

export interface CollectorLease {
    renew(ttlMs: number): Promise<CollectorLeaseOwnershipProof | undefined>;
    release(): Promise<void>;
}

export interface CollectorLeasePort {
    acquire(ownerId: string, ttlMs: number): Promise<CollectorLease | undefined>;
}

export interface CollectorClock {
    now(): Date;
    sleep(ms: number): Promise<void>;
}
