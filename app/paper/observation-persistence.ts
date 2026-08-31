import { createHash, randomUUID } from 'node:crypto';
import { QueryTypes, Sequelize } from 'sequelize';

export const OBSERVATION_SCENARIOS = Object.freeze([
    Object.freeze({ scenarioId: '1.0x', leverage: 1 }),
    Object.freeze({ scenarioId: '1.2x', leverage: 1.2 }),
    Object.freeze({ scenarioId: '1.5x', leverage: 1.5 })
] as const);

export interface ObservationExperimentConfig {
    readonly experimentId: string;
    readonly scenarios: typeof OBSERVATION_SCENARIOS;
}

const canonicalConfig = (experimentId: string): ObservationExperimentConfig => Object.freeze({
    experimentId,
    scenarios: OBSERVATION_SCENARIOS
});

const serializeConfig = (config: ObservationExperimentConfig) => JSON.stringify(config);
const fingerprint = (value: string) => createHash('sha256').update(value).digest('hex');

interface Migration {
    readonly version: string;
    readonly statements: readonly string[];
}

export const OBSERVATION_MIGRATIONS: readonly Migration[] = Object.freeze([
    {
        version: '001_observation_core',
        statements: Object.freeze([
            `CREATE TABLE IF NOT EXISTS virtual_observation_schema_versions (
                version VARCHAR(100) PRIMARY KEY,
                applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
            )`,
            `CREATE TABLE IF NOT EXISTS virtual_observation_experiments (
                experiment_id VARCHAR(255) PRIMARY KEY,
                config_fingerprint CHAR(64) NOT NULL,
                config_json TEXT NOT NULL,
                created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
            )`,
            `CREATE TABLE IF NOT EXISTS virtual_observation_leases (
                lease_name VARCHAR(255) PRIMARY KEY,
                owner_id VARCHAR(255) NOT NULL,
                expires_at TIMESTAMPTZ NOT NULL,
                created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
            )`,
            `CREATE TABLE IF NOT EXISTS virtual_observation_ticks (
                sequence BIGSERIAL PRIMARY KEY,
                experiment_id VARCHAR(255) NOT NULL,
                tick_id VARCHAR(255) NOT NULL,
                observed_at VARCHAR(255) NOT NULL,
                payload_fingerprint VARCHAR(255) NOT NULL,
                payload_json TEXT NOT NULL,
                created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
                CONSTRAINT virtual_observation_tick_unique UNIQUE (experiment_id, tick_id)
            )`,
            `CREATE INDEX IF NOT EXISTS virtual_observation_time_sequence
                ON virtual_observation_ticks (experiment_id, observed_at, sequence)`
        ])
    }
]);

export const runObservationMigrations = async (database: Sequelize): Promise<void> => {
    if (database.getDialect() !== 'postgres') {
        throw new Error(`virtual observation migrations require postgres, got ${database.getDialect()}`);
    }
    for (const migration of OBSERVATION_MIGRATIONS) {
        await database.transaction(async transaction => {
            await database.query(OBSERVATION_MIGRATIONS[0].statements[0], { transaction });
            const applied = await database.query<{ version: string }>(
                'SELECT version FROM virtual_observation_schema_versions WHERE version = :version',
                { replacements: { version: migration.version }, type: QueryTypes.SELECT, transaction }
            );
            if (applied.length > 0) return;
            for (const statement of migration.statements.slice(1)) {
                await database.query(statement, { transaction });
            }
            await database.query(
                'INSERT INTO virtual_observation_schema_versions (version) VALUES (:version) ON CONFLICT (version) DO NOTHING',
                { replacements: { version: migration.version }, transaction }
            );
        });
    }
};

export class ObservationExperimentRepository {
    constructor(private readonly database: Sequelize) {}

    async open(experimentId: string): Promise<ObservationExperimentConfig> {
        const normalizedId = experimentId.trim();
        if (!normalizedId) throw new Error('experimentId is required');
        const config = canonicalConfig(normalizedId);
        const configJson = serializeConfig(config);
        const configFingerprint = fingerprint(configJson);
        await this.database.query(
            `INSERT INTO virtual_observation_experiments
                (experiment_id, config_fingerprint, config_json)
             VALUES (:experimentId, :configFingerprint, :configJson)
             ON CONFLICT (experiment_id) DO NOTHING`,
            { replacements: { experimentId: normalizedId, configFingerprint, configJson } }
        );
        const rows = await this.database.query<{ config_fingerprint: string; config_json: string }>(
            `SELECT config_fingerprint, config_json FROM virtual_observation_experiments
             WHERE experiment_id = :experimentId`,
            { replacements: { experimentId: normalizedId }, type: QueryTypes.SELECT }
        );
        const persisted = rows[0];
        if (!persisted || persisted.config_fingerprint !== configFingerprint || persisted.config_json !== configJson) {
            throw new Error(`immutable observation experiment configuration conflict: ${normalizedId}`);
        }
        return config;
    }
}

export interface ObservationLease {
    readonly leaseName: string;
    readonly ownerId: string;
    renew(): Promise<boolean>;
    release(): Promise<void>;
}

export class ObservationLeaseRepository {
    constructor(
        private readonly database: Sequelize,
        private readonly ownerId: string = randomUUID()
    ) {}

    async acquire(leaseName: string, ttlMs: number): Promise<ObservationLease | undefined> {
        this.assertInput(leaseName, ttlMs);
        const rows = await this.database.query<{ owner_id: string }>(
            `INSERT INTO virtual_observation_leases (lease_name, owner_id, expires_at)
             VALUES (:leaseName, :ownerId, CURRENT_TIMESTAMP + (:ttlMs * INTERVAL '1 millisecond'))
             ON CONFLICT (lease_name) DO UPDATE SET
                owner_id = EXCLUDED.owner_id,
                expires_at = EXCLUDED.expires_at,
                updated_at = CURRENT_TIMESTAMP
             WHERE virtual_observation_leases.expires_at <= CURRENT_TIMESTAMP
                OR virtual_observation_leases.owner_id = EXCLUDED.owner_id
             RETURNING owner_id`,
            { replacements: { leaseName, ownerId: this.ownerId, ttlMs }, type: QueryTypes.SELECT }
        );
        if (rows[0]?.owner_id !== this.ownerId) return undefined;
        return Object.freeze({
            leaseName,
            ownerId: this.ownerId,
            renew: () => this.renew(leaseName, ttlMs),
            release: () => this.release(leaseName)
        });
    }

    private async renew(leaseName: string, ttlMs: number): Promise<boolean> {
        const rows = await this.database.query<{ owner_id: string }>(
            `UPDATE virtual_observation_leases
             SET expires_at = CURRENT_TIMESTAMP + (:ttlMs * INTERVAL '1 millisecond'), updated_at = CURRENT_TIMESTAMP
             WHERE lease_name = :leaseName AND owner_id = :ownerId AND expires_at > CURRENT_TIMESTAMP
             RETURNING owner_id`,
            { replacements: { leaseName, ownerId: this.ownerId, ttlMs }, type: QueryTypes.SELECT }
        );
        return rows[0]?.owner_id === this.ownerId;
    }

    private async release(leaseName: string): Promise<void> {
        await this.database.query(
            'DELETE FROM virtual_observation_leases WHERE lease_name = :leaseName AND owner_id = :ownerId',
            { replacements: { leaseName, ownerId: this.ownerId } }
        );
    }

    private assertInput(leaseName: string, ttlMs: number): void {
        if (!leaseName.trim()) throw new Error('leaseName is required');
        if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) throw new Error('lease ttlMs must be a positive integer');
    }
}
