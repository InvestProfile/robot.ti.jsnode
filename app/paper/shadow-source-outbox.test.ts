import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Sequelize } from 'sequelize';
import {
    decodeShadowSourceEvent,
    encodeShadowSourceEvent,
    SequelizeShadowSourceOutbox,
    ShadowSourceTickDraft
} from './shadow-source-outbox';

interface TickRow {
    source_tick_id: string; status: 'collecting' | 'complete' | 'failed'; started_at: string;
    completed_at?: string; expected_event_count: number; actual_event_count: number;
    policy_version: string; config_fingerprint: string; payload_fingerprint?: string;
    failure_reason?: string; claimed_by?: string; claimed_until?: number; processed_at?: string;
}
interface EventRow { sequence: number; event_id: string; payload_json: string; payload_fingerprint: string; }
interface Options { replacements?: Record<string, unknown>; type?: unknown }

class FakeOutboxDatabase {
    readonly ticks = new Map<string, TickRow>();
    readonly events = new Map<string, EventRow[]>();
    now = Date.parse('2026-08-31T12:01:00.000Z');

    async transaction<T>(work: (transaction: object) => Promise<T>) { return work({}); }
    async query(sql: string, options: Options = {}): Promise<unknown> {
        const v = options.replacements ?? {};
        if (sql.startsWith('SELECT * FROM shadow_source_ticks WHERE')) {
            const row = this.ticks.get(String(v.sourceTickId)); return row ? [row] : [];
        }
        if (sql.includes("WHERE status = 'complete'")) {
            const row = [...this.ticks.values()].filter(item => item.status === 'complete' && !item.processed_at
                && (!item.claimed_until || item.claimed_until <= this.now))
                .sort((a, b) => String(a.completed_at).localeCompare(String(b.completed_at)))[0];
            return row ? [row] : [];
        }
        if (sql.startsWith('SELECT payload_json')) return (this.events.get(String(v.sourceTickId)) ?? [])
            .sort((a, b) => a.sequence - b.sequence).map(({ payload_json, payload_fingerprint }) => ({ payload_json, payload_fingerprint }));
        if (sql.includes('INSERT INTO shadow_source_ticks') && sql.includes("'collecting'")) {
            const id = String(v.sourceTickId);
            this.ticks.set(id, { source_tick_id: id, status: 'collecting', started_at: String(v.startedAt),
                expected_event_count: Number(v.expectedEventCount), actual_event_count: 0,
                policy_version: String(v.policyVersion), config_fingerprint: String(v.configFingerprint) });
            return [[], 1];
        }
        if (sql.includes('INSERT INTO shadow_source_ticks') && sql.includes("'failed'")) {
            const id = String(v.sourceTickId);
            if (!this.ticks.has(id)) this.ticks.set(id, { source_tick_id: id, status: 'failed', started_at: String(v.startedAt),
                completed_at: new Date(this.now).toISOString(), expected_event_count: Number(v.expectedEventCount), actual_event_count: 0,
                policy_version: String(v.policyVersion), config_fingerprint: String(v.configFingerprint), failure_reason: String(v.reason) });
            return [[], 1];
        }
        if (sql.includes('INSERT INTO shadow_source_events')) {
            const id = String(v.sourceTickId); const rows = this.events.get(id) ?? [];
            rows.push({ sequence: Number(v.sequence), event_id: String(v.eventId), payload_json: String(v.eventJson), payload_fingerprint: String(v.eventFingerprint) });
            this.events.set(id, rows); return [[], 1];
        }
        if (sql.includes("SET status = 'complete'")) {
            const row = this.ticks.get(String(v.sourceTickId)); assert.ok(row);
            row.status = 'complete'; row.completed_at = String(v.completedAt); row.actual_event_count = Number(v.expectedEventCount);
            row.payload_fingerprint = String(v.payloadFingerprint); return [[], 1];
        }
        if (sql.includes("SET status = 'failed'")) {
            const row = this.ticks.get(String(v.sourceTickId));
            if (row?.status === 'collecting') { row.status = 'failed'; row.completed_at = new Date(this.now).toISOString(); row.failure_reason = String(v.reason); }
            return [[], row ? 1 : 0];
        }
        if (sql.includes('SET claimed_by = :consumerId')) {
            const row = this.ticks.get(String(v.sourceTickId)); assert.ok(row);
            row.claimed_by = String(v.consumerId); row.claimed_until = this.now + Number(v.leaseMs); return [[], 1];
        }
        if (sql.includes('SET processed_at = CURRENT_TIMESTAMP')) {
            const row = this.ticks.get(String(v.sourceTickId));
            if (row?.status === 'complete' && !row.processed_at && row.claimed_by === v.consumerId && (row.claimed_until ?? 0) > this.now) {
                row.processed_at = new Date(this.now).toISOString(); row.claimed_by = undefined; row.claimed_until = undefined;
                return [{ source_tick_id: row.source_tick_id }];
            }
            return [];
        }
        return [[], 0];
    }
}

const asSequelize = (db: FakeOutboxDatabase) => db as unknown as Sequelize;
const fp = 'a'.repeat(64);
const quote = { bidKopecks: 100n, askKopecks: 102n, markKopecks: 101n, quoteObservedAt: '2026-08-31T12:00:59.000Z' };
const draft = (id = 'tick-1'): ShadowSourceTickDraft => ({
    sourceTickId: id, startedAt: '2026-08-31T12:00:58.000Z', completedAt: '2026-08-31T12:01:00.000Z',
    expectedEventCount: 2, policyVersion: 'risk-v1', configFingerprint: fp,
    events: [
        { kind: 'decision', eventId: 'decision-event-1', decisionId: 'decision-1', instrumentId: 'figi-1',
            action: 'buy', status: 'allowed', approvedLots: 2, lotSize: 10, reason: 'post-risk approved',
            evaluatedAt: '2026-08-31T12:00:59.000Z', quote },
        { kind: 'mark', eventId: 'mark-event-1', instrumentId: 'figi-open', markedAt: '2026-08-31T12:00:59.000Z', quote }
    ]
});

describe('shadow source outbox codecs', () => {
    it('round-trips bigint quote values losslessly and rejects malformed encodings', () => {
        const source = draft().events[0];
        const encoded = encodeShadowSourceEvent(source, draft().completedAt, 2_000);
        assert.deepEqual(decodeShadowSourceEvent(encoded.json), source);
        assert.match(encoded.json, /"bidKopecks":"100"/);
        assert.throws(() => decodeShadowSourceEvent('{bad'), /malformed/);
        assert.throws(() => decodeShadowSourceEvent(encoded.json.replace('"100"', '"0100"')), /canonical positive integer/);
    });

    it('fails closed for stale, crossed, future, and out-of-spread quotes', () => {
        const source = draft().events[0];
        assert.throws(() => encodeShadowSourceEvent({ ...source, quote: { ...quote, quoteObservedAt: '2026-08-31T11:00:00.000Z' } }, draft().completedAt, 2_000), /stale/);
        assert.throws(() => encodeShadowSourceEvent({ ...source, quote: { ...quote, bidKopecks: 103n } }, draft().completedAt, 2_000), /crossed/);
        assert.throws(() => encodeShadowSourceEvent({ ...source, quote: { ...quote, quoteObservedAt: '2026-08-31T12:01:01.000Z' } }, draft().completedAt, 2_000), /stale/);
        assert.throws(() => encodeShadowSourceEvent({ ...source, quote: { ...quote, markKopecks: 99n } }, draft().completedAt, 2_000), /inside/);
    });
});

describe('Sequelize shadow source outbox', () => {
    it('publishes collecting to complete atomically and claims only complete ticks', async () => {
        const db = new FakeOutboxDatabase(); const outbox = new SequelizeShadowSourceOutbox(asSequelize(db), 2_000);
        db.ticks.set('collecting', { source_tick_id: 'collecting', status: 'collecting', started_at: draft().startedAt,
            expected_event_count: 1, actual_event_count: 0, policy_version: 'v', config_fingerprint: fp });
        db.ticks.set('failed', { source_tick_id: 'failed', status: 'failed', started_at: draft().startedAt,
            completed_at: draft().completedAt, expected_event_count: 1, actual_event_count: 0, policy_version: 'v', config_fingerprint: fp, failure_reason: 'bad' });
        assert.equal(await outbox.claimNext('worker-1', 1_000), undefined);
        const complete = await outbox.publish(draft());
        assert.equal(db.ticks.get('tick-1')?.status, 'complete');
        assert.equal(complete.events.length, 2);
        const claim = await outbox.claimNext('worker-1', 1_000);
        assert.equal(claim?.tick.sourceTickId, 'tick-1');
        assert.equal(await outbox.claimNext('worker-2', 1_000), undefined);
        assert.equal(await claim?.acknowledge(), true);
        assert.equal(await outbox.claimNext('worker-2', 1_000), undefined);
    });

    it('reclaims an unacknowledged complete tick after lease expiry', async () => {
        const db = new FakeOutboxDatabase(); const outbox = new SequelizeShadowSourceOutbox(asSequelize(db), 2_000);
        await outbox.publish(draft());
        const first = await outbox.claimNext('worker-1', 100); assert.ok(first);
        db.now += 101;
        const replay = await outbox.claimNext('worker-2', 100); assert.equal(replay?.tick.payloadFingerprint, first.tick.payloadFingerprint);
        assert.equal(await first.acknowledge(), false);
        assert.equal(await replay?.acknowledge(), true);
    });

    it('is payload-idempotent and rejects a conflicting immutable tick', async () => {
        const db = new FakeOutboxDatabase(); const outbox = new SequelizeShadowSourceOutbox(asSequelize(db), 2_000);
        const first = await outbox.publish(draft());
        const second = await outbox.publish(draft());
        assert.equal(second.payloadFingerprint, first.payloadFingerprint);
        assert.equal(db.events.get('tick-1')?.length, 2);
        const original = draft();
        const changed = { ...original, events: [{ ...original.events[0], reason: 'different payload' }, original.events[1]] } as ShadowSourceTickDraft;
        await assert.rejects(outbox.publish(changed), /conflict/);
        assert.equal(db.ticks.get('tick-1')?.status, 'complete');
    });

    it('persists invalid and incomplete new ticks as failed and keeps them invisible', async () => {
        const db = new FakeOutboxDatabase(); const outbox = new SequelizeShadowSourceOutbox(asSequelize(db), 2_000);
        const incomplete = { ...draft('tick-incomplete'), expectedEventCount: 3 };
        await assert.rejects(outbox.publish(incomplete), /incomplete/);
        assert.equal(db.ticks.get('tick-incomplete')?.status, 'failed');
        const staleOriginal = draft('tick-stale');
        const stale = { ...staleOriginal, events: [
            { ...staleOriginal.events[0], quote: { ...quote, quoteObservedAt: '2026-08-31T11:00:00.000Z' } },
            staleOriginal.events[1]
        ] } as ShadowSourceTickDraft;
        await assert.rejects(outbox.publish(stale), /stale/);
        assert.equal(db.ticks.get('tick-stale')?.status, 'failed');
        assert.equal(await outbox.claimNext('worker', 100), undefined);
    });
});
