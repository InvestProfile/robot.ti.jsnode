import { createHash } from 'node:crypto';
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

const baselineRow = { experiment_id: "e-history", baseline_mark_set_id: "a".repeat(64),
    observation_id: "benchmark-baseline", mark_kopecks: "200", broker_observed_at: "2026-08-31T12:00:00.000Z",
    initial_equity_kopecks: "900719925474099300", methodology: "normalized-price-return",
    return_scope: "price-only-excludes-dividends-fees-and-total-return", payload_fingerprint: "b".repeat(64) };

const pointRow = (scenarioId: string, overrides: Record<string, unknown> = {}) => {
    const point = {
        observationId: "benchmark-point", brokerObservedAt: "2026-08-31T12:05:00.000Z", markKopecks: 210n,
        scenarioEquityKopecks: 900719925474099399n, benchmarkEquityKopecks: 945755921747804265n,
        benchmarkPnlKopecks: 45035996273704965n, scenarioPnlKopecks: 99n,
        scenarioReturnBps: 0n, benchmarkReturnBps: 500n,
        excessPnlKopecks: -45035996273704866n, excessReturnBps: -500n
    };
    const payloadFingerprint = createHash("sha256").update(JSON.stringify({ scenarioId, point }, (_key, value) =>
        typeof value === "bigint" ? value.toString() : value)).digest("hex");
    return { experiment_id: "e-history", scenario_id: scenarioId, mark_set_id: "c".repeat(64),
        point_valuation_at: "2026-08-31T12:05:01.000Z", benchmark_observation_id: point.observationId,
        scenario_equity_kopecks: point.scenarioEquityKopecks.toString(),
        benchmark_equity_kopecks: point.benchmarkEquityKopecks.toString(),
        scenario_pnl_kopecks: point.scenarioPnlKopecks.toString(), benchmark_pnl_kopecks: point.benchmarkPnlKopecks.toString(),
        scenario_return_bps: point.scenarioReturnBps.toString(), benchmark_return_bps: point.benchmarkReturnBps.toString(),
        excess_pnl_kopecks: point.excessPnlKopecks.toString(), excess_return_bps: point.excessReturnBps.toString(),
        point_payload_fingerprint: payloadFingerprint, source_tick_id: "source-tick-history",
        mark_set_valuation_at: "2026-08-31T12:05:01.000Z", market_data_source: "t-invest-market-data-readonly",
        session_policy_version: "t-invest-session-v1-open-only", benchmark_instrument_uid: "benchmark-uid",
        mark_set_benchmark_observation_id: point.observationId, mark_instrument_uid: "benchmark-uid",
        broker_observed_at: point.brokerObservedAt, mark_kopecks: point.markKopecks.toString(),
        mark_source: "t-invest-market-data-readonly", session_status: "open", mark_payload_fingerprint: "d".repeat(64),
        ...overrides };
};

const completePointRows = () => [pointRow("1.0x"), pointRow("1.2x"), pointRow("1.5x")];


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

    it("returns empty history only when baseline and points are both absent", async () => {
        const fake = new FakeDatabase(); fake.results.push([], []);
        const repository = new SequelizeQualifiedMarketEvidenceReadRepository(sequelize(fake));
        assert.deepEqual(await repository.loadBenchmarkHistory("e-history"), {});
    });

    it("loads exact latest scenario history losslessly with deterministic joined SQL", async () => {
        const fake = new FakeDatabase(); fake.results.push([baselineRow], completePointRows());
        const repository = new SequelizeQualifiedMarketEvidenceReadRepository(sequelize(fake));
        const history = await repository.loadBenchmarkHistory("e-history");
        assert(history.baseline);
        assert.equal(history.baseline.markKopecks, 200n);
        assert.deepEqual(history.lastPoints?.map(item => item.scenarioId), ["1.0x", "1.2x", "1.5x"]);
        assert.equal(history.lastPoints?.[0].point.scenarioEquityKopecks, 900719925474099399n);
        assert.equal(history.lastPoints?.[0].point.excessPnlKopecks, -45035996273704866n);
        assert.match(fake.sql[1], /DISTINCT ON \(p\.scenario_id\)/);
        assert.match(fake.sql[1], /JOIN virtual_market_mark_sets/);
        assert.match(fake.sql[1], /JOIN virtual_market_marks/);
        assert.match(fake.sql[1], /JOIN virtual_observation_experiments e ON e\.experiment_id = s\.experiment_id/);
        assert.match(fake.sql[1], /e\.market_data_source/);
        assert.doesNotMatch(fake.sql[1], /s\.market_data_source/);
        assert.match(fake.sql[1], /ORDER BY p\.scenario_id, p\.valuation_at DESC, p\.mark_set_id DESC/);
        assert.deepEqual(fake.replacements[1], { experimentId: "e-history" });
    });

    it("rejects partial, extra and duplicate benchmark history", async () => {
        const cases: readonly [unknown[], unknown[], RegExp][] = [
            [[], completePointRows(), /requires baseline and all scenario points/],
            [[baselineRow], [], /requires baseline and all scenario points/],
            [[baselineRow], completePointRows().slice(0, 2), /exactly three scenario points/],
            [[baselineRow], [...completePointRows(), pointRow("extra")], /exactly three scenario points/],
            [[baselineRow], [pointRow("1.0x"), pointRow("1.0x"), pointRow("1.5x")], /duplicate scenarios/]
        ];
        for (const [baselines, points, expected] of cases) {
            const fake = new FakeDatabase(); fake.results.push(baselines, points);
            const repository = new SequelizeQualifiedMarketEvidenceReadRepository(sequelize(fake));
            await assert.rejects(repository.loadBenchmarkHistory("e-history"), expected);
        }
    });

    it("rejects malformed point identity, metadata, fingerprint, bigint and chronology", async () => {
        const malformed = [
            { row: pointRow("1.0x", { experiment_id: "other" }), expected: /experiment mismatch/ },
            { row: pointRow("1.0x", { market_data_source: "other" }), expected: /market data source/ },
            { row: pointRow("1.0x", { mark_instrument_uid: "other" }), expected: /instrument metadata mismatch/ },
            { row: pointRow("1.0x", { point_payload_fingerprint: "0".repeat(64) }), expected: /payload fingerprint mismatch/ },
            { row: pointRow("1.0x", { scenario_equity_kopecks: "not-an-integer" }), expected: /must be an integer/ }
        ];
        for (const { row: invalid, expected } of malformed) {
            const fake = new FakeDatabase();
            fake.results.push([baselineRow], [invalid, pointRow("1.2x"), pointRow("1.5x")]);
            const repository = new SequelizeQualifiedMarketEvidenceReadRepository(sequelize(fake));
            await assert.rejects(repository.loadBenchmarkHistory("e-history"), expected);
        }
        const beforeBaseline = "2026-08-31T11:59:59.000Z";
        const fake = new FakeDatabase();
        fake.results.push([baselineRow], [pointRow("1.0x", { broker_observed_at: beforeBaseline }),
            pointRow("1.2x", { broker_observed_at: beforeBaseline }),
            pointRow("1.5x", { broker_observed_at: beforeBaseline })]);
        const repository = new SequelizeQualifiedMarketEvidenceReadRepository(sequelize(fake));
        await assert.rejects(repository.loadBenchmarkHistory("e-history"), /cannot precede baseline/);
    });


    it("rejects independently latest rows that do not form one shared snapshot", async () => {
        const mixedCases = [
            { row: pointRow("1.2x", { mark_set_id: "e".repeat(64) }), expected: /mixed latest snapshot: markSetId/ },
            { row: pointRow("1.2x", { point_valuation_at: "2026-08-31T12:05:02.000Z" }),
                expected: /mixed latest snapshot: valuationAt/ },
            { row: pointRow("1.2x", { benchmark_observation_id: "different-observation",
                mark_set_benchmark_observation_id: "different-observation" }),
                expected: /mixed latest snapshot: benchmarkObservationId/ },
            { row: pointRow("1.2x", { mark_kopecks: "211" }), expected: /mixed latest snapshot: markKopecks/ }
        ];
        for (const { row: mixed, expected } of mixedCases) {
            const fake = new FakeDatabase();
            fake.results.push([baselineRow], [pointRow("1.0x"), mixed, pointRow("1.5x")]);
            const repository = new SequelizeQualifiedMarketEvidenceReadRepository(sequelize(fake));
            await assert.rejects(repository.loadBenchmarkHistory("e-history"), expected);
        }
    });

});
