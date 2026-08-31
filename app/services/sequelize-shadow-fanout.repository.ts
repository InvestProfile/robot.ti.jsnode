import { createHash } from 'node:crypto';
import { QueryTypes, Sequelize, Transaction } from 'sequelize';
import type {
    AtomicShadowFanoutCommit,
    AtomicShadowFanoutRepository,
    ShadowScenarioState
} from '../paper/shadow-scenario-fanout';
import { openShadowScenarioStates, shadowScenarioStateFingerprint } from '../paper/shadow-scenario-fanout';
import type { ObservationExperimentConfig } from '../paper/observation-persistence';

interface StateRow {
    scenario_id: string;
    state_fingerprint: string;
    state_json: string;
}

interface CheckpointRow { source_payload_fingerprint: string }

const encode = (value: unknown) => JSON.stringify(value, (_key, item) =>
    typeof item === 'bigint' ? { $bigint: item.toString() } : item
);
const decode = <T>(value: string): T => JSON.parse(value, (_key, item) => {
    if (item && typeof item === 'object' && Object.keys(item).length === 1
        && typeof item.$bigint === 'string' && /^(0|-?[1-9]\d*)$/.test(item.$bigint)) {
        return BigInt(item.$bigint);
    }
    return item;
}) as T;
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

export class SequelizeAtomicShadowFanoutRepository implements AtomicShadowFanoutRepository {
    constructor(private readonly database: Sequelize) {}

    async loadOrInitialize(
        config: ObservationExperimentConfig,
        openedAt: string
    ): Promise<readonly ShadowScenarioState[]> {
        return this.database.transaction(async transaction => {
            let rows = await this.loadRows(config.experimentId, transaction, true);
            if (rows.length === 0) {
                const initial = openShadowScenarioStates(config, openedAt);
                for (const state of initial) {
                    const stateJson = encode(state);
                    await this.database.query(`INSERT INTO virtual_shadow_scenario_states
                        (experiment_id, scenario_id, virtual_account_id, state_fingerprint, state_json)
                        VALUES (:experimentId, :scenarioId, :virtualAccountId, :stateFingerprint, :stateJson)`, {
                        replacements: { experimentId: config.experimentId, scenarioId: state.scenarioId,
                            virtualAccountId: state.virtualAccountId, stateFingerprint: sha256(stateJson), stateJson }, transaction
                    });
                }
                rows = await this.loadRows(config.experimentId, transaction, true);
            }
            if (rows.length !== 3) throw new Error('persisted fanout scenario set is incomplete');
            return Object.freeze(rows.map(row => {
                if (sha256(row.state_json) !== row.state_fingerprint) throw new Error('scenario state persistence fingerprint mismatch');
                return decode<ShadowScenarioState>(row.state_json);
            }));
        });
    }

    async commit(input: AtomicShadowFanoutCommit): Promise<'applied' | 'idempotent'> {
        return this.database.transaction(async transaction => {
            const checkpoints = await this.database.query<CheckpointRow>(
                `SELECT source_payload_fingerprint FROM virtual_shadow_source_checkpoints
                 WHERE experiment_id = :experimentId AND source_tick_id = :sourceTickId FOR UPDATE`, {
                    replacements: { experimentId: input.experimentId, sourceTickId: input.sourceTick.sourceTickId },
                    type: QueryTypes.SELECT, transaction
                });
            if (checkpoints[0]) {
                if (checkpoints[0].source_payload_fingerprint !== input.sourceTick.payloadFingerprint) {
                    throw new Error(`source checkpoint conflict: ${input.sourceTick.sourceTickId}`);
                }
                return 'idempotent';
            }
            const current = await this.loadRows(input.experimentId, transaction, true);
            if (current.length !== 3 || input.previous.length !== 3 || input.next.length !== 3) {
                throw new Error('atomic fanout commit requires exactly three scenarios');
            }
            for (const previous of input.previous) {
                const row = current.find(candidate => candidate.scenario_id === previous.scenarioId);
                if (!row || shadowScenarioStateFingerprint(decode<ShadowScenarioState>(row.state_json))
                    !== shadowScenarioStateFingerprint(previous)) {
                    throw new Error(`stale fanout scenario state: ${previous.scenarioId}`);
                }
            }
            for (const state of input.next) {
                const stateJson = encode(state);
                const stateFingerprint = sha256(stateJson);
                await this.database.query(`UPDATE virtual_shadow_scenario_states SET
                    state_version = state_version + 1, state_fingerprint = :stateFingerprint,
                    state_json = :stateJson, last_source_tick_id = :sourceTickId, updated_at = CURRENT_TIMESTAMP
                    WHERE experiment_id = :experimentId AND scenario_id = :scenarioId`, {
                    replacements: { experimentId: input.experimentId, scenarioId: state.scenarioId,
                        sourceTickId: input.sourceTick.sourceTickId, stateFingerprint, stateJson }, transaction
                });
                const previous = input.previous.find(item => item.scenarioId === state.scenarioId);
                const newAudit = state.margin.audit.slice(previous?.margin.audit.length ?? 0);
                for (const audit of newAudit) await this.database.query(`INSERT INTO virtual_shadow_margin_audit
                    (experiment_id, source_tick_id, scenario_id, event_id, audit_json)
                    VALUES (:experimentId, :sourceTickId, :scenarioId, :eventId, :auditJson)`, {
                    replacements: { experimentId: input.experimentId, sourceTickId: input.sourceTick.sourceTickId,
                        scenarioId: state.scenarioId, eventId: audit.eventId, auditJson: encode(audit) }, transaction
                });
            }
            const evidenceJson = encode(input.evidenceTick);
            await this.database.query(`INSERT INTO virtual_observation_ticks
                (experiment_id, tick_id, observed_at, payload_fingerprint, payload_json)
                VALUES (:experimentId, :tickId, :observedAt, :payloadFingerprint, :payloadJson)`, {
                replacements: { experimentId: input.experimentId, tickId: input.evidenceTick.tickId,
                    observedAt: input.evidenceTick.observedAt, payloadFingerprint: sha256(evidenceJson), payloadJson: evidenceJson }, transaction
            });
            await this.database.query(`INSERT INTO virtual_shadow_source_checkpoints
                (experiment_id, source_tick_id, source_payload_fingerprint, evidence_tick_id)
                VALUES (:experimentId, :sourceTickId, :sourcePayloadFingerprint, :evidenceTickId)`, {
                replacements: { experimentId: input.experimentId, sourceTickId: input.sourceTick.sourceTickId,
                    sourcePayloadFingerprint: input.sourceTick.payloadFingerprint, evidenceTickId: input.evidenceTick.tickId }, transaction
            });
            return 'applied';
        });
    }

    async hasCheckpoint(experimentId: string, sourceTick: AtomicShadowFanoutCommit['sourceTick']): Promise<boolean> {
        const rows = await this.database.query<CheckpointRow>(
            `SELECT source_payload_fingerprint FROM virtual_shadow_source_checkpoints
             WHERE experiment_id = :experimentId AND source_tick_id = :sourceTickId`, {
                replacements: { experimentId, sourceTickId: sourceTick.sourceTickId }, type: QueryTypes.SELECT
            });
        if (!rows[0]) return false;
        if (rows[0].source_payload_fingerprint !== sourceTick.payloadFingerprint) {
            throw new Error(`source checkpoint conflict: ${sourceTick.sourceTickId}`);
        }
        return true;
    }

    private loadRows(experimentId: string, transaction: Transaction, lock: boolean) {
        return this.database.query<StateRow>(`SELECT scenario_id, state_fingerprint, state_json
            FROM virtual_shadow_scenario_states WHERE experiment_id = :experimentId
            ORDER BY scenario_id${lock ? ' FOR UPDATE' : ''}`, {
            replacements: { experimentId }, type: QueryTypes.SELECT, transaction
        });
    }
}
