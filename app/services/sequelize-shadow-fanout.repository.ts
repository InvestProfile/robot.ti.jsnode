import { createHash } from 'node:crypto';
import { QueryTypes, Sequelize, Transaction } from 'sequelize';
import type {
    AtomicShadowFanoutCommit,
    AtomicShadowFanoutRepository,
    ShadowScenarioState
} from '../paper/shadow-scenario-fanout';
import {
    FANOUT_SCENARIO_IDS,
    openShadowScenarioStates,
    shadowScenarioStateFingerprint
} from '../paper/shadow-scenario-fanout';
import type { ObservationExperimentConfig } from '../paper/observation-persistence';
import type { ShadowMarketEvidenceResult } from '../paper/shadow-scenario-fanout';
import { marketMarkFingerprint } from '../market-observation/types';
import { marginRiskSnapshot } from '../virtual/margin';

interface StateRow {
    scenario_id: string;
    state_fingerprint: string;
    state_json: string;
}

interface CheckpointRow { source_payload_fingerprint: string }
interface ExperimentVersionRow { config_version: number | null }
interface BaselineRow {
    baseline_mark_set_id: string; observation_id: string; mark_kopecks: string; broker_observed_at: string;
    initial_equity_kopecks: string; methodology: string; return_scope: string; payload_fingerprint: string;
    market_payload_fingerprint: string;
}

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
const evidenceFingerprint = (value: unknown) => sha256(JSON.stringify(value, (_key, item) =>
    typeof item === 'bigint' ? item.toString() : item
));
const exactSet = (left: readonly string[], right: readonly string[]) => {
    const sortedRight = [...right].sort();
    return left.length === right.length && [...left].sort().every((value, index) => value === sortedRight[index]);
};
const assertExactScenarioSet = (scenarioIds: readonly string[], source: string) => {
    if (!exactSet(scenarioIds, FANOUT_SCENARIO_IDS)) {
        throw new Error(`${source} must contain exactly 1.0x, 1.2x and 1.5x`);
    }
};
const isTickScopedMarketReason = (reason: string) =>
    reason === 'MARK_SET_SKEW_EXCEEDED'
    || ['MISSING_REQUIRED_MARK:', 'STALE_MARK:', 'CROSSED_MARK:', 'OUT_OF_SPREAD_MARK:',
        'INVALID_MARK_FINGERPRINT:', 'SESSION_STATUS_NOT_QUALIFIED:'].some(prefix => reason.startsWith(prefix));
const tickScopedReasons = (reasons: readonly string[]) => [...new Set(reasons.filter(isTickScopedMarketReason))].sort();
const validateQualifiedEvidence = (
    input: AtomicShadowFanoutCommit,
    evidence: Extract<ShadowMarketEvidenceResult, { quality: 'qualified' }>
) => {
    const { markSet, benchmark } = evidence;
    if (markSet.sourceTickId !== input.sourceTick.sourceTickId) throw new Error('qualified mark set source tick mismatch');
    if (markSet.valuationAt !== input.sourceTick.completedAt) throw new Error('qualified mark set valuation mismatch');
    if (markSet.provenance.some((item, index) => index > 0
        && markSet.provenance[index - 1].instrumentUid.localeCompare(item.instrumentUid) >= 0)) {
        throw new Error('qualified mark set provenance must be canonically sorted');
    }
    const canonicalMarkSetId = sha256(JSON.stringify({
        sourceTickId: markSet.sourceTickId, valuationAt: markSet.valuationAt, provenance: markSet.provenance
    }));
    if (markSet.markSetId !== canonicalMarkSetId) throw new Error('qualified mark set ID mismatch');
    if (markSet.benchmarkMark.instrumentUid !== evidence.benchmarkInstrumentUid) throw new Error('qualified benchmark instrument mismatch');
    if (marketMarkFingerprint(markSet.benchmarkMark) !== markSet.benchmarkMark.payloadFingerprint) {
        throw new Error('qualified benchmark mark fingerprint mismatch');
    }
    const benchmarkMembers = markSet.provenance.filter(member => member.role === 'benchmark');
    const member = benchmarkMembers[0];
    if (benchmarkMembers.length !== 1 || member.instrumentUid !== evidence.benchmarkInstrumentUid
        || member.observationId !== markSet.benchmarkMark.observationId
        || member.payloadFingerprint !== markSet.benchmarkMark.payloadFingerprint
        || member.brokerObservedAt !== markSet.benchmarkMark.brokerObservedAt) {
        throw new Error('qualified benchmark provenance mismatch');
    }
    if (new Set(markSet.provenance.map(item => item.instrumentUid)).size !== markSet.provenance.length
        || new Set(markSet.provenance.map(item => item.observationId)).size !== markSet.provenance.length) {
        throw new Error('qualified mark set provenance must be unique');
    }
    if (markSet.marks.length !== markSet.provenance.length) throw new Error('qualified marks and provenance size mismatch');
    for (const provenance of markSet.provenance) {
        const matches = markSet.marks.filter(mark => mark.instrumentUid === provenance.instrumentUid);
        const mark = matches[0];
        if (matches.length !== 1 || mark.observationId !== provenance.observationId
            || mark.payloadFingerprint !== provenance.payloadFingerprint
            || mark.brokerObservedAt !== provenance.brokerObservedAt
            || marketMarkFingerprint(mark) !== mark.payloadFingerprint) {
            throw new Error(`qualified mark/provenance mismatch: ${provenance.instrumentUid}`);
        }
    }
    if (benchmark.points.length !== 3
        || !exactSet(benchmark.points.map(item => item.scenarioId), input.next.map(state => state.scenarioId))) {
        throw new Error('qualified benchmark requires the exact three scenario points');
    }
    for (const item of benchmark.points) {
        const next = input.next.find(state => state.scenarioId === item.scenarioId);
        if (!next || item.point.scenarioEquityKopecks !== marginRiskSnapshot(next.margin).equityKopecks) {
            throw new Error(`qualified benchmark scenario equity mismatch: ${item.scenarioId}`);
        }
        if (item.point.observationId !== markSet.benchmarkMark.observationId
            || item.point.brokerObservedAt !== markSet.benchmarkMark.brokerObservedAt
            || item.point.markKopecks !== markSet.benchmarkMark.markKopecks) {
            throw new Error(`qualified benchmark point observation mismatch: ${item.scenarioId}`);
        }
        if (evidenceFingerprint({ scenarioId: item.scenarioId, point: item.point }) !== item.payloadFingerprint) {
            throw new Error(`qualified benchmark point fingerprint mismatch: ${item.scenarioId}`);
        }
    }
};
const validateRejectedEvidence = (
    input: AtomicShadowFanoutCommit,
    evidence: Extract<ShadowMarketEvidenceResult, { quality: 'rejected' }>
) => {
    if (evidence.sourceTickId !== input.sourceTick.sourceTickId) throw new Error('rejected evidence source tick mismatch');
    if (evidence.valuationAt !== input.sourceTick.completedAt) throw new Error('rejected evidence valuation mismatch');
    if (!evidence.reasons.length || evidence.reasons.some(reason => !reason || reason.trim() !== reason)
        || new Set(evidence.reasons).size !== evidence.reasons.length
        || evidence.reasons.some((reason, index) => reason !== [...evidence.reasons].sort()[index])) {
        throw new Error('rejected evidence reasons must be non-empty, unique and sorted');
    }
    assertExactScenarioSet(input.evidenceTick.snapshots.map(snapshot => snapshot.scenarioId), 'rejected evidence snapshots');
    for (const state of input.next) {
        if (!exactSet(tickScopedReasons(state.qualityReasons), evidence.reasons)) {
            throw new Error(`rejected evidence reason set mismatch: ${state.scenarioId}`);
        }
    }
    for (const snapshot of input.evidenceTick.snapshots) {
        if (!exactSet(tickScopedReasons(snapshot.evidenceQualityReasons ?? []), evidence.reasons)) {
            throw new Error(`rejected evidence snapshot reason set mismatch: ${snapshot.scenarioId}`);
        }
    }
};

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
            await this.database.query(`SELECT pg_advisory_xact_lock(hashtextextended(:lockKey, 0))`, {
                replacements: { lockKey: `${input.experimentId}:${input.sourceTick.sourceTickId}` },
                type: QueryTypes.SELECT, transaction
            });
            const versions = await this.database.query<ExperimentVersionRow>(
                `SELECT config_version FROM virtual_observation_experiments
                 WHERE experiment_id = :experimentId`, {
                    replacements: { experimentId: input.experimentId }, type: QueryTypes.SELECT, transaction
                });
            const version = versions[0]?.config_version;
            if (versions.length !== 1) throw new Error('observation experiment config is missing');
            if (version === 2 && input.marketEvidence === undefined) {
                throw new Error('v2 observation experiment requires market evidence');
            }
            if (version === null && input.marketEvidence !== undefined) {
                throw new Error('legacy observation experiment forbids market evidence');
            }
            if (version !== null && version !== 2) throw new Error('unsupported observation experiment config version');
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
            const checkpointsAfterStateLock = await this.database.query<CheckpointRow>(
                `SELECT source_payload_fingerprint FROM virtual_shadow_source_checkpoints
                 WHERE experiment_id = :experimentId AND source_tick_id = :sourceTickId FOR UPDATE`, {
                    replacements: { experimentId: input.experimentId, sourceTickId: input.sourceTick.sourceTickId },
                    type: QueryTypes.SELECT, transaction
                });
            if (checkpointsAfterStateLock[0]) {
                if (checkpointsAfterStateLock[0].source_payload_fingerprint !== input.sourceTick.payloadFingerprint) {
                    throw new Error(`source checkpoint conflict: ${input.sourceTick.sourceTickId}`);
                }
                return 'idempotent';
            }
            assertExactScenarioSet(current.map(row => row.scenario_id), 'persisted fanout scenario set');
            assertExactScenarioSet(input.previous.map(state => state.scenarioId), 'previous fanout scenario set');
            assertExactScenarioSet(input.next.map(state => state.scenarioId), 'next fanout scenario set');
            for (const previous of input.previous) {
                const row = current.find(candidate => candidate.scenario_id === previous.scenarioId);
                if (!row || shadowScenarioStateFingerprint(decode<ShadowScenarioState>(row.state_json))
                    !== shadowScenarioStateFingerprint(previous)) {
                    throw new Error(`stale fanout scenario state: ${previous.scenarioId}`);
                }
            }
            if (input.marketEvidence?.quality === 'qualified') {
                validateQualifiedEvidence(input, input.marketEvidence);
                const evidence = input.marketEvidence;
                const { markSet } = evidence;
                await this.database.query(`INSERT INTO virtual_market_mark_sets
                    (mark_set_id, experiment_id, source_tick_id, valuation_at, benchmark_observation_id,
                     benchmark_instrument_uid, benchmark_role, session_policy_version, maximum_age_ms, maximum_skew_ms)
                    VALUES (:markSetId, :experimentId, :sourceTickId, :valuationAt, :benchmarkObservationId,
                     :benchmarkInstrumentUid, 'benchmark', :sessionPolicyVersion, :maximumAgeMs, :maximumSkewMs)`, {
                    replacements: { markSetId: markSet.markSetId, experimentId: input.experimentId,
                        sourceTickId: markSet.sourceTickId, valuationAt: markSet.valuationAt,
                        benchmarkObservationId: markSet.benchmarkMark.observationId,
                        benchmarkInstrumentUid: evidence.benchmarkInstrumentUid,
                        sessionPolicyVersion: evidence.sessionPolicyVersion,
                        maximumAgeMs: markSet.maximumAgeMs, maximumSkewMs: markSet.maximumSkewMs }, transaction
                });
                for (const item of markSet.provenance) await this.database.query(`INSERT INTO virtual_market_mark_set_members
                    (mark_set_id, observation_id, instrument_uid, member_role, payload_fingerprint, broker_observed_at)
                    VALUES (:markSetId, :observationId, :instrumentUid, :memberRole, :payloadFingerprint, :brokerObservedAt)`, {
                    replacements: { markSetId: markSet.markSetId, observationId: item.observationId,
                        instrumentUid: item.instrumentUid, memberRole: item.role,
                        payloadFingerprint: item.payloadFingerprint, brokerObservedAt: item.brokerObservedAt }, transaction
                });
                const baseline = evidence.benchmark.baseline;
                const currentBenchmarkIsBaseline = markSet.benchmarkMark.observationId === baseline.observationId;
                if (currentBenchmarkIsBaseline && (markSet.benchmarkMark.markKopecks !== baseline.markKopecks
                    || markSet.benchmarkMark.brokerObservedAt !== baseline.brokerObservedAt)) {
                    throw new Error('qualified benchmark baseline market mark mismatch');
                }
                await this.database.query(`INSERT INTO virtual_normalized_benchmark_baselines
                    (experiment_id, baseline_mark_set_id, observation_id, mark_kopecks, broker_observed_at,
                     initial_equity_kopecks, methodology, return_scope, payload_fingerprint)
                    VALUES (:experimentId, :baselineMarkSetId, :observationId, :markKopecks, :brokerObservedAt,
                     :initialEquityKopecks, 'normalized-price-return',
                     'price-only-excludes-dividends-fees-and-total-return', :payloadFingerprint)
                    ON CONFLICT (experiment_id) DO NOTHING`, {
                    replacements: { experimentId: input.experimentId, baselineMarkSetId: markSet.markSetId,
                        observationId: baseline.observationId, markKopecks: baseline.markKopecks,
                        brokerObservedAt: baseline.brokerObservedAt, initialEquityKopecks: evidence.initialEquityKopecks,
                        payloadFingerprint: markSet.benchmarkMark.payloadFingerprint }, transaction
                });
                const baselineRows = await this.database.query<BaselineRow>(`SELECT baseline_mark_set_id,
                    b.observation_id, b.mark_kopecks, b.broker_observed_at, b.initial_equity_kopecks, b.methodology,
                    b.return_scope, b.payload_fingerprint, m.payload_fingerprint AS market_payload_fingerprint
                    FROM virtual_normalized_benchmark_baselines b
                    JOIN virtual_market_marks m ON m.observation_id = b.observation_id
                    WHERE b.experiment_id = :experimentId`, {
                    replacements: { experimentId: input.experimentId }, type: QueryTypes.SELECT, transaction
                });
                const persisted = baselineRows[0];
                if (!persisted || (currentBenchmarkIsBaseline && persisted.baseline_mark_set_id !== markSet.markSetId)
                    || persisted.observation_id !== baseline.observationId
                    || BigInt(persisted.mark_kopecks) !== baseline.markKopecks
                    || new Date(persisted.broker_observed_at).toISOString() !== baseline.brokerObservedAt
                    || BigInt(persisted.initial_equity_kopecks) !== evidence.initialEquityKopecks
                    || persisted.methodology !== 'normalized-price-return'
                    || persisted.return_scope !== 'price-only-excludes-dividends-fees-and-total-return'
                    || persisted.payload_fingerprint !== persisted.market_payload_fingerprint) {
                    throw new Error('immutable benchmark baseline conflict');
                }
                for (const item of evidence.benchmark.points) {
                    const point = item.point;
                    await this.database.query(`INSERT INTO virtual_normalized_benchmark_points
                        (experiment_id, scenario_id, mark_set_id, valuation_at, benchmark_observation_id,
                         scenario_equity_kopecks, benchmark_equity_kopecks, scenario_pnl_kopecks,
                         benchmark_pnl_kopecks, scenario_return_bps, benchmark_return_bps,
                         excess_pnl_kopecks, excess_return_bps, payload_fingerprint)
                        VALUES (:experimentId, :scenarioId, :markSetId, :valuationAt, :benchmarkObservationId,
                         :scenarioEquityKopecks, :benchmarkEquityKopecks, :scenarioPnlKopecks,
                         :benchmarkPnlKopecks, :scenarioReturnBps, :benchmarkReturnBps,
                         :excessPnlKopecks, :excessReturnBps, :payloadFingerprint)`, {
                        replacements: { experimentId: input.experimentId, scenarioId: item.scenarioId,
                            markSetId: markSet.markSetId, valuationAt: markSet.valuationAt,
                            benchmarkObservationId: point.observationId,
                            scenarioEquityKopecks: point.scenarioEquityKopecks,
                            benchmarkEquityKopecks: point.benchmarkEquityKopecks,
                            scenarioPnlKopecks: point.scenarioPnlKopecks,
                            benchmarkPnlKopecks: point.benchmarkPnlKopecks,
                            scenarioReturnBps: point.scenarioReturnBps,
                            benchmarkReturnBps: point.benchmarkReturnBps,
                            excessPnlKopecks: point.excessPnlKopecks,
                            excessReturnBps: point.excessReturnBps,
                            payloadFingerprint: item.payloadFingerprint }, transaction
                    });
                }
            } else if (input.marketEvidence?.quality === 'rejected') {
                validateRejectedEvidence(input, input.marketEvidence);
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
            const evidenceJson = encode(input.marketEvidence
                ? { ...input.evidenceTick, marketEvidence: input.marketEvidence }
                : input.evidenceTick);
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
