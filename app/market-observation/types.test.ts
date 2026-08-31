import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    assertSameMarketMarkIdentity,
    assertUniqueMarketMarkIdentities,
    createBrokerMarketMark,
    MARKET_MARK_SOURCE
} from './types';

const input = (overrides: Record<string, unknown> = {}) => ({
    observationId: 'obs-1', sourceIdentity: 'stream:uid-1:42', instrumentUid: 'uid-1',
    brokerObservedAt: '2026-08-31T12:00:00.000Z', receivedAt: '2026-08-31T12:00:00.250Z',
    bidKopecks: 100n, askKopecks: 102n, markKopecks: 101n,
    source: MARKET_MARK_SOURCE, sessionStatus: 'open' as const, sourceSequence: '42', ...overrides
});

describe('broker market mark contract', () => {
    it('keeps broker and receipt timestamps distinct and money as canonical bigint', () => {
        const mark = createBrokerMarketMark(input());
        assert.equal(mark.brokerObservedAt, '2026-08-31T12:00:00.000Z');
        assert.equal(mark.receivedAt, '2026-08-31T12:00:00.250Z');
        assert.equal(mark.markKopecks, 101n);
        assert.match(mark.payloadFingerprint, /^[a-f0-9]{64}$/);
        assert(Object.isFrozen(mark));
    });

    it('rejects non-bigint, crossed, out-of-spread and non-canonical timestamp inputs', () => {
        assert.throws(() => createBrokerMarketMark(input({ bidKopecks: 100 }) as never), /bigint/);
        assert.throws(() => createBrokerMarketMark(input({ bidKopecks: 103n })), /crossed/);
        assert.throws(() => createBrokerMarketMark(input({ markKopecks: 103n })), /within bid\/ask/);
        assert.throws(() => createBrokerMarketMark(input({ brokerObservedAt: '2026-08-31T12:00:00Z' })), /canonical/);
    });

    it('is idempotent for an identical replay and hard-fails changed identity payloads', () => {
        const first = createBrokerMarketMark(input());
        const replay = createBrokerMarketMark(input());
        assert.equal(assertSameMarketMarkIdentity(first, replay), first);
        const changed = createBrokerMarketMark(input({ markKopecks: 100n }));
        assert.throws(() => assertSameMarketMarkIdentity(first, changed), /payload conflict/);
        const aliased = createBrokerMarketMark(input({ observationId: 'obs-2', markKopecks: 100n }));
        assert.throws(() => assertUniqueMarketMarkIdentities([first, aliased]), /source identity payload conflict/);
    });
});
