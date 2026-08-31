import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Sequelize } from 'sequelize';
import { createBrokerMarketMark } from '../market-observation/types';
import { SequelizeQualifiedMarketEvidenceReadRepository } from './sequelize-qualified-market-evidence.repository';

class FakeDatabase {
    readonly results: unknown[] = [];
    readonly sql: string[] = [];
    readonly replacements: Record<string, unknown>[] = [];
    async query(sql: string, options: { replacements?: Record<string, unknown> } = {}): Promise<unknown> {
        this.sql.push(sql); this.replacements.push(options.replacements ?? {}); return this.results.shift() ?? [];
    }
}
const sequelize = (fake: FakeDatabase) => fake as unknown as Sequelize;
const canonical = createBrokerMarketMark({ observationId: 'o1', sourceIdentity: 's1', instrumentUid: 'u1',
    brokerObservedAt: '2026-08-31T12:00:00.000Z', receivedAt: '2026-08-31T12:00:01.000Z',
    bidKopecks: 99n, askKopecks: 101n, markKopecks: 100n, source: 't-invest-market-data-readonly', sessionStatus: 'open' });
const row = { observation_id: canonical.observationId, source_identity: canonical.sourceIdentity, instrument_uid: canonical.instrumentUid,
    broker_observed_at: canonical.brokerObservedAt, received_at: canonical.receivedAt, bid_kopecks: '99', ask_kopecks: '101',
    mark_kopecks: '100', source: canonical.source, session_status: canonical.sessionStatus, source_sequence: null,
    payload_fingerprint: canonical.payloadFingerprint };

describe('SequelizeQualifiedMarketEvidenceReadRepository', () => {
    it('loads deterministic latest broker marks as-of without look-ahead and preserves bigint', async () => {
        const fake = new FakeDatabase(); fake.results.push([row]);
        const repository = new SequelizeQualifiedMarketEvidenceReadRepository(sequelize(fake));
        const marks = await repository.loadAsOf({ instrumentUids: ['u1', 'u1'], valuationAt: '2026-08-31T12:00:02.000Z' });
        assert.equal(marks[0].markKopecks, 100n);
        assert.match(fake.sql[0], /broker_observed_at <= :valuationAt/);
        assert.match(fake.sql[0], /DISTINCT ON \(instrument_uid\)/);
        assert.deepEqual(fake.replacements[0].instrumentUids, ['u1']);
    });

    it('fails closed when persisted canonical fingerprint does not match decoded payload', async () => {
        const fake = new FakeDatabase(); fake.results.push([{ ...row, payload_fingerprint: '0'.repeat(64) }]);
        const repository = new SequelizeQualifiedMarketEvidenceReadRepository(sequelize(fake));
        await assert.rejects(repository.loadAsOf({ instrumentUids: ['u1'], valuationAt: '2026-08-31T12:00:02.000Z' }), /fingerprint mismatch/);
    });

    it('loads an immutable normalized benchmark baseline losslessly', async () => {
        const fake = new FakeDatabase();
        fake.results.push([{ experiment_id: 'e1', baseline_mark_set_id: 'm1', observation_id: 'o1', mark_kopecks: '100',
            broker_observed_at: '2026-08-31T12:00:00.000Z', initial_equity_kopecks: '900719925474099300',
            methodology: 'normalized-price-return', return_scope: 'price-only-excludes-dividends-fees-and-total-return',
            payload_fingerprint: canonical.payloadFingerprint }]);
        const repository = new SequelizeQualifiedMarketEvidenceReadRepository(sequelize(fake));
        const baseline = await repository.loadBenchmarkBaseline('e1');
        assert.equal(baseline?.initialEquityKopecks, 900719925474099300n);
    });
it('fails closed on non-canonical benchmark baseline metadata and money', async () => {
        const base = { experiment_id: 'e1', baseline_mark_set_id: 'm1', observation_id: 'o1', mark_kopecks: '100', broker_observed_at: '2026-08-31T12:00:00.000Z', initial_equity_kopecks: '1000', methodology: 'normalized-price-return', return_scope: 'price-only-excludes-dividends-fees-and-total-return', payload_fingerprint: canonical.payloadFingerprint };
        for (const invalid of [{ ...base, methodology: 'other' }, { ...base, return_scope: 'other' }, { ...base, payload_fingerprint: 'bad' }, { ...base, mark_kopecks: '0' }, { ...base, initial_equity_kopecks: '-1' }]) {
            const fake = new FakeDatabase(); fake.results.push([invalid]);
            const repository = new SequelizeQualifiedMarketEvidenceReadRepository(sequelize(fake));
            await assert.rejects(repository.loadBenchmarkBaseline('e1'));
        }
    });
});
