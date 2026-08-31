import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type {
    CollectorClock,
    CollectorLeaseOwnershipProof,
    CollectorLeasePort,
    MarketMarkWritePort,
    ReadonlyMarketDataPort,
    UniverseReadPort
} from './tinvest-readonly-market-data.port';

describe('read-only market-data ports', () => {
    it('are structural contracts with no runtime dependency on a broker SDK', () => {
        const marketData: ReadonlyMarketDataPort = { readOrderBookTop: async () => [] };
        const writer: MarketMarkWritePort = { append: async (_mark, ownership: CollectorLeaseOwnershipProof) => {
            assert.equal(typeof ownership.fencingToken, 'bigint');
            return 'inserted';
        } };
        const universe: UniverseReadPort = { readInstrumentUids: async () => [] };
        const leases: CollectorLeasePort = { acquire: async () => undefined };
        const clock: CollectorClock = { now: () => new Date(0), sleep: async () => undefined };
        assert.equal(typeof marketData.readOrderBookTop, 'function');
        assert.equal(typeof writer.append, 'function');
        assert.equal(typeof universe.readInstrumentUids, 'function');
        assert.equal(typeof leases.acquire, 'function');
        assert.equal(clock.now().toISOString(), '1970-01-01T00:00:00.000Z');
    });
});
