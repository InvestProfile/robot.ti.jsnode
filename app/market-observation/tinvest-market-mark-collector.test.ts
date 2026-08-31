import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TInvestMarketMarkCollector } from './tinvest-market-mark-collector';
import type {
    CollectorClock, CollectorLease, CollectorLeaseOwnershipProof, CollectorLeasePort,
    MarketMarkWritePort, ReadonlyMarketDataPort, ReadonlyMarketDataQuote, UniverseReadPort
} from './tinvest-readonly-market-data.port';
import type { BrokerMarketMark } from './types';
import { CollectorLeaseOwnershipLostError } from './tinvest-readonly-market-data.port';

class FakeClock implements CollectorClock {
    readonly sleeps: number[] = [];
    constructor(readonly instant = new Date('2026-08-31T12:00:10.000Z')) {}
    now() { return this.instant; }
    async sleep(ms: number) { this.sleeps.push(ms); }
}

class FakeLease implements CollectorLease {
    renewals = 0; released = 0; valid = true;
    ownerId = 'collector-1'; fencingToken = 1n;
    ownership(): CollectorLeaseOwnershipProof {
        return Object.freeze({ ownerId: this.ownerId, fencingToken: this.fencingToken, expiresAt: '2026-08-31T12:00:15.000Z' });
    }
    async renew() { this.renewals += 1; return this.valid ? this.ownership() : undefined; }
    async release() { this.released += 1; }
}

const quote = (uid: string, brokerObservedAt = '2026-08-31T12:00:09.123Z'): ReadonlyMarketDataQuote => ({
    sourceObservationId: `book:${uid}:42`, instrumentUid: uid, brokerObservedAt,
    bidKopecks: 100n, askKopecks: 103n, sourceSequence: '42', sessionStatus: 'open'
});

const setup = (overrides: {
    marketData?: ReadonlyMarketDataPort; writer?: MarketMarkWritePort;
    universe?: UniverseReadPort; lease?: FakeLease; clock?: FakeClock;
} = {}) => {
    const lease = overrides.lease ?? new FakeLease(); const clock = overrides.clock ?? new FakeClock();
    const written: BrokerMarketMark[] = [];
    const marketData = overrides.marketData ?? { readOrderBookTop: async (uids: readonly string[]) => uids.map(uid => quote(uid)) };
    const writer = overrides.writer ?? { append: async (mark: BrokerMarketMark) => { written.push(mark); return 'inserted' as const; } };
    const universe = overrides.universe ?? { readInstrumentUids: async () => ['uid-b', 'uid-a', 'uid-a', 'uid-c'] };
    const leases: CollectorLeasePort = { acquire: async () => lease };
    const collector = new TInvestMarketMarkCollector(marketData, writer, universe, leases, clock,
        { ownerId: 'collector-1', leaseTtlMs: 5_000, batchSize: 2, maxAttempts: 3, initialBackoffMs: 10, maxBackoffMs: 15 });
    return { collector, written, lease, clock };
};

describe('TInvestMarketMarkCollector', () => {
    it('collects bounded batches and preserves broker and receive timestamps separately', async () => {
        const batches: string[][] = [];
        const marketData: ReadonlyMarketDataPort = { readOrderBookTop: async uids => {
            batches.push([...uids]); return uids.map(uid => quote(uid));
        } };
        const context = setup({ marketData });
        assert.deepEqual(await context.collector.collectOnce(),
            { acquired: true, requested: 3, received: 3, inserted: 3, duplicates: 0, batches: 2 });
        assert.deepEqual(batches, [['uid-a', 'uid-b'], ['uid-c']]);
        assert.equal(context.written[0].brokerObservedAt, '2026-08-31T12:00:09.123Z');
        assert.equal(context.written[0].receivedAt, '2026-08-31T12:00:10.000Z');
        assert.equal(context.written[0].markKopecks, 101n);
        assert.equal(context.lease.renewals, 7); assert.equal(context.lease.released, 1);
    });

    it('fails instead of substituting local time for a missing or invalid broker timestamp', async () => {
        for (const timestamp of ['', 'not-a-time']) {
            const context = setup({ marketData: { readOrderBookTop: async uids => uids.map(uid => quote(uid, timestamp)) } });
            await assert.rejects(context.collector.collectOnce(), /brokerObservedAt/);
            assert.equal(context.written.length, 0); assert.equal(context.lease.released, 1);
        }
    });

    it('bounds retries and exponential backoff for reads and writes', async () => {
        let reads = 0; let writes = 0;
        const context = setup({
            universe: { readInstrumentUids: async () => ['uid-a'] },
            marketData: { readOrderBookTop: async () => { reads += 1; if (reads < 3) throw new Error('rate limited'); return [quote('uid-a')]; } },
            writer: { append: async () => { writes += 1; if (writes < 2) throw new Error('temporary DB error'); return 'duplicate'; } }
        });
        const result = await context.collector.collectOnce();
        assert.equal(result.duplicates, 1); assert.equal(reads, 3); assert.equal(writes, 2);
        assert.deepEqual(context.clock.sleeps, [10, 15, 10]);
    });

    it('stops after maxAttempts, releases lease, and never spins unboundedly', async () => {
        let calls = 0;
        const context = setup({ universe: { readInstrumentUids: async () => ['uid-a'] },
            marketData: { readOrderBookTop: async () => { calls += 1; throw new Error('down'); } } });
        await assert.rejects(context.collector.collectOnce(), /down/);
        assert.equal(calls, 3); assert.deepEqual(context.clock.sleeps, [10, 15]); assert.equal(context.lease.released, 1);
    });

    it('does no work without a lease and fails closed on incomplete coverage or a lost lease', async () => {
        let reads = 0;
        const unavailable = new TInvestMarketMarkCollector(
            { readOrderBookTop: async () => { reads += 1; return []; } }, { append: async () => 'inserted' },
            { readInstrumentUids: async () => ['uid-a'] }, { acquire: async () => undefined }, new FakeClock(),
            { ownerId: 'collector', leaseTtlMs: 100, batchSize: 1, maxAttempts: 1, initialBackoffMs: 1, maxBackoffMs: 1 });
        assert.equal((await unavailable.collectOnce()).acquired, false); assert.equal(reads, 0);

        const incomplete = setup({ universe: { readInstrumentUids: async () => ['uid-a'] },
            marketData: { readOrderBookTop: async () => [] } });
        await assert.rejects(incomplete.collector.collectOnce(), /incomplete instrument coverage/);
        const lostLease = new FakeLease(); lostLease.valid = false;
        const lost = setup({ lease: lostLease });
        await assert.rejects(lost.collector.collectOnce(), /lease lost/); assert.equal(lostLease.released, 1);
    });

    it('delegates duplicate identity handling to the write port', async () => {
        const seen = new Set<string>();
        const context = setup({ universe: { readInstrumentUids: async () => ['uid-a'] },
            writer: { append: async mark => seen.has(mark.observationId) ? 'duplicate' : (seen.add(mark.observationId), 'inserted') } });
        assert.equal((await context.collector.collectOnce()).inserted, 1);
        assert.equal((await context.collector.collectOnce()).duplicates, 1);
        assert.equal(seen.size, 1);
    });

    it('fails closed without writing when the lease is lost after broker read', async () => {
        const lease = new FakeLease();
        lease.renew = async () => { lease.renewals += 1; return lease.renewals < 2 ? lease.ownership() : undefined; };
        let writes = 0;
        const context = setup({
            lease,
            universe: { readInstrumentUids: async () => ['uid-a'] },
            writer: { append: async () => { writes += 1; return 'inserted'; } }
        });
        await assert.rejects(context.collector.collectOnce(), /lease lost/);
        assert.equal(writes, 0);
        assert.equal(lease.released, 1);
    });

    it('rechecks the lease before every persistence retry and stops after ownership loss', async () => {
        const lease = new FakeLease();
        lease.renew = async () => { lease.renewals += 1; return lease.renewals < 4 ? lease.ownership() : undefined; };
        let writes = 0;
        const context = setup({
            lease,
            universe: { readInstrumentUids: async () => ['uid-a'] },
            writer: { append: async () => { writes += 1; throw new Error('temporary DB error'); } }
        });
        await assert.rejects(context.collector.collectOnce(), /lease lost/);
        assert.equal(writes, 1);
        assert.equal(lease.released, 1);
    });

    it('renews before every broker read retry and does not re-read after lease loss', async () => {
        const lease = new FakeLease();
        lease.renew = async () => { lease.renewals += 1; return lease.renewals < 2 ? lease.ownership() : undefined; };
        let reads = 0;
        const context = setup({
            lease,
            universe: { readInstrumentUids: async () => ['uid-a'] },
            marketData: { readOrderBookTop: async () => { reads += 1; throw new Error('rate limited'); } }
        });
        await assert.rejects(context.collector.collectOnce(), /lease lost/);
        assert.equal(reads, 1);
        assert.deepEqual(context.clock.sleeps, [10]);
        assert.equal(lease.released, 1);
    });

    it('passes fencing proof so persistence can reject an in-flight stale owner before commit', async () => {
        const lease = new FakeLease();
        let authoritativeToken = 1n;
        let commits = 0;
        const writer: MarketMarkWritePort = { append: async (_mark, ownership) => {
            authoritativeToken = 2n;
            if (ownership.fencingToken !== authoritativeToken) throw new CollectorLeaseOwnershipLostError('stale fencing proof');
            commits += 1;
            return 'inserted';
        } };
        const context = setup({ lease, writer, universe: { readInstrumentUids: async () => ['uid-a'] } });
        await assert.rejects(context.collector.collectOnce(), /stale fencing proof/);
        assert.equal(commits, 0);
        assert.equal(lease.released, 1);
    });

    it('rejects an equal-boundary expired proof before commit with unchanged owner and fencing token', async () => {
        const lease = new FakeLease();
        const authoritativeOwnerId = lease.ownerId;
        const authoritativeToken = lease.fencingToken;
        let commits = 0;
        const writer: MarketMarkWritePort = { append: async (_mark, ownership) => {
            const now = Date.parse(ownership.expiresAt);
            const expiresAt = Date.parse(ownership.expiresAt);
            if (ownership.ownerId !== authoritativeOwnerId
                || ownership.fencingToken !== authoritativeToken
                || now >= expiresAt) {
                throw new CollectorLeaseOwnershipLostError('expired ownership proof');
            }
            commits += 1;
            return 'inserted';
        } };
        const context = setup({ lease, writer, universe: { readInstrumentUids: async () => ['uid-a'] } });
        await assert.rejects(context.collector.collectOnce(), error =>
            error instanceof CollectorLeaseOwnershipLostError && error.message === 'expired ownership proof');
        assert.equal(commits, 0);
        assert.equal(lease.ownerId, authoritativeOwnerId);
        assert.equal(lease.fencingToken, authoritativeToken);
        assert.equal(lease.released, 1);
    });
});
