import { VirtualAccountModel } from '../models/virtual-account.model';
import { VirtualFillModel } from '../models/virtual-fill.model';
import { VirtualOrderModel } from '../models/virtual-order.model';
import { VirtualLedgerEventModel } from '../models/virtual-ledger-event.model';
import { ShadowDecisionObservationModel } from '../models/shadow-decision-observation.model';
import { decodeVirtualLedgerEvent } from '../virtual/codecs';
import { replayVirtualLedger } from '../virtual/ledger';
import { virtualLedgerRowToStoredEvent } from './sequelize-virtual-ledger.repository';
import { replayVirtualPositions } from '../virtual/position-repository';
import { markVirtualPosition } from '../virtual/positions';
import { virtualFillRowToDomain } from './sequelize-virtual-position.repository';
import { VirtualReconciliationService } from './virtual-reconciliation.service';
import sequelize from '../config/database';
import { QueryTypes } from 'sequelize';
import { evaluateObservationGate, ObservationRunnerState, ObservationTick, replayObservationTicks } from '../virtual/observation-runner';
import { MarginScenarioState, marginRiskSnapshot } from '../virtual/margin';

export const PAPER_LAB_DEFAULT_LIMIT = 50;
export const PAPER_LAB_MAX_LIMIT = 200;
export const PAPER_LAB_CACHE_TTL_MS = 15_000;
const PAPER_LAB_MAX_RECONCILIATION_FILLS = 10_000;
const PAPER_LAB_MAX_EQUITY_POINTS = 200;
const PAPER_LAB_WORKER_STALE_MS = 45 * 60_000;

interface ObservationAccountRow { experiment_id: string; scenario_id: string; virtual_account_id: string }
interface ObservationRows {
    experiment?: { experiment_id: string; config_fingerprint: string; config_json: string; created_at: Date | string; updated_at: Date | string };
    lease?: { owner_id: string; expires_at: Date | string; updated_at: Date | string };
    states: readonly { scenario_id: string; virtual_account_id: string; state_version: string | number; state_json: string; last_source_tick_id?: string; updated_at: Date | string }[];
    ticks: readonly { observed_at: string; payload_json: string; updated_at: Date | string }[];
    checkpoint?: { completed_at: Date | string };
    source: readonly { status: string; count: string; latest_at?: Date | string }[];
}

export interface PaperLabCursor {
    readonly virtualAccountId: string;
    readonly offset: number;
}

export const encodePaperLabCursor = (cursor: PaperLabCursor) =>
    Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');

export const decodePaperLabCursor = (
    value: string | null,
    virtualAccountId: string
): PaperLabCursor | undefined => {
    if (!value) return undefined;
    try {
        const cursor = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as PaperLabCursor;
        if (cursor.virtualAccountId !== virtualAccountId) throw new Error('cursor account mismatch');
        if (!Number.isSafeInteger(cursor.offset) || cursor.offset < 0 || cursor.offset > 10_000) {
            throw new Error('invalid cursor offset');
        }
        return Object.freeze(cursor);
    } catch (error) {
        if (error instanceof Error && error.message === 'cursor account mismatch') throw error;
        throw new Error('invalid paper lab cursor');
    }
};

export const parsePaperLabLimit = (value: string | null): number => {
    if (value === null) return PAPER_LAB_DEFAULT_LIMIT;
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error('limit must be a positive integer');
    return Math.min(parsed, PAPER_LAB_MAX_LIMIT);
};

export const serializePaperKopecks = (value: bigint) => value.toString();

export interface PaperLabReadModelStore {
    listAccounts(limit: number): Promise<readonly VirtualAccountModel[]>;
    findAccount(virtualAccountId: string): Promise<VirtualAccountModel | null>;
    listOrders(virtualAccountId: string, limit: number, offset: number): Promise<readonly VirtualOrderModel[]>;
    listFills(virtualAccountId: string, limit: number, offset: number): Promise<readonly VirtualFillModel[]>;
    listReconciliationFills(virtualAccountId: string, limit: number): Promise<readonly VirtualFillModel[]>;
    listReconciliationLedger(virtualAccountId: string, limit: number): Promise<readonly VirtualLedgerEventModel[]>;
    listDecisions(virtualAccountId: string, limit: number, offset: number): Promise<readonly ShadowDecisionObservationModel[]>;
    listObservationAccounts(limit: number): Promise<readonly ObservationAccountRow[]>;
    loadObservationRows(virtualAccountId: string, limit: number): Promise<ObservationRows | undefined>;
}

export class SequelizePaperLabReadModelStore implements PaperLabReadModelStore {
    async listAccounts(limit: number) {
        return VirtualAccountModel.findAll({ order: [['id', 'DESC']], limit });
    }
    async findAccount(virtualAccountId: string) {
        return VirtualAccountModel.findOne({ where: { virtualAccountId } });
    }
    async listOrders(virtualAccountId: string, limit: number, offset: number) {
        return VirtualOrderModel.findAll({ where: { virtualAccountId }, order: [['sequence', 'DESC']], limit, offset });
    }
    async listFills(virtualAccountId: string, limit: number, offset: number) {
        return VirtualFillModel.findAll({ where: { virtualAccountId }, order: [['sequence', 'DESC']], limit, offset });
    }
    async listReconciliationFills(virtualAccountId: string, limit: number) {
        return VirtualFillModel.findAll({ where: { virtualAccountId }, order: [['sequence', 'ASC']], limit });
    }
    async listReconciliationLedger(virtualAccountId: string, limit: number) {
        return VirtualLedgerEventModel.findAll({ where: { virtualAccountId }, order: [['sequence', 'ASC']], limit });
    }

    async listDecisions(virtualAccountId: string, limit: number, offset: number) {
        return ShadowDecisionObservationModel.findAll({ where: { virtualAccountId }, order: [['sequence', 'DESC']], limit, offset });
    }
    async listObservationAccounts(limit: number) {
        return sequelize.query<ObservationAccountRow>(`SELECT experiment_id, scenario_id, virtual_account_id
            FROM virtual_shadow_scenario_states ORDER BY experiment_id DESC, scenario_id LIMIT :limit`,
        { replacements: { limit: Math.min(limit, 50) }, type: QueryTypes.SELECT });
    }
    async loadObservationRows(virtualAccountId: string, limit: number): Promise<ObservationRows | undefined> {
        const matches = await sequelize.query<ObservationAccountRow>(`SELECT experiment_id, scenario_id, virtual_account_id
            FROM virtual_shadow_scenario_states WHERE virtual_account_id = :virtualAccountId LIMIT 1`,
        { replacements: { virtualAccountId }, type: QueryTypes.SELECT });
        const match = matches[0];
        if (!match) return undefined;
        const experimentId = match.experiment_id;
        const [experiments, leases, states, ticks, checkpoints, source] = await Promise.all([
            sequelize.query<ObservationRows['experiment'] & object>(`SELECT experiment_id, config_fingerprint, config_json, created_at, updated_at
                FROM virtual_observation_experiments WHERE experiment_id = :experimentId LIMIT 1`,
            { replacements: { experimentId }, type: QueryTypes.SELECT }),
            sequelize.query<ObservationRows['lease'] & object>(`SELECT owner_id, expires_at, updated_at FROM virtual_observation_leases
                WHERE lease_name = :experimentId LIMIT 1`, { replacements: { experimentId }, type: QueryTypes.SELECT }),
            sequelize.query<ObservationRows['states'][number]>(`SELECT scenario_id, virtual_account_id, state_version,
                state_json, last_source_tick_id, updated_at FROM virtual_shadow_scenario_states
                WHERE experiment_id = :experimentId ORDER BY scenario_id LIMIT 3`,
            { replacements: { experimentId }, type: QueryTypes.SELECT }),
            sequelize.query<ObservationRows['ticks'][number]>(`SELECT observed_at, payload_json, updated_at FROM virtual_observation_ticks
                WHERE experiment_id = :experimentId ORDER BY sequence DESC LIMIT :limit`,
            { replacements: { experimentId, limit: Math.min(limit, PAPER_LAB_MAX_EQUITY_POINTS) }, type: QueryTypes.SELECT }),
            sequelize.query<ObservationRows['checkpoint'] & object>(`SELECT completed_at FROM virtual_shadow_source_checkpoints
                WHERE experiment_id = :experimentId ORDER BY completed_at DESC LIMIT 1`,
            { replacements: { experimentId }, type: QueryTypes.SELECT }),
            sequelize.query<ObservationRows['source'][number]>(`SELECT
                CASE WHEN status = 'complete' AND processed_at IS NULL THEN 'backlog'
                     WHEN status = 'complete' THEN 'processed' ELSE status END AS status,
                COUNT(*)::text AS count, MAX(COALESCE(completed_at, updated_at)) AS latest_at
                FROM shadow_source_ticks GROUP BY 1`,
            { type: QueryTypes.SELECT })
        ]);
        return { experiment: experiments[0], lease: leases[0], states, ticks: [...ticks].reverse(), checkpoint: checkpoints[0], source };
    }
}

export interface PaperLabReconciliationDto {
    readonly status: 'ok' | 'degraded' | 'error';
    readonly reason?: string;
    readonly metrics?: Record<string, string | number>;
}

const decodeTaggedBigints = <T>(json: string): T => JSON.parse(json, (_key, value) => {
    if (value && typeof value === 'object' && Object.keys(value).length === 1
        && typeof value.$bigint === 'string' && /^-?(0|[1-9]\d*)$/.test(value.$bigint)) return BigInt(value.$bigint);
    return value;
}) as T;
const iso = (value: Date | string | undefined) => value ? new Date(value).toISOString() : undefined;
const serializeDeep = (value: unknown): unknown => {
    if (typeof value === 'bigint') return value.toString();
    if (Array.isArray(value)) return value.map(serializeDeep);
    if (value && typeof value === 'object') return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, serializeDeep(item)]));
    return value;
};

const buildObservationMonitoring = (rows: ObservationRows, now: Date) => {
    if (!rows.experiment) return { state: 'DEGRADED', reasons: ['EXPERIMENT_CONFIG_MISSING'] };
    const config = JSON.parse(rows.experiment.config_json) as Record<string, unknown>;
    const ticks = rows.ticks.map(row => decodeTaggedBigints<ObservationTick>(row.payload_json));
    let evidence: ObservationRunnerState | undefined;
    let replayError: string | undefined;
    try { evidence = replayObservationTicks(rows.experiment.experiment_id, ticks); }
    catch (error) { replayError = error instanceof Error ? error.message : String(error); }
    const gates = evidence?.scenarios.map(item => evaluateObservationGate(item)) ?? [];
    const states = rows.states.map(row => {
        const state = decodeTaggedBigints<{ margin: MarginScenarioState; closedVirtualTrades: number;
            invariantViolationCount: number; marginBreachCount: number; rejectedExecutionCount: number; qualityReasons: string[] }>(row.state_json);
        const risk = marginRiskSnapshot(state.margin);
        return serializeDeep({ scenarioId: row.scenario_id, virtualAccountId: row.virtual_account_id,
            stateVersion: String(row.state_version), lastSourceTickId: row.last_source_tick_id, updatedAt: iso(row.updated_at),
            closedVirtualTrades: state.closedVirtualTrades, invariantViolationCount: state.invariantViolationCount,
            marginBreachCount: state.marginBreachCount, rejectedExecutionCount: state.rejectedExecutionCount,
            qualityReasons: state.qualityReasons, leverage: state.margin.policy.leverage,
            costs: { debtKopecks: state.margin.debtKopecks, accruedInterestKopecks: state.margin.accruedInterestKopecks,
                realizedPnlKopecks: state.margin.realizedPnlKopecks },
            margin: risk });
    });
    const latestActivityAt = [iso(rows.lease?.updated_at), iso(rows.checkpoint?.completed_at),
        ...rows.ticks.map(row => iso(row.updated_at)), ...rows.states.map(row => iso(row.updated_at))]
        .filter((value): value is string => Boolean(value)).sort().at(-1);
    const ageMs = latestActivityAt ? Math.max(0, now.getTime() - Date.parse(latestActivityAt)) : undefined;
    const workerState = !latestActivityAt ? 'missing' : ageMs !== undefined && ageMs > PAPER_LAB_WORKER_STALE_MS ? 'stale' : 'fresh';
    const sourceCounts = Object.fromEntries(rows.source.map(row => [row.status, Number(row.count)]));
    const expected = ['1.0x', '1.2x', '1.5x'];
    const present = rows.states.map(row => row.scenario_id).sort();
    const parity = expected.every(item => present.includes(item)) && present.length === 3;
    const quality = [...new Set([
        ...(replayError ? ['EVIDENCE_REPLAY_FAILED'] : []),
        ...(workerState === 'missing' ? ['WORKER_HEARTBEAT_MISSING'] : workerState === 'stale' ? ['WORKER_HEARTBEAT_STALE'] : []),
        ...(!parity ? ['THREE_SCENARIO_PARITY_FAILED'] : []),
        ...states.flatMap(item => (item as { qualityReasons?: string[] }).qualityReasons ?? []),
        ...gates.flatMap(gate => gate.reasons)
    ])].sort();
    const curve = ticks.flatMap(tick => tick.snapshots.map(snapshot => ({ observedAt: tick.observedAt,
        scenarioId: snapshot.scenarioId, virtualAccountId: snapshot.virtualAccountId,
        equityKopecks: serializePaperKopecks(snapshot.equityKopecks) })));
    const benchmarkId = typeof config.benchmarkId === 'string' ? config.benchmarkId : null;
    const benchmarkAvailable = evidence?.scenarios.length
        ? evidence.scenarios.every(item => item.benchmarkAvailable) : false;
    const qualified = gates.length === 3 && gates.every(gate => gate.qualified) && workerState === 'fresh' && parity
        && quality.length === 0 && benchmarkAvailable;
    const scenarioDtos = states.map(item => {
        const value = item as { scenarioId: string; virtualAccountId: string };
        const observed = evidence?.scenarios.find(candidate => candidate.scenarioId === value.scenarioId);
        const gate = gates.find(candidate => candidate.scenarioId === value.scenarioId);
        return { ...value, ...(item as object),
            drawdown: observed ? { maximumDrawdownKopecks: serializePaperKopecks(observed.maximumDrawdownKopecks),
                maximumDrawdownBps: observed.maximumDrawdownBps, peakEquityKopecks: serializePaperKopecks(observed.peakEquityKopecks) } : undefined,
            gate: gate ? { qualified: gate.qualified, calendarDays: gate.calendarDays, reasons: gate.reasons } : undefined };
    });
    return {
        state: qualified ? 'QUALIFIED' : quality.length > 0 ? 'INSUFFICIENT-EVIDENCE' : 'DEGRADED',
        reasons: quality.length > 0 ? quality : ['EVIDENCE_MISSING'],
        experiment: { experimentId: rows.experiment.experiment_id, configFingerprint: rows.experiment.config_fingerprint,
            immutableConfig: config, createdAt: iso(rows.experiment.created_at), updatedAt: iso(rows.experiment.updated_at) },
        worker: { state: workerState, latestActivityAt, ageMs, leaseExpiresAt: iso(rows.lease?.expires_at),
            leaseActive: rows.lease ? Date.parse(String(rows.lease.expires_at)) > now.getTime() : false,
            latestCheckpointAt: iso(rows.checkpoint?.completed_at) },
        source: { backlog: sourceCounts.backlog ?? 0, processed: sourceCounts.processed ?? 0,
            collecting: sourceCounts.collecting ?? 0,
            failures: sourceCounts.failed ?? 0,
            latestSuccessAt: [rows.source.find(row => row.status === 'backlog')?.latest_at,
                rows.source.find(row => row.status === 'processed')?.latest_at]
                .map(iso).filter((value): value is string => Boolean(value)).sort().at(-1),
            latestFailureAt: iso(rows.source.find(row => row.status === 'failed')?.latest_at) },
        parity: { expected, present, complete: parity }, scenarios: scenarioDtos,
        equityCurve: curve, gates: gates.map(gate => ({ ...gate, state: gate.qualified ? 'qualified' : 'insufficient' })),
        alerts: quality.map(reason => ({ severity: 'warning', reason })),
        benchmark: { benchmarkId, available: benchmarkAvailable,
            state: benchmarkAvailable ? 'available' : benchmarkId ? 'configured-unavailable' : 'not-configured' },
        approximation: { state: quality.some(reason => reason.includes('APPROXIMATE') || reason === 'COLLAPSED_SPREAD')
            ? 'approximate' : 'unknown' }, replayError
    };
};

export interface PaperLabPayload {
    readonly generatedAt: string;
    readonly cache: { readonly ttlMs: number; readonly state: 'fresh' };
    readonly bounds: { readonly requestedLimit: number; readonly maxLimit: number; readonly offset: number };
    readonly accounts: readonly unknown[];
    readonly experiment?: unknown;
    readonly reconciliation?: PaperLabReconciliationDto;
    readonly positions: readonly unknown[];
    readonly orders: readonly unknown[];
    readonly fills: readonly unknown[];
    readonly decisions: readonly unknown[];
    readonly nextCursor?: string;
    readonly freshness?: { readonly latestEventAt?: string; readonly ageMs?: number; readonly state: 'fresh' | 'stale' };
    readonly evidence: { readonly equityCurve: 'unavailable'; readonly benchmark: 'unavailable'; readonly reason: string };
    readonly observation?: unknown;
}

interface CacheEntry { readonly createdAt: number; readonly payload: PaperLabPayload }

export class PaperLabReadModelService {
    readonly #cache = new Map<string, CacheEntry>();
    readonly #inFlight = new Map<string, Promise<PaperLabPayload>>();

    constructor(
        private readonly store: PaperLabReadModelStore = new SequelizePaperLabReadModelStore(),
        private readonly now: () => Date = () => new Date(),
        private readonly cacheTtlMs = PAPER_LAB_CACHE_TTL_MS
    ) {}

    async load(virtualAccountId: string | undefined, limit: number, cursor?: PaperLabCursor): Promise<PaperLabPayload> {
        const canonicalId = virtualAccountId?.trim();
        if (cursor && cursor.virtualAccountId !== canonicalId) throw new Error('cursor account mismatch');
        const boundedLimit = Math.min(Math.max(limit, 1), PAPER_LAB_MAX_LIMIT);
        const offset = cursor?.offset ?? 0;
        const key = `${canonicalId ?? ''}:${boundedLimit}:${offset}`;
        const timestamp = this.now();
        const cached = this.#cache.get(key);
        if (cached && timestamp.getTime() - cached.createdAt < this.cacheTtlMs) return cached.payload;
        const existing = this.#inFlight.get(key);
        if (existing) return existing;
        const loading = this.#load(canonicalId, boundedLimit, offset, timestamp).then(payload => {
            this.#cache.set(key, { createdAt: timestamp.getTime(), payload });
            return payload;
        });
        this.#inFlight.set(key, loading);
        try { return await loading; } finally { this.#inFlight.delete(key); }
    }

    async #load(canonicalId: string | undefined, limit: number, offset: number, timestamp: Date): Promise<PaperLabPayload> {
        const accounts = canonicalId ? [] : await this.store.listAccounts(Math.min(limit, 50));
        let observationAccounts: readonly ObservationAccountRow[] = [];
        try { observationAccounts = canonicalId ? [] : await this.store.listObservationAccounts(Math.min(limit, 50)); }
        catch { observationAccounts = []; }
        const observationAccountDtos = observationAccounts.map(row => ({ virtualAccountId: row.virtual_account_id,
            name: `${row.experiment_id} · ${row.scenario_id}`, status: 'observation', openedAt: undefined }));
        const base = {
            generatedAt: timestamp.toISOString(),
            cache: { ttlMs: this.cacheTtlMs, state: 'fresh' as const },
            bounds: { requestedLimit: limit, maxLimit: PAPER_LAB_MAX_LIMIT, offset },
            accounts: [...accounts.map(account => ({
                virtualAccountId: account.virtualAccountId, name: account.name,
                status: account.status, openedAt: account.openedAt
            })), ...observationAccountDtos],
            evidence: {
                equityCurve: 'unavailable' as const,
                benchmark: 'unavailable' as const,
                reason: 'A reproducible time-series evidence layer is not implemented yet.'
            }
        };
        if (!canonicalId) return Object.freeze({
            ...base, positions: Object.freeze([]), orders: Object.freeze([]),
            fills: Object.freeze([]), decisions: Object.freeze([])
        });

        let observationRows: ObservationRows | undefined;
        let observationError: string | undefined;
        try { observationRows = await this.store.loadObservationRows(canonicalId, PAPER_LAB_MAX_EQUITY_POINTS); }
        catch (error) { observationError = error instanceof Error ? error.message : String(error); }
        const account = await this.store.findAccount(canonicalId);
        if (!account && !observationRows) throw new Error(`virtual account not found: ${canonicalId}`);
        const accountDto = account ? { virtualAccountId: account.virtualAccountId, name: account.name,
            status: account.status, openedAt: account.openedAt } : {
            virtualAccountId: canonicalId, name: canonicalId, status: 'observation', openedAt: undefined
        };
        if (!account) return Object.freeze({
            ...base, accounts: [accountDto], experiment: { ...accountDto, markSource: 'scenario-state' },
            observation: observationRows ? buildObservationMonitoring(observationRows, timestamp) : {
                state: 'DEGRADED', reasons: ['OBSERVATION_DATA_MISSING']
            },
            reconciliation: { status: 'degraded' as const, reason: 'Scenario monitoring uses atomic observation state, not legacy virtual ledger rows.' },
            positions: Object.freeze([]), orders: Object.freeze([]), fills: Object.freeze([]), decisions: Object.freeze([])
        });
        const [orders, visibleFills, reconciliationRows, ledgerRows, decisions] = account ? await Promise.all([
            this.store.listOrders(canonicalId, limit, offset),
            this.store.listFills(canonicalId, limit, offset),
            this.store.listReconciliationFills(canonicalId, PAPER_LAB_MAX_RECONCILIATION_FILLS + 1),
            this.store.listReconciliationLedger(canonicalId, PAPER_LAB_MAX_RECONCILIATION_FILLS + 1),
            this.store.listDecisions(canonicalId, limit, offset)
        ]) : [[], [], [], [], []] as const;
        const reconciliationBoundExceeded = reconciliationRows.length > PAPER_LAB_MAX_RECONCILIATION_FILLS
            || ledgerRows.length > PAPER_LAB_MAX_RECONCILIATION_FILLS;
        const allFills = reconciliationRows.slice(0, PAPER_LAB_MAX_RECONCILIATION_FILLS).map(virtualFillRowToDomain);
        const ledger = replayVirtualLedger(ledgerRows.map(row => decodeVirtualLedgerEvent(virtualLedgerRowToStoredEvent(row))));
        const portfolio = replayVirtualPositions(canonicalId, allFills);
        const latestMarks = new Map<string, bigint>();
        for (const fill of allFills) latestMarks.set(fill.instrumentId, fill.executionPriceKopecks);
        const positions = portfolio.positions.map(position => {
            const markPriceKopecks = latestMarks.get(position.instrumentId) ?? 0n;
            const valuation = markVirtualPosition(position, markPriceKopecks);
            return {
                instrumentId: position.instrumentId, lotSize: position.lotSize,
                quantityLots: valuation.quantityLots,
                markPriceKopecks: serializePaperKopecks(markPriceKopecks),
                costBasisKopecks: serializePaperKopecks(valuation.costBasisKopecks),
                marketValueKopecks: serializePaperKopecks(valuation.marketValueKopecks),
                realizedPnlKopecks: serializePaperKopecks(valuation.realizedPnlKopecks),
                unrealizedPnlKopecks: serializePaperKopecks(valuation.unrealizedPnlKopecks)
            };
        });
        let reconciliation: PaperLabReconciliationDto;
        if (reconciliationBoundExceeded) {
            reconciliation = { status: 'error', reason: `reconciliation fill bound exceeded: ${PAPER_LAB_MAX_RECONCILIATION_FILLS}` };
        } else {
            const reconciliationService = new VirtualReconciliationService(
                { async load() { return ledger; } },
                { async load() { return portfolio; } },
                { async getMarks(_accountId, instrumentIds) {
                    return instrumentIds.map(instrumentId => ({ instrumentId, priceKopecks: latestMarks.get(instrumentId) ?? 0n }));
                } }
            );
            try {
                const metrics = await reconciliationService.load(canonicalId);
                const degraded = positions.some(position => position.quantityLots > 0);
                reconciliation = {
                    status: degraded ? 'degraded' : 'ok',
                    reason: degraded ? 'Open positions use latest virtual fills as local marks; no broker quote was requested.' : undefined,
                    metrics: Object.fromEntries(Object.entries(metrics).map(([name, value]) => [
                        name, typeof value === 'bigint' ? serializePaperKopecks(value) : value
                    ]))
                };
            } catch (error) {
                reconciliation = { status: 'error', reason: error instanceof Error ? error.message : String(error) };
            }
        }
        const latestEventAt = [
            ...orders.map(row => row.completedAt), ...visibleFills.map(row => row.filledAt),
            ...decisions.map(row => row.evaluatedAt)
        ].filter(Boolean).sort().at(-1);
        const ageMs = latestEventAt ? Math.max(0, timestamp.getTime() - new Date(latestEventAt).getTime()) : undefined;
        const hasNextPage = orders.length === limit || visibleFills.length === limit || decisions.length === limit;
        return Object.freeze({
            ...base,
            accounts: [accountDto],
            experiment: { ...accountDto, markSource: 'latest-virtual-fill' },
            observation: observationRows ? buildObservationMonitoring(observationRows, timestamp) : {
                state: 'DEGRADED', reasons: [observationError ? 'OBSERVATION_READ_FAILED' : 'OBSERVATION_DATA_MISSING'],
                ...(observationError ? { error: observationError } : {})
            },
            reconciliation,
            positions,
            orders: orders.map(row => ({ orderId: row.orderId, instrumentId: row.instrumentId, side: row.side, quantityLots: row.quantityLots, submittedAt: row.submittedAt, status: row.status, rejectionReason: row.rejectionReason, completedAt: row.completedAt })),
            fills: visibleFills.map(row => {
                const fill = virtualFillRowToDomain(row);
                return { fillId: fill.id, orderId: fill.orderId, instrumentId: fill.instrumentId, side: fill.side, quantityLots: fill.quantityLots, lotSize: fill.lotSize, executionPriceKopecks: serializePaperKopecks(fill.executionPriceKopecks), grossAmountKopecks: serializePaperKopecks(fill.grossAmountKopecks), feeKopecks: serializePaperKopecks(fill.feeKopecks), filledAt: fill.filledAt };
            }),
            decisions: decisions.map(row => ({ decisionId: row.decisionId, instrumentId: row.instrumentId, evaluatedAt: row.evaluatedAt, action: row.action, status: row.status, source: row.source, reason: row.reason, orderId: row.orderId })),
            nextCursor: hasNextPage ? encodePaperLabCursor({ virtualAccountId: canonicalId, offset: offset + limit }) : undefined,
            freshness: latestEventAt ? { latestEventAt, ageMs, state: ageMs !== undefined && ageMs > 5 * 60_000 ? 'stale' as const : 'fresh' as const } : undefined
        });
    }
}

export default new PaperLabReadModelService();
