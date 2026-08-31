import { QueryTypes, Sequelize } from 'sequelize';
import type { UniverseReadPort } from '../market-observation/tinvest-readonly-market-data.port';

interface InstrumentRow {
    instrument_uid: string;
}

interface ScenarioStateRow {
    experiment_id: string;
    scenario_id: string;
    state_json: string;
}

const requireObject = (value: unknown, field: string): Record<string, unknown> => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`${field} must be an object`);
    }
    return value as Record<string, unknown>;
};

const requireArray = (value: unknown, field: string): readonly unknown[] => {
    if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
    return value;
};

const instrumentUid = (value: unknown, field: string): string => {
    if (typeof value !== 'string') throw new Error(`${field} must be a string`);
    const normalized = value.trim();
    if (!normalized) throw new Error(`${field} must be non-empty`);
    return normalized;
};

const stateInstrumentUids = (row: ScenarioStateRow): readonly string[] => {
    let decoded: unknown;
    try {
        decoded = JSON.parse(row.state_json);
    } catch {
        throw new Error(`malformed scenario state JSON: ${row.experiment_id}/${row.scenario_id}`);
    }
    const prefix = `scenario state ${row.experiment_id}/${row.scenario_id}`;
    const state = requireObject(decoded, prefix);
    const margin = requireObject(state.margin, `${prefix}.margin`);
    const positions = requireArray(margin.positions, `${prefix}.margin.positions`);
    const result = positions.map((position, index) => instrumentUid(
        requireObject(position, `${prefix}.margin.positions[${index}]`).instrumentId,
        `${prefix}.margin.positions[${index}].instrumentId`
    ));
    if (state.liquidationPlan !== undefined) {
        const plan = requireObject(state.liquidationPlan, `${prefix}.liquidationPlan`);
        result.push(...requireArray(plan.instrumentIds, `${prefix}.liquidationPlan.instrumentIds`)
            .map((value, index) => instrumentUid(value, `${prefix}.liquidationPlan.instrumentIds[${index}]`)));
    }
    return result;
};

export class SequelizeMarketMarkUniverseRepository implements UniverseReadPort {
    constructor(private readonly database: Sequelize) {}

    async readInstrumentUids(): Promise<readonly string[]> {
        const sqlRows = await this.database.query<InstrumentRow>(
            `SELECT instrument_uid FROM (
                SELECT events.instrument_id AS instrument_uid
                FROM shadow_source_events events
                INNER JOIN shadow_source_ticks ticks
                    ON ticks.source_tick_id = events.source_tick_id
                WHERE ticks.status IN ('collecting', 'complete')
                    AND ticks.processed_at IS NULL
                UNION
                SELECT experiments.benchmark_instrument_uid AS instrument_uid
                FROM virtual_observation_experiments experiments
                WHERE experiments.config_version = 2
                    AND EXISTS (
                        SELECT 1 FROM virtual_shadow_scenario_states states
                        WHERE states.experiment_id = experiments.experiment_id
                    )
            ) universe
            ORDER BY instrument_uid`,
            { type: QueryTypes.SELECT }
        );
        const stateRows = await this.database.query<ScenarioStateRow>(
            `SELECT experiment_id, scenario_id, state_json
             FROM virtual_shadow_scenario_states
             ORDER BY experiment_id, scenario_id`,
            { type: QueryTypes.SELECT }
        );
        const values = [
            ...sqlRows.map((row, index) => instrumentUid(row.instrument_uid, `SQL universe row ${index}.instrument_uid`)),
            ...stateRows.flatMap(stateInstrumentUids)
        ];
        return Object.freeze([...new Set(values)].sort());
    }
}
