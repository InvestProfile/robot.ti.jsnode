import { createHash } from 'node:crypto';
import { QueryTypes, Sequelize, Transaction } from 'sequelize';
import { normalizeRfc3339Timestamp } from '../virtual/codecs';

export type ShadowDecisionAction = 'buy' | 'sell' | 'hold';
export type ShadowDecisionStatus = 'allowed' | 'blocked' | 'hold';

export interface ShadowSourceQuote {
    readonly bidKopecks: bigint;
    readonly askKopecks: bigint;
    readonly markKopecks: bigint;
    readonly quoteObservedAt: string;
}

interface ShadowSourceEventBase {
    readonly eventId: string;
    readonly instrumentId: string;
    readonly quote: ShadowSourceQuote;
}

export interface ShadowSourceDecisionEvent extends ShadowSourceEventBase {
    readonly kind: 'decision';
    readonly decisionId: string;
    readonly action: ShadowDecisionAction;
    readonly status: ShadowDecisionStatus;
    readonly approvedLots: number;
    readonly lotSize: number;
    readonly reason: string;
    readonly evaluatedAt: string;
}

export interface ShadowSourceMarkEvent extends ShadowSourceEventBase {
    readonly kind: 'mark';
    readonly markedAt: string;
}

export type ShadowSourceEvent = ShadowSourceDecisionEvent | ShadowSourceMarkEvent;

export interface ShadowSourceTickDraft {
    readonly sourceTickId: string;
    readonly startedAt: string;
    readonly completedAt: string;
    readonly expectedEventCount: number;
    readonly policyVersion: string;
    readonly configFingerprint: string;
    readonly events: readonly ShadowSourceEvent[];
}

export interface CompleteShadowSourceTick extends ShadowSourceTickDraft {
    readonly payloadFingerprint: string;
}

export interface ClaimedShadowSourceTick {
    readonly tick: CompleteShadowSourceTick;
    readonly consumerId: string;
    acknowledge(): Promise<boolean>;
}

interface EncodedEvent {
    readonly event: ShadowSourceEvent;
    readonly json: string;
    readonly fingerprint: string;
}

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const requireString = (value: string, field: string) => {
    if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
        throw new TypeError(`${field} must be a trimmed non-empty string`);
    }
    return value;
};
const requireFingerprint = (value: string, field: string) => {
    if (!/^[a-f0-9]{64}$/.test(value)) throw new TypeError(`${field} must be a lowercase sha256 fingerprint`);
    return value;
};
const requirePositiveMoney = (value: bigint, field: string) => {
    if (typeof value !== 'bigint' || value <= 0n) throw new TypeError(`${field} must be a positive bigint`);
    return value;
};

const canonicalQuote = (quote: ShadowSourceQuote, completedAt: string, maxQuoteAgeMs: number) => {
    const bid = requirePositiveMoney(quote.bidKopecks, 'quote.bidKopecks');
    const ask = requirePositiveMoney(quote.askKopecks, 'quote.askKopecks');
    const mark = requirePositiveMoney(quote.markKopecks, 'quote.markKopecks');
    if (bid > ask) throw new Error('crossed quote');
    if (mark < bid || mark > ask) throw new Error('mark must be inside bid/ask');
    const quoteObservedAt = normalizeRfc3339Timestamp(quote.quoteObservedAt);
    const age = Date.parse(completedAt) - Date.parse(quoteObservedAt);
    if (age < 0 || age > maxQuoteAgeMs) throw new Error('stale quote');
    return { bidKopecks: bid.toString(), askKopecks: ask.toString(), markKopecks: mark.toString(), quoteObservedAt };
};

const canonicalEvent = (event: ShadowSourceEvent, completedAt: string, maxQuoteAgeMs: number): Record<string, unknown> => {
    requireString(event.eventId, 'event.eventId');
    requireString(event.instrumentId, 'event.instrumentId');
    const base = { kind: event.kind, eventId: event.eventId, instrumentId: event.instrumentId,
        quote: canonicalQuote(event.quote, completedAt, maxQuoteAgeMs) };
    if (event.kind === 'mark') return { ...base, markedAt: normalizeRfc3339Timestamp(event.markedAt) };
    requireString(event.decisionId, 'event.decisionId');
    requireString(event.reason, 'event.reason');
    if (!Number.isSafeInteger(event.approvedLots) || event.approvedLots < 0) throw new TypeError('approvedLots must be a non-negative safe integer');
    if (!Number.isSafeInteger(event.lotSize) || event.lotSize <= 0) throw new TypeError('lotSize must be a positive safe integer');
    if (event.status === 'allowed' && (event.action === 'buy' || event.action === 'sell') && event.approvedLots === 0) {
        throw new Error('allowed trade decision requires approvedLots');
    }
    if (event.status !== 'allowed' && event.approvedLots !== 0) throw new Error('non-allowed decision cannot approve lots');
    return { ...base, decisionId: event.decisionId, action: event.action, status: event.status,
        approvedLots: event.approvedLots, lotSize: event.lotSize, reason: event.reason,
        evaluatedAt: normalizeRfc3339Timestamp(event.evaluatedAt) };
};

export const encodeShadowSourceEvent = (
    event: ShadowSourceEvent, completedAt: string, maxQuoteAgeMs: number
): EncodedEvent => {
    const canonical = canonicalEvent(event, normalizeRfc3339Timestamp(completedAt), maxQuoteAgeMs);
    const json = JSON.stringify(canonical);
    return Object.freeze({ event: decodeShadowSourceEvent(json), json, fingerprint: sha256(json) });
};

export const decodeShadowSourceEvent = (json: string): ShadowSourceEvent => {
    let raw: unknown;
    try { raw = JSON.parse(json); } catch { throw new TypeError('malformed shadow source event JSON'); }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new TypeError('shadow source event must be an object');
    const value = raw as Record<string, unknown>;
    const quoteRaw = value.quote as Record<string, unknown> | undefined;
    if (!quoteRaw || typeof quoteRaw !== 'object') throw new TypeError('event.quote is required');
    const decimal = (item: unknown, field: string) => {
        if (typeof item !== 'string' || !/^[1-9][0-9]*$/.test(item)) throw new TypeError(`${field} must be a canonical positive integer string`);
        return BigInt(item);
    };
    if (typeof quoteRaw.quoteObservedAt !== 'string') throw new TypeError('quote.quoteObservedAt must be a string');
    const quote: ShadowSourceQuote = Object.freeze({
        bidKopecks: decimal(quoteRaw.bidKopecks, 'quote.bidKopecks'),
        askKopecks: decimal(quoteRaw.askKopecks, 'quote.askKopecks'),
        markKopecks: decimal(quoteRaw.markKopecks, 'quote.markKopecks'),
        quoteObservedAt: normalizeRfc3339Timestamp(quoteRaw.quoteObservedAt)
    });
    const stringField = (item: unknown, field: string) => {
        if (typeof item !== 'string') throw new TypeError(`${field} must be a string`);
        return requireString(item, field);
    };
    const timestampField = (item: unknown, field: string) => normalizeRfc3339Timestamp(stringField(item, field));
    const common = { eventId: stringField(value.eventId, 'event.eventId'),
        instrumentId: stringField(value.instrumentId, 'event.instrumentId'), quote };
    if (value.kind === 'mark') return Object.freeze({ ...common, kind: 'mark', markedAt: timestampField(value.markedAt, 'event.markedAt') });
    if (value.kind !== 'decision') throw new TypeError('unknown shadow source event kind');
    if (!['buy', 'sell', 'hold'].includes(String(value.action))) throw new TypeError('invalid decision action');
    if (!['allowed', 'blocked', 'hold'].includes(String(value.status))) throw new TypeError('invalid decision status');
    if (!Number.isSafeInteger(value.approvedLots) || (value.approvedLots as number) < 0) throw new TypeError('invalid approvedLots');
    if (!Number.isSafeInteger(value.lotSize) || (value.lotSize as number) <= 0) throw new TypeError('invalid lotSize');
    return Object.freeze({ ...common, kind: 'decision', decisionId: stringField(value.decisionId, 'event.decisionId'),
        action: value.action as ShadowDecisionAction, status: value.status as ShadowDecisionStatus,
        approvedLots: value.approvedLots as number, lotSize: value.lotSize as number,
        reason: stringField(value.reason, 'event.reason'), evaluatedAt: timestampField(value.evaluatedAt, 'event.evaluatedAt') });
};

const normalizeDraft = (draft: ShadowSourceTickDraft, maxQuoteAgeMs: number) => {
    const sourceTickId = requireString(draft.sourceTickId, 'sourceTickId');
    const startedAt = normalizeRfc3339Timestamp(draft.startedAt);
    const completedAt = normalizeRfc3339Timestamp(draft.completedAt);
    if (startedAt > completedAt) throw new Error('tick completedAt precedes startedAt');
    if (!Number.isSafeInteger(draft.expectedEventCount) || draft.expectedEventCount < 0) throw new TypeError('invalid expectedEventCount');
    requireString(draft.policyVersion, 'policyVersion');
    requireFingerprint(draft.configFingerprint, 'configFingerprint');
    if (draft.events.length !== draft.expectedEventCount) throw new Error('incomplete shadow source tick');
    const ids = new Set<string>();
    const encoded = draft.events.map(event => encodeShadowSourceEvent(event, completedAt, maxQuoteAgeMs));
    for (const item of encoded) if (ids.has(item.event.eventId)) throw new Error('duplicate shadow source eventId'); else ids.add(item.event.eventId);
    const payloadJson = JSON.stringify({ sourceTickId, startedAt, completedAt, expectedEventCount: draft.expectedEventCount,
        policyVersion: draft.policyVersion, configFingerprint: draft.configFingerprint,
        events: encoded.map(item => JSON.parse(item.json)) });
    return { sourceTickId, startedAt, completedAt, expectedEventCount: draft.expectedEventCount,
        policyVersion: draft.policyVersion, configFingerprint: draft.configFingerprint, encoded,
        payloadFingerprint: sha256(payloadJson) };
};

interface TickRow { source_tick_id: string; started_at: string | Date; completed_at: string | Date; expected_event_count: number;
    policy_version: string; config_fingerprint: string; payload_fingerprint: string; }
interface EventRow { payload_json: string; payload_fingerprint: string; }

export class SequelizeShadowSourceOutbox {
    constructor(private readonly database: Sequelize, private readonly maxQuoteAgeMs: number) {
        if (!Number.isSafeInteger(maxQuoteAgeMs) || maxQuoteAgeMs < 0) throw new TypeError('maxQuoteAgeMs must be a non-negative safe integer');
    }

    async publish(draft: ShadowSourceTickDraft): Promise<CompleteShadowSourceTick> {
        let normalized: ReturnType<typeof normalizeDraft>;
        try { normalized = normalizeDraft(draft, this.maxQuoteAgeMs); }
        catch (error) { await this.markFailed(draft, error); throw error; }
        const result = await this.database.transaction(async transaction => {
            const existing = await this.loadTick(normalized.sourceTickId, transaction, true);
            if (existing) {
                if (existing.payload_fingerprint === normalized.payloadFingerprint) return this.hydrate(existing, transaction);
                await this.failCollecting(normalized.sourceTickId, 'payload conflict', transaction);
                return undefined;
            }
            await this.database.query(`INSERT INTO shadow_source_ticks
                (source_tick_id, status, started_at, expected_event_count, policy_version, config_fingerprint)
                VALUES (:sourceTickId, 'collecting', :startedAt, :expectedEventCount, :policyVersion, :configFingerprint)`,
            { replacements: normalized, transaction });
            for (const [sequence, item] of normalized.encoded.entries()) await this.database.query(
                `INSERT INTO shadow_source_events
                    (source_tick_id, sequence, event_id, event_kind, instrument_id, payload_fingerprint, payload_json)
                 VALUES (:sourceTickId, :sequence, :eventId, :eventKind, :instrumentId, :eventFingerprint, :eventJson)`,
                { replacements: { sourceTickId: normalized.sourceTickId, sequence, eventId: item.event.eventId,
                    eventKind: item.event.kind, instrumentId: item.event.instrumentId,
                    eventFingerprint: item.fingerprint, eventJson: item.json }, transaction });
            await this.database.query(`UPDATE shadow_source_ticks SET status = 'complete', completed_at = :completedAt,
                    actual_event_count = :expectedEventCount, payload_fingerprint = :payloadFingerprint, updated_at = CURRENT_TIMESTAMP
                WHERE source_tick_id = :sourceTickId AND status = 'collecting'`, { replacements: normalized, transaction });
            return Object.freeze({ ...draft, startedAt: normalized.startedAt, completedAt: normalized.completedAt,
                events: Object.freeze(normalized.encoded.map(item => item.event)), payloadFingerprint: normalized.payloadFingerprint });
        });
        if (!result) throw new Error(`shadow source tick conflict: ${normalized.sourceTickId}`);
        return result;
    }

    async claimNext(consumerId: string, leaseMs: number): Promise<ClaimedShadowSourceTick | undefined> {
        requireString(consumerId, 'consumerId');
        if (!Number.isSafeInteger(leaseMs) || leaseMs <= 0) throw new TypeError('leaseMs must be positive');
        return this.database.transaction(async transaction => {
            const rows = await this.database.query<TickRow>(`SELECT * FROM shadow_source_ticks
                WHERE status = 'complete' AND processed_at IS NULL AND (claimed_until IS NULL OR claimed_until <= CURRENT_TIMESTAMP)
                ORDER BY completed_at, source_tick_id LIMIT 1 FOR UPDATE SKIP LOCKED`, { type: QueryTypes.SELECT, transaction });
            const row = rows[0];
            if (!row) return undefined;
            await this.database.query(`UPDATE shadow_source_ticks SET claimed_by = :consumerId,
                claimed_until = CURRENT_TIMESTAMP + (:leaseMs * INTERVAL '1 millisecond'), updated_at = CURRENT_TIMESTAMP
                WHERE source_tick_id = :sourceTickId`, { replacements: { consumerId, leaseMs, sourceTickId: row.source_tick_id }, transaction });
            const tick = await this.hydrate(row, transaction);
            return Object.freeze({ tick, consumerId, acknowledge: () => this.acknowledge(row.source_tick_id, consumerId) });
        });
    }

    private async acknowledge(sourceTickId: string, consumerId: string): Promise<boolean> {
        const rows = await this.database.query<{ source_tick_id: string }>(`UPDATE shadow_source_ticks SET processed_at = CURRENT_TIMESTAMP,
            claimed_by = NULL, claimed_until = NULL, updated_at = CURRENT_TIMESTAMP
            WHERE source_tick_id = :sourceTickId AND status = 'complete' AND processed_at IS NULL
              AND claimed_by = :consumerId AND claimed_until > CURRENT_TIMESTAMP
            RETURNING source_tick_id`, {
            replacements: { sourceTickId, consumerId }, type: QueryTypes.SELECT
        });
        return rows[0]?.source_tick_id === sourceTickId;
    }

    private async markFailed(draft: ShadowSourceTickDraft, error: unknown) {
        const id = typeof draft?.sourceTickId === 'string' ? draft.sourceTickId.trim() : '';
        if (!id) return;
        const reason = error instanceof Error ? error.message : 'invalid shadow source tick';
        const validTimestamp = (value: unknown) => {
            try { return normalizeRfc3339Timestamp(value as string); } catch { return new Date().toISOString(); }
        };
        await this.database.query(`INSERT INTO shadow_source_ticks
            (source_tick_id, status, started_at, completed_at, expected_event_count, actual_event_count,
             policy_version, config_fingerprint, failure_reason)
            VALUES (:sourceTickId, 'failed', :startedAt, CURRENT_TIMESTAMP, :expectedEventCount, 0,
             :policyVersion, :configFingerprint, :reason) ON CONFLICT (source_tick_id) DO NOTHING`,
        { replacements: { sourceTickId: id, startedAt: validTimestamp(draft.startedAt), expectedEventCount: Number.isSafeInteger(draft.expectedEventCount) && draft.expectedEventCount >= 0 ? draft.expectedEventCount : 0,
            policyVersion: draft.policyVersion || 'invalid', configFingerprint: /^[a-f0-9]{64}$/.test(draft.configFingerprint) ? draft.configFingerprint : '0'.repeat(64), reason } });
    }

    private async failCollecting(sourceTickId: string, reason: string, transaction: Transaction) {
        await this.database.query(`UPDATE shadow_source_ticks SET status = 'failed', completed_at = CURRENT_TIMESTAMP,
            failure_reason = :reason, updated_at = CURRENT_TIMESTAMP WHERE source_tick_id = :sourceTickId AND status = 'collecting'`,
        { replacements: { sourceTickId, reason }, transaction });
    }

    private async loadTick(sourceTickId: string, transaction: Transaction, lock = false) {
        const rows = await this.database.query<TickRow>('SELECT * FROM shadow_source_ticks WHERE source_tick_id = :sourceTickId' + (lock ? ' FOR UPDATE' : ''),
            { replacements: { sourceTickId }, type: QueryTypes.SELECT, transaction });
        return rows[0];
    }

    private async hydrate(row: TickRow, transaction: Transaction): Promise<CompleteShadowSourceTick> {
        const rows = await this.database.query<EventRow>('SELECT payload_json, payload_fingerprint FROM shadow_source_events WHERE source_tick_id = :sourceTickId ORDER BY sequence',
            { replacements: { sourceTickId: row.source_tick_id }, type: QueryTypes.SELECT, transaction });
        const events = rows.map(item => {
            if (sha256(item.payload_json) !== item.payload_fingerprint) throw new Error('shadow source event persistence fingerprint mismatch');
            return decodeShadowSourceEvent(item.payload_json);
        });
        if (events.length !== row.expected_event_count) throw new Error('complete shadow source tick is incomplete');
        return Object.freeze({ sourceTickId: row.source_tick_id, startedAt: normalizeRfc3339Timestamp(new Date(row.started_at).toISOString()),
            completedAt: normalizeRfc3339Timestamp(new Date(row.completed_at).toISOString()), expectedEventCount: row.expected_event_count,
            policyVersion: row.policy_version, configFingerprint: row.config_fingerprint, events: Object.freeze(events), payloadFingerprint: row.payload_fingerprint });
    }
}
