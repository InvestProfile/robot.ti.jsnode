import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Sequelize } from 'sequelize';
import {
    OBSERVATION_MIGRATIONS,
    ObservationExperimentRepository,
    ObservationLeaseRepository,
    runObservationMigrations,
    verifyObservationMigrations
} from './observation-persistence';

interface QueryOptions { replacements?: Record<string, unknown> }

class FakeDatabase {
    readonly statements: string[] = [];
    readonly versions = new Set<string>();
    readonly experiments = new Map<string, { config_fingerprint: string; config_json: string }>();
    readonly leases = new Map<string, { ownerId: string; expires: number }>();
    now = 1000;
    dialect = 'postgres';

    getDialect() { return this.dialect; }
    async transaction<T>(work: (transaction: object) => Promise<T>) { return work({}); }
    async query(sql: string, options: QueryOptions = {}): Promise<unknown> {
        this.statements.push(sql);
        const values = options.replacements ?? {};
        if (sql.includes('SELECT version FROM') && values.version === undefined) {
            return [...this.versions].map(version => ({ version }));
        }
        if (sql.includes('SELECT version FROM')) return this.versions.has(String(values.version)) ? [{ version: values.version }] : [];
        if (sql.includes('INSERT INTO virtual_observation_schema_versions')) { this.versions.add(String(values.version)); return [[], 1]; }
        if (sql.includes('INSERT INTO virtual_observation_experiments')) {
            const id = String(values.experimentId);
            if (!this.experiments.has(id)) this.experiments.set(id, {
                config_fingerprint: String(values.configFingerprint), config_json: String(values.configJson)
            });
            return [[], 1];
        }
        if (sql.includes('SELECT config_fingerprint')) return [this.experiments.get(String(values.experimentId))].filter(Boolean);
        if (sql.includes('INSERT INTO virtual_observation_leases')) {
            const name = String(values.leaseName); const ownerId = String(values.ownerId);
            const current = this.leases.get(name);
            if (!current || current.expires <= this.now || current.ownerId === ownerId) {
                this.leases.set(name, { ownerId, expires: this.now + Number(values.ttlMs) });
                return [{ owner_id: ownerId }];
            }
            return [];
        }
        if (sql.includes('UPDATE virtual_observation_leases')) {
            const name = String(values.leaseName); const ownerId = String(values.ownerId);
            const current = this.leases.get(name);
            if (current?.ownerId === ownerId && current.expires > this.now) {
                current.expires = this.now + Number(values.ttlMs); return [{ owner_id: ownerId }];
            }
            return [];
        }
        if (sql.includes('DELETE FROM virtual_observation_leases')) {
            const name = String(values.leaseName); const current = this.leases.get(name);
            if (current?.ownerId === values.ownerId) this.leases.delete(name);
            return [[], 1];
        }
        return [[], 0];
    }
}

const sequelize = (database: FakeDatabase) => database as unknown as Sequelize;
const LEGACY_CONFIG_JSON = '{"experimentId":"legacy","scenarios":[{"scenarioId":"1.0x","leverage":1},{"scenarioId":"1.2x","leverage":1.2},{"scenarioId":"1.5x","leverage":1.5}],"startingCashKopecks":"100000000","executionPolicy":{"feeBasisPoints":10,"slippageBasisPoints":10,"maxQuoteAgeMs":5000},"marginPolicies":[{"leverage":"1x","version":"pm06-v1","initialMarginBps":10000,"maintenanceMarginBps":7500,"annualInterestBps":0,"allowBorrowedAveragingDown":false,"markMaxAgeSeconds":300},{"leverage":"1.2x","version":"pm06-v1","initialMarginBps":8334,"maintenanceMarginBps":6667,"annualInterestBps":1800,"allowBorrowedAveragingDown":false,"markMaxAgeSeconds":300},{"leverage":"1.5x","version":"pm06-v1","initialMarginBps":6667,"maintenanceMarginBps":5000,"annualInterestBps":1800,"allowBorrowedAveragingDown":false,"markMaxAgeSeconds":300}],"benchmarkId":null}';

describe('virtual observation persistence', () => {
    it('applies additive PostgreSQL migrations once and rejects another dialect', async () => {
        const database = new FakeDatabase();
        await runObservationMigrations(sequelize(database));
        const firstCount = database.statements.length;
        await runObservationMigrations(sequelize(database));
        assert.equal(OBSERVATION_MIGRATIONS.every(migration => database.versions.has(migration.version)), true);
        assert.equal(database.statements.some(statement => statement.includes('CREATE TABLE IF NOT EXISTS shadow_source_ticks')), true);
        assert.equal(database.statements.length, firstCount + (OBSERVATION_MIGRATIONS.length * 2));
        assert.match(OBSERVATION_MIGRATIONS[1].statements.join('\n'), /CREATE TABLE IF NOT EXISTS shadow_source_ticks/);
        assert.match(OBSERVATION_MIGRATIONS[1].statements.join('\n'), /CREATE TABLE IF NOT EXISTS shadow_source_events/);
        assert.match(OBSERVATION_MIGRATIONS[2].statements.join('\n'), /source_account_id/);
        assert.match(OBSERVATION_MIGRATIONS[3].statements.join('\n'), /virtual_shadow_source_checkpoints/);
        assert.match(OBSERVATION_MIGRATIONS[3].statements.join('\n'), /virtual_shadow_margin_audit/);
        database.dialect = 'mysql';
        await assert.rejects(runObservationMigrations(sequelize(database)), /require postgres/);
    });

    it('verifies a fully migrated schema without issuing DDL and fails for a missing version', async () => {
        const database = new FakeDatabase();
        await runObservationMigrations(sequelize(database));
        database.statements.length = 0;
        await verifyObservationMigrations(sequelize(database));
        assert.equal(database.statements.some(statement => /CREATE|ALTER/i.test(statement)), false);
        database.versions.delete(OBSERVATION_MIGRATIONS.at(-1)!.version);
        await assert.rejects(verifyObservationMigrations(sequelize(database)), /migrations missing/);
    });

    it('persists exactly the immutable 1.0x, 1.2x and 1.5x configuration', async () => {
        const database = new FakeDatabase();
        const repository = new ObservationExperimentRepository(sequelize(database));
        const first = await repository.open('experiment-1');
        assert.deepEqual(first.scenarios, [
            { scenarioId: '1.0x', leverage: 1 },
            { scenarioId: '1.2x', leverage: 1.2 },
            { scenarioId: '1.5x', leverage: 1.5 }
        ]);
        assert.deepEqual(await repository.open('experiment-1'), first);
        const persisted = database.experiments.get('experiment-1');
        assert.ok(persisted);
        database.experiments.set('experiment-1', { ...persisted, config_json: '{"changed":true}' });
        await assert.rejects(repository.open('experiment-1'), /configuration conflict/);
    });

    it('keeps legacy config byte-compatible and makes v2 explicit and immutable', async () => {
        const database = new FakeDatabase();
        const repository = new ObservationExperimentRepository(sequelize(database));
        const legacy = await repository.open('legacy');
        assert.equal('configVersion' in legacy, false);
        assert.equal(database.experiments.get('legacy')?.config_json, LEGACY_CONFIG_JSON);
        const evidenceConfig = {
            configVersion: 2 as const,
            marketDataSource: 't-invest-market-data-readonly' as const,
            sessionPolicyVersion: 't-invest-session-v1-open-only' as const,
            benchmarkInstrumentUid: 'f509af83-6e71-462f-901f-bcb073f6773b',
            benchmarkMethodology: 'normalized-price-return' as const,
            benchmarkReturnScope: 'price-only-excludes-dividends-fees-and-total-return' as const,
            maxMarkAgeMs: 5000,
            maxInterInstrumentSkewMs: 1000
        };
        const qualified = await repository.open('qualified', { evidenceConfig });
        assert.equal('configVersion' in qualified && qualified.configVersion, 2);
        assert.deepEqual(await repository.open('qualified', { evidenceConfig }), qualified);
        await assert.rejects(repository.open('qualified'));
        await assert.rejects(repository.open('bad', { evidenceConfig: { ...evidenceConfig, benchmarkInstrumentUid: ' ' } }));
        await assert.rejects(repository.open('fractional-age', { evidenceConfig: { ...evidenceConfig, maxMarkAgeMs: 1.5 } }));
        await assert.rejects(repository.open('unsafe-age', { evidenceConfig: { ...evidenceConfig, maxMarkAgeMs: Number.MAX_SAFE_INTEGER + 1 } }));
        await assert.rejects(repository.open('negative-skew', { evidenceConfig: { ...evidenceConfig, maxInterInstrumentSkewMs: -1 } }));
        const zeroSkew = await repository.open('zero-skew', { evidenceConfig: { ...evidenceConfig, maxInterInstrumentSkewMs: 0 } });
        assert.equal('configVersion' in zeroSkew && zeroSkew.evidenceConfig.maxInterInstrumentSkewMs, 0);
    });

    it('allows one lease owner, expiry takeover, renewal and owner-safe release', async () => {
        const database = new FakeDatabase();
        const firstRepo = new ObservationLeaseRepository(sequelize(database), 'worker-a');
        const secondRepo = new ObservationLeaseRepository(sequelize(database), 'worker-b');
        const first = await firstRepo.acquire('experiment-1', 500);
        assert.ok(first);
        assert.equal(await secondRepo.acquire('experiment-1', 500), undefined);
        assert.equal(await first.renew(), true);
        database.now += 501;
        const second = await secondRepo.acquire('experiment-1', 500);
        assert.ok(second);
        assert.equal(await first.renew(), false);
        await first.release();
        assert.equal(database.leases.get('experiment-1')?.ownerId, 'worker-b');
        await second.release();
        assert.equal(database.leases.size, 0);
    });
});
