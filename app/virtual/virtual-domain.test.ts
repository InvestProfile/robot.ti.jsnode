import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
    AccountOpenedEvent,
    DepositEvent,
    FeeEvent,
    StoredVirtualLedgerEvent,
    applyVirtualLedgerEvent,
    decodeKopecks,
    decodeVirtualLedgerEvent,
    encodeKopecks,
    encodeVirtualLedgerEvent,
    normalizeRfc3339Timestamp,
    openVirtualCashAccount,
    replayVirtualLedger,
    validateVirtualCashAccountState,
    valueVirtualAccount
} from './index';

const accountId = 'virtual-1x';
const occurredAt = '2026-08-14T10:00:00.000Z';
const opened = (overrides: Partial<AccountOpenedEvent> = {}): AccountOpenedEvent => ({
    id: 'opened-1',
    virtualAccountId: accountId,
    occurredAt,
    kind: 'account-opened',
    amountKopecks: 10_000_000n,
    ...overrides
});
const deposit = (id: string, amountKopecks = 1_000n): DepositEvent => ({
    id, virtualAccountId: accountId, occurredAt, kind: 'deposit', amountKopecks
});

describe('virtual ledger', () => {
    it('requires exactly one account-opened event and requires it first', () => {
        assert.throws(() => replayVirtualLedger([]), /requires account-opened/);
        assert.throws(() => replayVirtualLedger([deposit('deposit-1')]), /must be the first/);
        assert.throws(() => replayVirtualLedger([opened(), opened({ id: 'opened-2' })]), /exactly once/);

        const state = openVirtualCashAccount(opened());
        assert.strictEqual(state.cashKopecks, 10_000_000n);
        assert.strictEqual(state.entries[0].kind, 'account-opened');
    });

    it('stores normalized frozen canonical entries, not source object references', () => {
        const source = deposit('deposit-1') as DepositEvent & { amountKopecks: bigint };
        const state = replayVirtualLedger([opened({ occurredAt: '2026-08-14T13:00:00+03:00' }), source]);
        source.amountKopecks = 999_999n;

        assert.strictEqual(state.entries[0].occurredAt, occurredAt);
        assert.strictEqual(state.entries[1].amountKopecks, 1_000n);
        assert.notStrictEqual(state.entries[1], source);
        assert.ok(Object.isFrozen(state));
        assert.ok(Object.isFrozen(state.entries));
        assert.ok(state.entries.every(Object.isFrozen));
        assert.strictEqual(state.eventIndex.get('deposit-1'), state.entries[1]);
        assert.strictEqual((state.eventIndex as unknown as { set?: unknown }).set, undefined);
    });

    it('replays all cash vocabulary and reconciles cash from canonical ledger', () => {
        const events = [
            opened(),
            deposit('deposit-1', 100_000n),
            {
                id: 'fee-1', virtualAccountId: accountId, occurredAt, kind: 'fee',
                amountKopecks: 500n, reason: 'commission'
            } as FeeEvent,
            {
                id: 'interest-1', virtualAccountId: accountId, occurredAt, kind: 'interest',
                amountKopecks: 300n, reason: 'financing'
            } as const,
            {
                id: 'buy-1', virtualAccountId: accountId, occurredAt, kind: 'trade-cash',
                amountKopecks: 2_000_000n, direction: 'debit', tradeReference: 'trade-1'
            } as const,
            {
                id: 'sell-1', virtualAccountId: accountId, occurredAt, kind: 'trade-cash',
                amountKopecks: 2_100_000n, direction: 'credit', tradeReference: 'trade-2'
            } as const
        ];
        const state = replayVirtualLedger(events);
        assert.strictEqual(state.cashKopecks, 10_199_200n);
        assert.deepStrictEqual(state.entries.map(event => event.id), events.map(event => event.id));
        assert.doesNotThrow(() => validateVirtualCashAccountState(state));
    });

    it('is payload-aware when duplicate IDs are ignored', () => {
        const event = deposit('same-id', 1_000n);
        const state = replayVirtualLedger([opened(), event]);
        assert.strictEqual(applyVirtualLedgerEvent(state, { ...event }, 'ignore'), state);

        const equivalentTimestamp = {
            ...event,
            occurredAt: '2026-08-14T13:00:00+03:00'
        };
        assert.strictEqual(applyVirtualLedgerEvent(state, equivalentTimestamp, 'ignore'), state);

        assert.throws(
            () => applyVirtualLedgerEvent(state, { ...event, amountKopecks: 1_001n }, 'ignore'),
            /ID conflict/
        );
        assert.throws(
            () => replayVirtualLedger([opened(), event, { ...event, amountKopecks: 2_000n }], 'ignore'),
            /ID conflict/
        );
    });

    it('rejects equivalent duplicate payload by default and invalid duplicate policy', () => {
        const event = deposit('same-id');
        const state = replayVirtualLedger([opened(), event]);
        assert.throws(() => applyVirtualLedgerEvent(state, event), /duplicate virtual ledger event/);
        assert.throws(
            () => replayVirtualLedger([opened()], 'invalid' as 'reject'),
            /duplicate policy/
        );
    });

    it('restarts from serialized storage entries with identical canonical state', () => {
        const before = replayVirtualLedger([
            opened(),
            deposit('deposit-1'),
            {
                id: 'fee-1', virtualAccountId: accountId, occurredAt, kind: 'fee',
                amountKopecks: 25n, reason: 'commission'
            }
        ]);
        const stored = before.entries.map(encodeVirtualLedgerEvent);
        const json = JSON.stringify(stored);
        assert.match(json, /"amountKopecks":"10000000"/);

        const decoded = (JSON.parse(json) as StoredVirtualLedgerEvent[])
            .map(decodeVirtualLedgerEvent);
        const after = replayVirtualLedger(decoded);

        assert.strictEqual(after.cashKopecks, before.cashKopecks);
        assert.deepStrictEqual(
            after.entries.map(encodeVirtualLedgerEvent),
            before.entries.map(encodeVirtualLedgerEvent)
        );
    });

    it('rejects account mismatches, negative cash and invalid event fields', () => {
        const state = replayVirtualLedger([opened({ amountKopecks: 100n })]);
        assert.throws(
            () => applyVirtualLedgerEvent(state, { ...deposit('wrong'), virtualAccountId: 'other' }),
            /does not match/
        );
        assert.throws(() => applyVirtualLedgerEvent(state, {
            id: 'fee-too-large', virtualAccountId: accountId, occurredAt, kind: 'fee',
            amountKopecks: 101n, reason: 'commission'
        }), /would make cash negative/);
        assert.throws(() => replayVirtualLedger([opened({ id: '' })]), /event.id/);
        assert.throws(() => replayVirtualLedger([opened({ amountKopecks: 0n })]), /positive bigint/);
        assert.throws(() => replayVirtualLedger([{
            ...opened(), kind: 'unknown'
        } as unknown as AccountOpenedEvent]), /unsupported/);
        assert.throws(() => applyVirtualLedgerEvent(state, {
            id: 'fee', virtualAccountId: accountId, occurredAt, kind: 'fee',
            amountKopecks: 1n, reason: ''
        }), /reason/);
    });

    it('strictly validates state cash, canonical entries and event index', () => {
        const valid = replayVirtualLedger([opened(), deposit('deposit-1')]);
        assert.throws(() => validateVirtualCashAccountState({
            ...valid,
            cashKopecks: valid.cashKopecks + 1n
        }), /state must be frozen|does not reconcile/);
        assert.throws(() => validateVirtualCashAccountState(Object.freeze({
            ...valid,
            cashKopecks: valid.cashKopecks + 1n
        })), /does not reconcile/);
        assert.throws(() => validateVirtualCashAccountState(Object.freeze({
            ...valid,
            eventIndex: Object.freeze({
                size: 0,
                has: () => false,
                get: () => undefined
            })
        })), /index size mismatch/);
    });
});

describe('storage codecs and timestamps', () => {
    it('roundtrips strict canonical decimal kopecks without JSON bigint', () => {
        for (const value of [0n, 1n, -1n, 999_999_999_999_999n]) {
            assert.strictEqual(decodeKopecks(encodeKopecks(value)), value);
        }
        assert.strictEqual(JSON.stringify({ amount: encodeKopecks(10n) }), '{"amount":"10"}');
    });

    it('rejects malformed and noncanonical decimal strings', () => {
        for (const value of ['', '+1', '01', '-0', '1.0', ' 1', '1 ', '1e3']) {
            assert.throws(() => decodeKopecks(value), /canonical decimal/);
        }
        assert.throws(() => encodeKopecks(1 as unknown as bigint), /bigint/);
    });

    it('requires RFC3339 timezone and normalizes offsets to UTC', () => {
        assert.strictEqual(
            normalizeRfc3339Timestamp('2026-08-14T13:00:00+03:00'),
            occurredAt
        );
        for (const value of [
            '2026-08-14T10:00:00',
            '2026-08-14 10:00:00Z',
            'not-a-date',
            '2026-13-14T10:00:00Z',
            '2026-02-30T10:00:00Z',
            '2026-08-14T25:00:00Z'
        ]) {
            assert.throws(() => normalizeRfc3339Timestamp(value), /RFC3339/);
        }
    });
});

describe('long-only valuation', () => {
    it('reconciles cash plus immutable non-negative position marks', () => {
        const account = replayVirtualLedger([opened({ amountKopecks: 10_000n })]);
        const marks = Object.freeze([
            Object.freeze({ instrumentId: 'SBER', marketValueKopecks: 4_000n }),
            Object.freeze({ instrumentId: 'LKOH', marketValueKopecks: 1_500n })
        ]);
        assert.deepStrictEqual(valueVirtualAccount(account, marks), {
            cashKopecks: 10_000n,
            positionsValueKopecks: 5_500n,
            equityKopecks: 15_500n
        });
    });

    it('rejects negative, duplicate and malformed marks', () => {
        const account = replayVirtualLedger([opened({ amountKopecks: 100n })]);
        assert.throws(
            () => valueVirtualAccount(account, [{ instrumentId: 'SHORT', marketValueKopecks: -1n }]),
            /long-only/
        );
        assert.throws(() => valueVirtualAccount(account, [
            { instrumentId: 'SBER', marketValueKopecks: 1n },
            { instrumentId: 'SBER', marketValueKopecks: 2n }
        ]), /duplicate position mark/);
        assert.throws(
            () => valueVirtualAccount(account, [{ instrumentId: '', marketValueKopecks: 1n }]),
            /non-empty/
        );
    });
});
