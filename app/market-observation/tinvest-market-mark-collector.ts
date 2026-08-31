import {
    CollectorClock,
    CollectorLease,
    CollectorLeasePort,
    CollectorLeaseOwnershipProof,
    CollectorLeaseOwnershipLostError,
    MarketMarkWritePort,
    ReadonlyMarketDataPort,
    ReadonlyMarketDataQuote,
    UniverseReadPort
} from './tinvest-readonly-market-data.port';
import { createBrokerMarketMark, type BrokerMarketMark } from './types';

export interface MarketMarkCollectorOptions {
    ownerId: string;
    leaseTtlMs: number;
    batchSize: number;
    maxAttempts: number;
    initialBackoffMs: number;
    maxBackoffMs: number;
}

export interface MarketMarkCollectionResult {
    acquired: boolean;
    requested: number;
    received: number;
    inserted: number;
    duplicates: number;
    batches: number;
}

const nonEmpty = (value: string, field: string): string => {
    const normalized = value.trim();
    if (!normalized) throw new TypeError(`${field} must be non-empty`);
    return normalized;
};

const canonicalTimestamp = (value: string, field: string): string => {
    nonEmpty(value, field);
    const milliseconds = Date.parse(value);
    if (!Number.isFinite(milliseconds)) throw new TypeError(`${field} must be a valid broker timestamp`);
    return new Date(milliseconds).toISOString();
};

const midpoint = (bid: bigint, ask: bigint): bigint => {
    if (bid <= 0n || ask <= 0n) throw new TypeError('bid and ask must be positive');
    if (bid > ask) throw new Error('crossed market quote');
    return bid + (ask - bid) / 2n;
};

const toMark = (quote: ReadonlyMarketDataQuote, receivedAt: string): BrokerMarketMark => {
    const observationId = nonEmpty(quote.sourceObservationId, 'sourceObservationId');
    const instrumentUid = nonEmpty(quote.instrumentUid, 'instrumentUid');
    // This value is mandatory and comes only from the injected market-data port.
    // receivedAt is intentionally never used as a fallback.
    const brokerObservedAt = canonicalTimestamp(quote.brokerObservedAt, 'brokerObservedAt');
    return createBrokerMarketMark({
        observationId,
        sourceIdentity: instrumentUid + ':' + brokerObservedAt + ':' + (quote.sourceSequence || observationId),
        instrumentUid,
        brokerObservedAt,
        receivedAt,
        bidKopecks: quote.bidKopecks,
        askKopecks: quote.askKopecks,
        markKopecks: midpoint(quote.bidKopecks, quote.askKopecks),
        source: 't-invest-market-data-readonly' as const,
        ...(quote.sourceSequence === undefined
            ? {}
            : { sourceSequence: nonEmpty(quote.sourceSequence, 'sourceSequence') }),
        sessionStatus: quote.sessionStatus
    });
};

const validateOptions = (options: MarketMarkCollectorOptions): MarketMarkCollectorOptions => {
    nonEmpty(options.ownerId, 'ownerId');
    for (const [field, value] of [
        ['leaseTtlMs', options.leaseTtlMs], ['batchSize', options.batchSize],
        ['maxAttempts', options.maxAttempts], ['initialBackoffMs', options.initialBackoffMs],
        ['maxBackoffMs', options.maxBackoffMs]
    ] as const) if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${field} must be a positive safe integer`);
    if (options.initialBackoffMs > options.maxBackoffMs) throw new TypeError('initialBackoffMs cannot exceed maxBackoffMs');
    return Object.freeze({ ...options });
};

export class TInvestMarketMarkCollector {
    private readonly options: MarketMarkCollectorOptions;

    constructor(
        private readonly marketData: ReadonlyMarketDataPort,
        private readonly marks: MarketMarkWritePort,
        private readonly universe: UniverseReadPort,
        private readonly leases: CollectorLeasePort,
        private readonly clock: CollectorClock,
        options: MarketMarkCollectorOptions
    ) { this.options = validateOptions(options); }

    async collectOnce(): Promise<MarketMarkCollectionResult> {
        const lease = await this.leases.acquire(this.options.ownerId, this.options.leaseTtlMs);
        if (!lease) return { acquired: false, requested: 0, received: 0, inserted: 0, duplicates: 0, batches: 0 };
        try { return await this.collectWithLease(lease); }
        finally { await lease.release(); }
    }

    private async collectWithLease(lease: CollectorLease): Promise<MarketMarkCollectionResult> {
        const instrumentUids = [...new Set((await this.universe.readInstrumentUids()).map(uid => nonEmpty(uid, 'instrumentUid')))].sort();
        let received = 0; let inserted = 0; let duplicates = 0; let batches = 0;
        for (let offset = 0; offset < instrumentUids.length; offset += this.options.batchSize) {
            const requested = instrumentUids.slice(offset, offset + this.options.batchSize);
            const quotes = await this.withRetry(async () => {
                await this.requireLease(lease);
                return this.marketData.readOrderBookTop(requested);
            });
            await this.requireLease(lease);
            this.assertBatch(requested, quotes);
            const receivedAt = this.clock.now().toISOString();
            for (const quote of quotes) {
                const outcome = await this.withRetry(async () => {
                    const ownership = await this.requireLease(lease);
                    return this.marks.append(toMark(quote, receivedAt), ownership);
                });
                received += 1;
                if (outcome === 'inserted') inserted += 1; else duplicates += 1;
            }
            batches += 1;
        }
        return { acquired: true, requested: instrumentUids.length, received, inserted, duplicates, batches };
    }

    private async requireLease(lease: CollectorLease): Promise<CollectorLeaseOwnershipProof> {
        const ownership = await lease.renew(this.options.leaseTtlMs);
        if (!ownership) throw new CollectorLeaseOwnershipLostError();
        return ownership;
    }

    private assertBatch(requested: readonly string[], quotes: readonly ReadonlyMarketDataQuote[]): void {
        const expected = new Set(requested);
        const actual = new Set<string>();
        for (const quote of quotes) {
            const uid = nonEmpty(quote.instrumentUid, 'instrumentUid');
            if (!expected.has(uid)) throw new Error(`market-data port returned unrequested instrument ${uid}`);
            if (actual.has(uid)) throw new Error(`market-data port returned duplicate instrument ${uid}`);
            actual.add(uid);
        }
        if (actual.size !== expected.size) throw new Error('market-data batch has incomplete instrument coverage');
    }

    private async withRetry<T>(operation: () => Promise<T>): Promise<T> {
        let backoffMs = this.options.initialBackoffMs;
        for (let attempt = 1; ; attempt += 1) {
            try { return await operation(); }
            catch (error) {
                if (error instanceof CollectorLeaseOwnershipLostError) throw error;
                if (attempt >= this.options.maxAttempts) throw error;
                await this.clock.sleep(backoffMs);
                backoffMs = Math.min(backoffMs * 2, this.options.maxBackoffMs);
            }
        }
    }
}
