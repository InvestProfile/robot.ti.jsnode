import { QueryTypes, Sequelize } from 'sequelize';
import { createBrokerMarketMark, type BrokerMarketMark, type MarketSessionStatus } from '../market-observation/types';

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

const timestamp = (value: Date | string) => new Date(value).toISOString();
const positiveBigInt = (value: string, field: string) => { const decoded = BigInt(value); if (decoded <= 0n) throw new Error(field + ' must be positive'); return decoded; };
const fingerprint = (value: string, field: string) => { if (!/^[a-f0-9]{64}$/.test(value)) throw new Error(field + ' must be lowercase sha256'); return value; };
const required = (value: string, field: string) => { if (!value || value.trim() !== value) throw new Error(field + ' is required'); return value; };

export class SequelizeQualifiedMarketEvidenceReadRepository implements QualifiedMarketEvidenceReadPort {
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
