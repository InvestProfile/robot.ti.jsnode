import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Sequelize } from 'sequelize';
import {
    OBSERVATION_MIGRATIONS,
    ObservationExperimentRepository,
    ObservationLeaseRepository,
    runObservationMigrations
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
        database.dialect = 'mysql';
        await assert.rejects(runObservationMigrations(sequelize(database)), /require postgres/);
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
