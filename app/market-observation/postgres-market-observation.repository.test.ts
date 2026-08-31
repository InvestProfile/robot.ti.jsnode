import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Sequelize } from 'sequelize';
import { PostgresMarketObservationRepository } from './postgres-market-observation.repository';
import { createBrokerMarketMark } from './types';

class FakeDatabase {
    readonly results: unknown[] = [];
    readonly sql: string[] = [];
    async transaction<T>(work: (transaction: object) => Promise<T>): Promise<T> { return work({}); }
    async query(sql: string): Promise<unknown> { this.sql.push(sql); return this.results.shift() ?? []; }
}

const database = (fake: FakeDatabase) => fake as unknown as Sequelize;
const mark = () => createBrokerMarketMark({
    observationId: 'observation-1', sourceIdentity: 'source-1', instrumentUid: 'uid-1',
    brokerObservedAt: '2026-08-31T12:00:00.000Z', receivedAt: '2026-08-31T12:00:01.000Z',
    bidKopecks: 99n, askKopecks: 101n, markKopecks: 100n,
    source: 't-invest-market-data-readonly', sessionStatus: 'open'
});

describe('PostgresMarketObservationRepository', () => {
    it('returns a monotonic lease proof and releases without deleting the fencing row', async () => {
        const fake = new FakeDatabase();
        fake.results.push([{ owner_id: 'owner', fencing_token: '7', expires_at: '2026-08-31T12:01:00.000Z' }]);
        const repository = new PostgresMarketObservationRepository(database(fake), 'collector');
        const lease = await repository.acquire('owner', 60_000);
        assert.ok(lease);
        fake.results.push([{ owner_id: 'owner', fencing_token: '7', expires_at: '2026-08-31T12:02:00.000Z' }]);
        const proof = await lease.renew(60_000);
        assert.equal(proof?.fencingToken, 7n);
        fake.results.push([]);
        await lease.release();
        assert.match(fake.sql.at(-1)!, /UPDATE virtual_market_observation_leases/);
        assert.doesNotMatch(fake.sql.at(-1)!, /DELETE/);
    });

    it('persists an inserted mark and treats an exact identity replay as duplicate', async () => {
        const fake = new FakeDatabase();
        const repository = new PostgresMarketObservationRepository(database(fake), 'collector');
        const value = mark();
        const proof = { ownerId: 'owner', fencingToken: 1n, expiresAt: '2026-08-31T12:01:00.000Z' };
        fake.results.push([{ observation_id: value.observationId }]);
        assert.equal(await repository.append(value, proof), 'inserted');
        fake.results.push([], [{ observation_id: value.observationId, source_identity: value.sourceIdentity, payload_fingerprint: value.payloadFingerprint }]);
        assert.equal(await repository.append(value, proof), 'duplicate');
    });

    it('maps the database fencing rejection to the typed ownership error', async () => {
        const fake = new FakeDatabase();
        fake.query = async () => { throw new Error('market mark collector lease ownership lost'); };
        const repository = new PostgresMarketObservationRepository(database(fake), 'collector');
        await assert.rejects(repository.append(mark(), { ownerId: 'old', fencingToken: 1n, expiresAt: '2026-08-31T12:01:00.000Z' }),
            error => error instanceof Error && error.name === 'CollectorLeaseOwnershipLostError');
    });
});
