import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
    AccountOpenedEvent, DeterministicVirtualExecutionSimulator, VirtualOrderIntent,
    applyVirtualLedgerEvent, decodeVirtualExecutionResult, encodeVirtualExecutionResult,
    openVirtualCashAccount, virtualOrderIntentFingerprint
} from './index';

const now = '2026-08-29T10:00:00Z';
const canonicalNow = '2026-08-29T10:00:00.000Z';
const order = (overrides: Partial<VirtualOrderIntent> = {}): VirtualOrderIntent => ({
    id: 'order-1', virtualAccountId: 'virtual-1x', instrumentId: 'SBER',
    side: 'buy', quantityLots: 2, submittedAt: now, ...overrides
});
const quote = { instrumentId: 'SBER', bidKopecks: 9_900n, askKopecks: 10_000n, lotSize: 10, observedAt: now };
const context = { now, cashKopecks: 1_000_000n, availableLots: 0 };
const policy = { feeBasisPoints: 30, slippageBasisPoints: 10, maxQuoteAgeMs: 60_000 };

describe('deterministic virtual execution simulator', () => {
    it('fills a buy at ask plus slippage and emits exact cash/fee events', () => {
        const result = new DeterministicVirtualExecutionSimulator().execute(order(), quote, context, policy);
        assert.strictEqual(result.status, 'filled');
        if (result.status !== 'filled') return;
        assert.deepStrictEqual(result.fill, {
            id: 'fill:order-1', orderId: 'order-1', virtualAccountId: 'virtual-1x', instrumentId: 'SBER',
            side: 'buy', quantityLots: 2, lotSize: 10, referencePriceKopecks: 10_000n,
            executionPriceKopecks: 10_010n, grossAmountKopecks: 200_200n,
            feeKopecks: 601n, netCashDeltaKopecks: -200_801n, filledAt: canonicalNow
        });
        assert.deepStrictEqual(result.ledgerEvents.map(event => [event.kind, event.amountKopecks]), [
            ['trade-cash', 200_200n], ['fee', 601n]
        ]);

        const opened: AccountOpenedEvent = {
            id: 'opened', virtualAccountId: 'virtual-1x', occurredAt: now,
            kind: 'account-opened', amountKopecks: 1_000_000n
        };
        const settled = result.ledgerEvents.reduce((state, event) => applyVirtualLedgerEvent(state, event), openVirtualCashAccount(opened));
        assert.strictEqual(settled.cashKopecks, 799_199n);
        const restored = decodeVirtualExecutionResult(encodeVirtualExecutionResult(result));
        assert.deepStrictEqual(restored, result);
        assert.ok(Object.isFrozen(restored));
    });

    it('fills a sell at bid minus slippage and uses owned-lot guard', () => {
        const simulator = new DeterministicVirtualExecutionSimulator();
        const filled = simulator.execute(order({ id: 'sell-1', side: 'sell', quantityLots: 1 }), quote, { ...context, availableLots: 1 }, policy);
        assert.strictEqual(filled.status, 'filled');
        if (filled.status === 'filled') {
            assert.strictEqual(filled.fill.executionPriceKopecks, 9_890n);
            assert.strictEqual(filled.fill.grossAmountKopecks, 98_900n);
            assert.strictEqual(filled.fill.feeKopecks, 297n);
            assert.strictEqual(filled.fill.netCashDeltaKopecks, 98_603n);
        }
        const rejected = simulator.execute(order({ id: 'sell-2', side: 'sell' }), quote, context, policy);
        assert.deepStrictEqual(rejected, { status: 'rejected', orderId: 'sell-2', reason: 'insufficient-position', rejectedAt: canonicalNow });
    });

    it('rejects insufficient cash including fees and stale quotes', () => {
        const simulator = new DeterministicVirtualExecutionSimulator();
        assert.strictEqual(simulator.execute(order(), quote, { ...context, cashKopecks: 200_800n }, policy).status, 'rejected');
        const stale = simulator.execute(order({ id: 'stale' }), { ...quote, observedAt: '2026-08-29T09:58:00Z' }, context, policy);
        assert.deepStrictEqual(stale, { status: 'rejected', orderId: 'stale', reason: 'stale-quote', rejectedAt: canonicalNow });
    });

    it('returns the same frozen result for identical retry and rejects changed payload', () => {
        const simulator = new DeterministicVirtualExecutionSimulator();
        const first = simulator.execute(order(), quote, context, policy);
        const retry = simulator.execute({ ...order() }, { ...quote }, { ...context }, { ...policy });
        assert.strictEqual(retry, first);
        assert.ok(Object.isFrozen(first));
        assert.throws(() => simulator.execute(order({ quantityLots: 3 }), quote, context, policy), /ID conflict/);
    });

    it('rejects crossed, future and malformed deterministic inputs', () => {
        const simulator = new DeterministicVirtualExecutionSimulator();

        assert.strictEqual(virtualOrderIntentFingerprint(order()), virtualOrderIntentFingerprint({ ...order() }));
        assert.notStrictEqual(virtualOrderIntentFingerprint(order()), virtualOrderIntentFingerprint(order({ quantityLots: 3 })));
        assert.strictEqual(simulator.execute(order({ id: 'crossed' }), { ...quote, bidKopecks: 10_001n }, context, policy).status, 'rejected');
        assert.strictEqual(simulator.execute(order({ id: 'future' }), { ...quote, observedAt: '2026-08-29T10:00:01Z' }, context, policy).status, 'rejected');
        assert.strictEqual(simulator.execute(order({ id: 'bad-lots', quantityLots: 0 }), quote, context, policy).status, 'rejected');
        assert.strictEqual(simulator.execute(order({ id: 'bad-time', submittedAt: 'bad' }), quote, context, policy).status, 'rejected');
        assert.strictEqual(simulator.execute(order({ id: 'bad-quote-time' }), { ...quote, observedAt: 'bad' }, context, policy).status, 'rejected');
    });
});
