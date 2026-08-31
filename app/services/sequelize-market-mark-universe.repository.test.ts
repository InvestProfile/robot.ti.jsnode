import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { QueryOptions } from 'sequelize';
import { SequelizeMarketMarkUniverseRepository } from './sequelize-market-mark-universe.repository';

interface FakeRows {
    sql: readonly { instrument_uid: string }[];
    states: readonly { experiment_id: string; scenario_id: string; state_json: string }[];
}

class FakeDatabase {
    readonly calls: string[] = [];

    constructor(private readonly rows: FakeRows) {}

    async query<T>(sql: string, _options: QueryOptions = {}): Promise<T[]> {
        const normalized = sql.replace(/\s+/g, ' ').trim();
        this.calls.push(normalized);
        return (normalized.includes('FROM virtual_shadow_scenario_states ORDER BY')
            ? this.rows.states : this.rows.sql) as T[];
    }
}

const state = (input: unknown) => ({
    experiment_id: 'experiment-1',
    scenario_id: '1.0x',
    state_json: JSON.stringify(input)
});

describe('SequelizeMarketMarkUniverseRepository', () => {
    it('returns the deterministic union of pending source, active v2 benchmark, positions and liquidation IDs', async () => {
        const database = new FakeDatabase({
            sql: [{ instrument_uid: ' source-b ' }, { instrument_uid: 'benchmark-a' }],
            states: [state({
                margin: { positions: [{ instrumentId: 'position-c' }, { instrumentId: 'benchmark-a' }] },
                liquidationPlan: { instrumentIds: [' liquidation-d ', 'position-c'] }
            })]
        });
        const repository = new SequelizeMarketMarkUniverseRepository(database as never);

        assert.deepEqual(await repository.readInstrumentUids(), [
            'benchmark-a', 'liquidation-d', 'position-c', 'source-b'
        ]);
        assert.match(database.calls[0], /ticks\.status IN \('collecting', 'complete'\)/);
        assert.match(database.calls[0], /ticks\.processed_at IS NULL/);
        assert.match(database.calls[0], /experiments\.config_version = 2/);
        assert.match(database.calls[0], /EXISTS \( SELECT 1 FROM virtual_shadow_scenario_states/);
        assert.match(database.calls[0], /UNION/);
        assert.match(database.calls[0], /ORDER BY instrument_uid$/);
        assert.match(database.calls[1], /ORDER BY experiment_id, scenario_id$/);
    });

    it('accepts states without a liquidation plan and returns an immutable empty universe', async () => {
        const database = new FakeDatabase({
            sql: [],
            states: [state({ margin: { positions: [] } })]
        });
        const result = await new SequelizeMarketMarkUniverseRepository(database as never).readInstrumentUids();
        assert.deepEqual(result, []);
        assert.equal(Object.isFrozen(result), true);
    });

    it('fails closed for malformed or structurally invalid state JSON', async () => {
        const malformed = new FakeDatabase({
            sql: [], states: [{ experiment_id: 'experiment-1', scenario_id: '1.0x', state_json: '{' }]
        });
        await assert.rejects(
            new SequelizeMarketMarkUniverseRepository(malformed as never).readInstrumentUids(),
            /malformed scenario state JSON: experiment-1\/1\.0x/
        );

        for (const invalid of [
            null,
            {},
            { margin: null },
            { margin: { positions: null } },
            { margin: { positions: [null] } },
            { margin: { positions: [{ instrumentId: 7 }] } },
            { margin: { positions: [] }, liquidationPlan: null },
            { margin: { positions: [] }, liquidationPlan: { instrumentIds: null } }
        ]) {
            const database = new FakeDatabase({ sql: [], states: [state(invalid)] });
            await assert.rejects(new SequelizeMarketMarkUniverseRepository(database as never).readInstrumentUids());
        }
    });

    it('rejects blank identifiers from SQL, positions and liquidation plans', async () => {
        const inputs: FakeRows[] = [
            { sql: [{ instrument_uid: '  ' }], states: [] },
            { sql: [], states: [state({ margin: { positions: [{ instrumentId: ' ' }] } })] },
            { sql: [], states: [state({ margin: { positions: [] }, liquidationPlan: { instrumentIds: [''] } })] }
        ];
        for (const rows of inputs) {
            await assert.rejects(
                new SequelizeMarketMarkUniverseRepository(new FakeDatabase(rows) as never).readInstrumentUids(),
                /must be non-empty/
            );
        }
    });
});
