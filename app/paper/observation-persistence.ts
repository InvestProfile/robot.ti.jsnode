import { createHash, randomUUID } from 'node:crypto';
import { QueryTypes, Sequelize } from 'sequelize';
import { DEFAULT_MARGIN_SCENARIO_POLICIES, MarginScenarioPolicy } from '../virtual/margin';
import type { VirtualExecutionPolicy } from '../virtual/execution';

export const OBSERVATION_SCENARIOS = Object.freeze([
    Object.freeze({ scenarioId: '1.0x', leverage: 1 }),
    Object.freeze({ scenarioId: '1.2x', leverage: 1.2 }),
    Object.freeze({ scenarioId: '1.5x', leverage: 1.5 })
] as const);

export interface ObservationExperimentConfig {
    readonly experimentId: string;
    readonly scenarios: typeof OBSERVATION_SCENARIOS;
    readonly startingCashKopecks: string;
    readonly executionPolicy: VirtualExecutionPolicy;
    readonly marginPolicies: readonly MarginScenarioPolicy[];
    readonly benchmarkId: string | null;
}

export interface ObservationExperimentSettings {
    readonly startingCashKopecks?: bigint;
    readonly executionPolicy?: VirtualExecutionPolicy;
    readonly benchmarkId?: string;
}

export const DEFAULT_OBSERVATION_STARTING_CASH_KOPECKS = 100_000_000n;
export const DEFAULT_OBSERVATION_EXECUTION_POLICY: VirtualExecutionPolicy = Object.freeze({
    feeBasisPoints: 10,
    slippageBasisPoints: 10,
    maxQuoteAgeMs: 5_000
});

const canonicalConfig = (experimentId: string, settings: ObservationExperimentSettings = {}): ObservationExperimentConfig => Object.freeze({
    experimentId,
    scenarios: OBSERVATION_SCENARIOS,
    startingCashKopecks: (settings.startingCashKopecks ?? DEFAULT_OBSERVATION_STARTING_CASH_KOPECKS).toString(),
    executionPolicy: Object.freeze({ ...(settings.executionPolicy ?? DEFAULT_OBSERVATION_EXECUTION_POLICY) }),
    marginPolicies: Object.freeze(DEFAULT_MARGIN_SCENARIO_POLICIES.map(policy => Object.freeze({ ...policy }))),
    benchmarkId: settings.benchmarkId?.trim() || null
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
    },
    {
        version: '002_shadow_source_outbox',
        statements: Object.freeze([
            `CREATE TABLE IF NOT EXISTS shadow_source_ticks (
                source_tick_id VARCHAR(255) PRIMARY KEY,
                status VARCHAR(20) NOT NULL CHECK (status IN ('collecting', 'complete', 'failed')),
                started_at TIMESTAMPTZ NOT NULL,
                completed_at TIMESTAMPTZ,
                expected_event_count INTEGER NOT NULL CHECK (expected_event_count >= 0),
                actual_event_count INTEGER NOT NULL DEFAULT 0 CHECK (actual_event_count >= 0),
                policy_version VARCHAR(255) NOT NULL,
                config_fingerprint CHAR(64) NOT NULL,
                payload_fingerprint CHAR(64),
                failure_reason TEXT,
                claimed_by VARCHAR(255),
                claimed_until TIMESTAMPTZ,
                processed_at TIMESTAMPTZ,
                created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
                CONSTRAINT shadow_source_tick_terminal_shape CHECK (
                    (status = 'collecting' AND completed_at IS NULL AND payload_fingerprint IS NULL AND failure_reason IS NULL)
                    OR (status = 'complete' AND completed_at IS NOT NULL AND payload_fingerprint IS NOT NULL AND failure_reason IS NULL AND actual_event_count = expected_event_count)
                    OR (status = 'failed' AND completed_at IS NOT NULL AND failure_reason IS NOT NULL)
                )
            )`,
            `CREATE TABLE IF NOT EXISTS shadow_source_events (
                source_tick_id VARCHAR(255) NOT NULL REFERENCES shadow_source_ticks(source_tick_id),
                sequence INTEGER NOT NULL CHECK (sequence >= 0),
                event_id VARCHAR(255) NOT NULL,
                event_kind VARCHAR(20) NOT NULL CHECK (event_kind IN ('decision', 'mark')),
                instrument_id VARCHAR(255) NOT NULL,
                payload_fingerprint CHAR(64) NOT NULL,
                payload_json TEXT NOT NULL,
                created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (source_tick_id, sequence),
                CONSTRAINT shadow_source_event_id_unique UNIQUE (source_tick_id, event_id)
            )`,
            `CREATE INDEX IF NOT EXISTS shadow_source_completed_claim
                ON shadow_source_ticks (status, processed_at, claimed_until, completed_at, source_tick_id)`,
            `CREATE INDEX IF NOT EXISTS shadow_source_events_replay
                ON shadow_source_events (source_tick_id, sequence)`
        ])
    },
    {
        version: '003_shadow_source_account_identity',
        statements: Object.freeze([
            `ALTER TABLE shadow_source_events
                ADD COLUMN IF NOT EXISTS source_account_id VARCHAR(255)`,
            `CREATE INDEX IF NOT EXISTS shadow_source_events_account_replay
                ON shadow_source_events (source_account_id, source_tick_id, sequence)`
        ])
    },
    {
        version: '004_atomic_shadow_fanout',
        statements: Object.freeze([
            `CREATE TABLE IF NOT EXISTS virtual_shadow_scenario_states (
                experiment_id VARCHAR(255) NOT NULL,
                scenario_id VARCHAR(20) NOT NULL,
                virtual_account_id VARCHAR(255) NOT NULL,
                state_version BIGINT NOT NULL DEFAULT 0,
                state_fingerprint CHAR(64) NOT NULL,
                state_json TEXT NOT NULL,
                last_source_tick_id VARCHAR(255),
                created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (experiment_id, scenario_id),
                CONSTRAINT virtual_shadow_account_unique UNIQUE (experiment_id, virtual_account_id)
            )`,
            `CREATE TABLE IF NOT EXISTS virtual_shadow_margin_audit (
                experiment_id VARCHAR(255) NOT NULL,
                source_tick_id VARCHAR(255) NOT NULL,
                scenario_id VARCHAR(20) NOT NULL,
                event_id VARCHAR(255) NOT NULL,
                audit_json TEXT NOT NULL,
                created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (experiment_id, source_tick_id, scenario_id, event_id)
            )`,
            `CREATE TABLE IF NOT EXISTS virtual_shadow_source_checkpoints (
                experiment_id VARCHAR(255) NOT NULL,
                source_tick_id VARCHAR(255) NOT NULL,
                source_payload_fingerprint CHAR(64) NOT NULL,
                evidence_tick_id VARCHAR(255) NOT NULL,
                completed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (experiment_id, source_tick_id)
            )`,
            `CREATE INDEX IF NOT EXISTS virtual_shadow_audit_replay
                ON virtual_shadow_margin_audit (experiment_id, scenario_id, source_tick_id, event_id)`
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
            for (const statement of migration.statements) {
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

    async open(experimentId: string, settings: ObservationExperimentSettings = {}): Promise<ObservationExperimentConfig> {
        const normalizedId = experimentId.trim();
        if (!normalizedId) throw new Error('experimentId is required');
        const config = canonicalConfig(normalizedId, settings);
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
