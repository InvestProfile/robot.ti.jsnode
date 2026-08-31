import { createHash } from 'node:crypto';
import { QueryTypes, Sequelize } from 'sequelize';
import { createBrokerMarketMark, type BrokerMarketMark, type MarketSessionStatus } from '../market-observation/types';
import type { QualifiedFanoutEvidenceLoader } from '../paper/shadow-scenario-fanout';
import type { PersistedScenarioBenchmarkPoint } from '../paper/qualified-shadow-evidence';
import type { BenchmarkBaseline, BenchmarkPoint } from '../virtual/benchmark';

export interface QualifiedMarketEvidenceReadPort {
    loadAsOf(input: { instrumentUids: readonly string[]; valuationAt: string }): Promise<readonly BrokerMarketMark[]>;
    loadBenchmarkBaseline(experimentId: string): Promise<PersistedBenchmarkBaseline | undefined>;
}

export interface PersistedBenchmarkBaseline {
    readonly experimentId: string;
    readonly baselineMarkSetId: string;
    readonly observationId: string;
    readonly markKopecks: bigint;
    readonly brokerObservedAt: string;
    readonly initialEquityKopecks: bigint;
    readonly methodology: 'normalized-price-return';
    readonly returnScope: 'price-only-excludes-dividends-fees-and-total-return';
    readonly payloadFingerprint: string;
}

interface MarkRow {
    observation_id: string; source_identity: string; instrument_uid: string;
    broker_observed_at: Date | string; received_at: Date | string;
    bid_kopecks: string; ask_kopecks: string; mark_kopecks: string;
    source: 't-invest-market-data-readonly'; session_status: MarketSessionStatus;
    source_sequence: string | null; payload_fingerprint: string;
}

interface BaselineRow {
    experiment_id: string; baseline_mark_set_id: string; observation_id: string;
    mark_kopecks: string; broker_observed_at: Date | string; initial_equity_kopecks: string;
    methodology: 'normalized-price-return';
    return_scope: 'price-only-excludes-dividends-fees-and-total-return'; payload_fingerprint: string;
}

interface BenchmarkPointRow {
    experiment_id: string; scenario_id: string; mark_set_id: string; point_valuation_at: Date | string;
    benchmark_observation_id: string; scenario_equity_kopecks: string; benchmark_equity_kopecks: string;
    scenario_pnl_kopecks: string; benchmark_pnl_kopecks: string; scenario_return_bps: string;
    benchmark_return_bps: string; excess_pnl_kopecks: string; excess_return_bps: string;
    point_payload_fingerprint: string; source_tick_id: string; mark_set_valuation_at: Date | string;
    market_data_source: string; session_policy_version: string; benchmark_instrument_uid: string;
    mark_set_benchmark_observation_id: string; mark_instrument_uid: string;
    broker_observed_at: Date | string; mark_kopecks: string; mark_source: string;
    session_status: MarketSessionStatus; mark_payload_fingerprint: string;
}

const BENCHMARK_SCENARIO_IDS = Object.freeze(["1.0x", "1.2x", "1.5x"] as const);


const timestamp = (value: Date | string) => new Date(value).toISOString();
const integerBigInt = (value: string, field: string) => { try { return BigInt(value); } catch { throw new Error(field + " must be an integer"); } };
const positiveBigInt = (value: string, field: string) => { const decoded = integerBigInt(value, field); if (decoded <= 0n) throw new Error(field + " must be positive"); return decoded; };
const nonNegativeBigInt = (value: string, field: string) => { const decoded = integerBigInt(value, field); if (decoded < 0n) throw new Error(field + " must be non-negative"); return decoded; };
const fingerprint = (value: string, field: string) => { if (!/^[a-f0-9]{64}$/.test(value)) throw new Error(field + ' must be lowercase sha256'); return value; };
const required = (value: string, field: string) => { if (!value || value.trim() !== value) throw new Error(field + ' is required'); return value; };

export class SequelizeQualifiedMarketEvidenceReadRepository implements QualifiedMarketEvidenceReadPort, QualifiedFanoutEvidenceLoader {
    constructor(private readonly database: Sequelize) {}

    async loadAsOf(input: { instrumentUids: readonly string[]; valuationAt: string }): Promise<readonly BrokerMarketMark[]> {
        const instrumentUids = [...new Set(input.instrumentUids.map(value => value.trim()))].sort();
        if (!instrumentUids.length || instrumentUids.some(value => !value)) throw new Error('instrumentUids must be non-empty');
        const valuationAt = timestamp(input.valuationAt);
        const rows = await this.database.query<MarkRow>(
            "SELECT DISTINCT ON (instrument_uid) observation_id, source_identity, instrument_uid, broker_observed_at, received_at, bid_kopecks::text, ask_kopecks::text, mark_kopecks::text, source, session_status, source_sequence, payload_fingerprint FROM virtual_market_marks WHERE instrument_uid IN (:instrumentUids) AND broker_observed_at <= :valuationAt ORDER BY instrument_uid, broker_observed_at DESC, observation_id DESC",
            { replacements: { instrumentUids, valuationAt }, type: QueryTypes.SELECT }
        );
        return Object.freeze(rows.map(row => {
            const decoded = createBrokerMarketMark({
                observationId: row.observation_id, sourceIdentity: row.source_identity, instrumentUid: row.instrument_uid,
                brokerObservedAt: timestamp(row.broker_observed_at), receivedAt: timestamp(row.received_at),
                bidKopecks: BigInt(row.bid_kopecks), askKopecks: BigInt(row.ask_kopecks), markKopecks: BigInt(row.mark_kopecks),
                source: row.source, sessionStatus: row.session_status,
                ...(row.source_sequence ? { sourceSequence: row.source_sequence } : {})
            });
            if (decoded.payloadFingerprint !== row.payload_fingerprint) {
                throw new Error('persisted market mark fingerprint mismatch: ' + row.observation_id);
            }
            return decoded;
        }));
    }

    async loadBenchmarkHistory(experimentId: string): Promise<
        Readonly<{ baseline?: undefined; lastPoints?: undefined }>
        | Readonly<{ baseline: BenchmarkBaseline; lastPoints: readonly PersistedScenarioBenchmarkPoint[] }>
    > {
        const normalizedId = experimentId.trim();
        if (!normalizedId) throw new Error("experimentId is required");
        const persistedBaseline = await this.loadBenchmarkBaseline(normalizedId);
        const rows = await this.database.query<BenchmarkPointRow>(
            "SELECT DISTINCT ON (p.scenario_id) p.experiment_id, p.scenario_id, p.mark_set_id, p.valuation_at AS point_valuation_at, p.benchmark_observation_id, p.scenario_equity_kopecks::text, p.benchmark_equity_kopecks::text, p.scenario_pnl_kopecks::text, p.benchmark_pnl_kopecks::text, p.scenario_return_bps::text, p.benchmark_return_bps::text, p.excess_pnl_kopecks::text, p.excess_return_bps::text, p.payload_fingerprint AS point_payload_fingerprint, s.source_tick_id, s.valuation_at AS mark_set_valuation_at, e.market_data_source, s.session_policy_version, s.benchmark_instrument_uid, s.benchmark_observation_id AS mark_set_benchmark_observation_id, m.instrument_uid AS mark_instrument_uid, m.broker_observed_at, m.mark_kopecks::text, m.source AS mark_source, m.session_status, m.payload_fingerprint AS mark_payload_fingerprint FROM virtual_normalized_benchmark_points p JOIN virtual_market_mark_sets s ON s.mark_set_id = p.mark_set_id AND s.experiment_id = p.experiment_id AND s.benchmark_observation_id = p.benchmark_observation_id JOIN virtual_market_marks m ON m.observation_id = p.benchmark_observation_id AND m.instrument_uid = s.benchmark_instrument_uid JOIN virtual_observation_experiments e ON e.experiment_id = s.experiment_id WHERE p.experiment_id = :experimentId ORDER BY p.scenario_id, p.valuation_at DESC, p.mark_set_id DESC",
            { replacements: { experimentId: normalizedId }, type: QueryTypes.SELECT }
        );
        if (!persistedBaseline && rows.length === 0) return Object.freeze({});
        if (!persistedBaseline || rows.length === 0) throw new Error("benchmark history requires baseline and all scenario points");
        if (persistedBaseline.experimentId !== normalizedId) throw new Error("benchmark baseline experiment mismatch");
        if (rows.length !== BENCHMARK_SCENARIO_IDS.length) throw new Error("benchmark history requires exactly three scenario points");
        const scenarios = rows.map(row => required(row.scenario_id, "scenarioId"));
        if (new Set(scenarios).size !== scenarios.length) throw new Error("benchmark history contains duplicate scenarios");
        if ([...scenarios].sort().join("|") !== [...BENCHMARK_SCENARIO_IDS].sort().join("|")) {
            throw new Error("benchmark history scenario set mismatch");
        }
        const shared = rows[0];
        const sharedMarkSetId = fingerprint(shared.mark_set_id, "markSetId");
        const sharedValuationAt = timestamp(shared.point_valuation_at);
        const sharedObservationId = required(shared.benchmark_observation_id, "benchmarkObservationId");
        const sharedBrokerObservedAt = timestamp(shared.broker_observed_at);
        const sharedMarkKopecks = positiveBigInt(shared.mark_kopecks, "point markKopecks");
        const sharedMarkPayloadFingerprint = fingerprint(shared.mark_payload_fingerprint, "mark payloadFingerprint");
        const sharedBenchmarkInstrumentUid = required(shared.benchmark_instrument_uid, "benchmarkInstrumentUid");
        for (const row of rows.slice(1)) {
            if (fingerprint(row.mark_set_id, "markSetId") !== sharedMarkSetId) {
                throw new Error("benchmark history mixed latest snapshot: markSetId");
            }
            if (timestamp(row.point_valuation_at) !== sharedValuationAt) {
                throw new Error("benchmark history mixed latest snapshot: valuationAt");
            }
            if (required(row.benchmark_observation_id, "benchmarkObservationId") !== sharedObservationId) {
                throw new Error("benchmark history mixed latest snapshot: benchmarkObservationId");
            }
            if (timestamp(row.broker_observed_at) !== sharedBrokerObservedAt) {
                throw new Error("benchmark history mixed latest snapshot: brokerObservedAt");
            }
            if (positiveBigInt(row.mark_kopecks, "point markKopecks") !== sharedMarkKopecks) {
                throw new Error("benchmark history mixed latest snapshot: markKopecks");
            }
            if (fingerprint(row.mark_payload_fingerprint, "mark payloadFingerprint") !== sharedMarkPayloadFingerprint) {
                throw new Error("benchmark history mixed latest snapshot: mark payloadFingerprint");
            }
            if (required(row.benchmark_instrument_uid, "benchmarkInstrumentUid") !== sharedBenchmarkInstrumentUid) {
                throw new Error("benchmark history mixed latest snapshot: benchmarkInstrumentUid");
            }
        }
        const baseline: BenchmarkBaseline = Object.freeze({
            observationId: persistedBaseline.observationId,
            brokerObservedAt: persistedBaseline.brokerObservedAt,
            markKopecks: persistedBaseline.markKopecks
        });
        const baselineTime = Date.parse(baseline.brokerObservedAt);
        const lastPoints = Object.freeze(rows.map(row => {
            if (required(row.experiment_id, "point experimentId") !== normalizedId) throw new Error("benchmark point experiment mismatch");
            const scenarioId = required(row.scenario_id, "scenarioId");
            fingerprint(row.mark_set_id, "markSetId");
            fingerprint(row.point_payload_fingerprint, "point payloadFingerprint");
            fingerprint(row.mark_payload_fingerprint, "mark payloadFingerprint");
            required(row.source_tick_id, "sourceTickId");
            const valuationAt = timestamp(row.point_valuation_at);
            if (timestamp(row.mark_set_valuation_at) !== valuationAt) throw new Error("benchmark point valuation metadata mismatch");
            if (row.market_data_source !== "t-invest-market-data-readonly") throw new Error("unsupported benchmark market data source");
            if (row.session_policy_version !== "t-invest-session-v1-open-only") throw new Error("unsupported benchmark session policy");
            const benchmarkInstrumentUid = required(row.benchmark_instrument_uid, "benchmarkInstrumentUid");
            const observationId = required(row.benchmark_observation_id, "benchmarkObservationId");
            if (required(row.mark_set_benchmark_observation_id, "mark-set benchmarkObservationId") !== observationId) {
                throw new Error("benchmark observation metadata mismatch");
            }
            if (required(row.mark_instrument_uid, "mark instrumentUid") !== benchmarkInstrumentUid) {
                throw new Error("benchmark instrument metadata mismatch");
            }
            if (row.mark_source !== "t-invest-market-data-readonly" || row.session_status !== "open") {
                throw new Error("benchmark mark metadata is not qualified");
            }
            const brokerObservedAt = timestamp(row.broker_observed_at);
            if (Date.parse(brokerObservedAt) < baselineTime) throw new Error("benchmark point cannot precede baseline");
            if (Date.parse(brokerObservedAt) > Date.parse(valuationAt)) throw new Error("benchmark point mark cannot look ahead");
            const point: BenchmarkPoint = Object.freeze({
                observationId,
                brokerObservedAt,
                markKopecks: positiveBigInt(row.mark_kopecks, "point markKopecks"),
                scenarioEquityKopecks: nonNegativeBigInt(row.scenario_equity_kopecks, "scenarioEquityKopecks"),
                benchmarkEquityKopecks: nonNegativeBigInt(row.benchmark_equity_kopecks, "benchmarkEquityKopecks"),
                benchmarkPnlKopecks: integerBigInt(row.benchmark_pnl_kopecks, "benchmarkPnlKopecks"),
                scenarioPnlKopecks: integerBigInt(row.scenario_pnl_kopecks, "scenarioPnlKopecks"),
                scenarioReturnBps: integerBigInt(row.scenario_return_bps, "scenarioReturnBps"),
                benchmarkReturnBps: integerBigInt(row.benchmark_return_bps, "benchmarkReturnBps"),
                excessPnlKopecks: integerBigInt(row.excess_pnl_kopecks, "excessPnlKopecks"),
                excessReturnBps: integerBigInt(row.excess_return_bps, "excessReturnBps")
            });
            const calculated = createHash("sha256").update(JSON.stringify({ scenarioId, point }, (_key, value) =>
                typeof value === "bigint" ? value.toString() : value)).digest("hex");
            if (calculated !== row.point_payload_fingerprint) throw new Error("benchmark point payload fingerprint mismatch: " + scenarioId);
            return Object.freeze({ scenarioId, point });
        }));
        return Object.freeze({ baseline, lastPoints });
    }


    async loadBenchmarkBaseline(experimentId: string): Promise<PersistedBenchmarkBaseline | undefined> {
        const normalizedId = experimentId.trim();
        if (!normalizedId) throw new Error('experimentId is required');
        const rows = await this.database.query<BaselineRow>(
            "SELECT experiment_id, baseline_mark_set_id, observation_id, mark_kopecks::text, broker_observed_at, initial_equity_kopecks::text, methodology, return_scope, payload_fingerprint FROM virtual_normalized_benchmark_baselines WHERE experiment_id = :experimentId",
            { replacements: { experimentId: normalizedId }, type: QueryTypes.SELECT }
        );
        const row = rows[0];
        if (!row) return undefined;
        if (row.methodology !== 'normalized-price-return') throw new Error('unsupported benchmark methodology');
        if (row.return_scope !== 'price-only-excludes-dividends-fees-and-total-return') throw new Error('unsupported benchmark return scope');
        return Object.freeze({
            experimentId: required(row.experiment_id, 'experimentId'), baselineMarkSetId: required(row.baseline_mark_set_id, 'baselineMarkSetId'), observationId: required(row.observation_id, 'observationId'),
            markKopecks: positiveBigInt(row.mark_kopecks, 'markKopecks'), brokerObservedAt: timestamp(row.broker_observed_at),
            initialEquityKopecks: positiveBigInt(row.initial_equity_kopecks, 'initialEquityKopecks'), methodology: row.methodology,
            returnScope: row.return_scope, payloadFingerprint: fingerprint(row.payload_fingerprint, 'payloadFingerprint')
        });
    }
}
