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

export const PAPER_LAB_DEFAULT_LIMIT = 50;
export const PAPER_LAB_MAX_LIMIT = 200;
export const PAPER_LAB_CACHE_TTL_MS = 15_000;
const PAPER_LAB_MAX_RECONCILIATION_FILLS = 10_000;

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
}

export interface PaperLabReconciliationDto {
    readonly status: 'ok' | 'degraded' | 'error';
    readonly reason?: string;
    readonly metrics?: Record<string, string | number>;
}

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
        const base = {
            generatedAt: timestamp.toISOString(),
            cache: { ttlMs: this.cacheTtlMs, state: 'fresh' as const },
            bounds: { requestedLimit: limit, maxLimit: PAPER_LAB_MAX_LIMIT, offset },
            accounts: accounts.map(account => ({
                virtualAccountId: account.virtualAccountId, name: account.name,
                status: account.status, openedAt: account.openedAt
            })),
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

        const account = await this.store.findAccount(canonicalId);
        if (!account) throw new Error(`virtual account not found: ${canonicalId}`);
        const [orders, visibleFills, reconciliationRows, ledgerRows, decisions] = await Promise.all([
            this.store.listOrders(canonicalId, limit, offset),
            this.store.listFills(canonicalId, limit, offset),
            this.store.listReconciliationFills(canonicalId, PAPER_LAB_MAX_RECONCILIATION_FILLS + 1),
            this.store.listReconciliationLedger(canonicalId, PAPER_LAB_MAX_RECONCILIATION_FILLS + 1),
            this.store.listDecisions(canonicalId, limit, offset)
        ]);
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
            accounts: [{ virtualAccountId: account.virtualAccountId, name: account.name, status: account.status, openedAt: account.openedAt }],
            experiment: { virtualAccountId: account.virtualAccountId, name: account.name, status: account.status, openedAt: account.openedAt, markSource: 'latest-virtual-fill' },
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
