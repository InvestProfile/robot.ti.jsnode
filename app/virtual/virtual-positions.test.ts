import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { VirtualFill } from './execution';
import { applyVirtualFillToPosition, emptyVirtualPosition, markVirtualPosition } from './positions';

const fill = (id: string, side: 'buy' | 'sell', lots: number, price: bigint, fee: bigint): VirtualFill => {
    const gross = price * 10n * BigInt(lots);
    return {
        id, orderId: `order-${id}`, virtualAccountId: 'paper-1', instrumentId: 'SBER',
        side, quantityLots: lots, lotSize: 10, referencePriceKopecks: price,
        executionPriceKopecks: price, grossAmountKopecks: gross, feeKopecks: fee,
        netCashDeltaKopecks: side === 'buy' ? -(gross + fee) : gross - fee,
        filledAt: '2026-08-29T10:00:00Z'
    };
};

describe('long-only FIFO virtual position accounting', () => {
    it('matches sells FIFO and includes both buy and sell fees in realized P/L', () => {
        let state = emptyVirtualPosition('paper-1', 'SBER', 10);
        state = applyVirtualFillToPosition(state, fill('buy-1', 'buy', 2, 100n, 10n));
        state = applyVirtualFillToPosition(state, fill('buy-2', 'buy', 1, 120n, 5n));
        state = applyVirtualFillToPosition(state, fill('sell-1', 'sell', 2, 130n, 8n));

        const marked = markVirtualPosition(state, 125n);
        assert.equal(marked.quantityLots, 1);
        assert.equal(marked.costBasisKopecks, 1_205n);
        assert.equal(marked.realizedPnlKopecks, 582n);
        assert.equal(marked.marketValueKopecks, 1_250n);
        assert.equal(marked.unrealizedPnlKopecks, 45n);
    });

    it('allocates partial-lot cost deterministically and preserves the remainder', () => {
        let state = emptyVirtualPosition('paper-1', 'SBER', 10);
        state = applyVirtualFillToPosition(state, fill('buy-1', 'buy', 3, 100n, 1n));
        state = applyVirtualFillToPosition(state, fill('sell-1', 'sell', 1, 100n, 0n));
        assert.equal(markVirtualPosition(state, 100n).costBasisKopecks, 2_001n);
        state = applyVirtualFillToPosition(state, fill('sell-2', 'sell', 2, 100n, 0n));
        assert.equal(markVirtualPosition(state, 100n).realizedPnlKopecks, -1n);
    });

    it('is idempotent for exact fills and rejects conflicts or shorting', () => {
        const initial = emptyVirtualPosition('paper-1', 'SBER', 10);
        const buy = fill('buy-1', 'buy', 1, 100n, 1n);
        const state = applyVirtualFillToPosition(initial, buy);
        assert.equal(applyVirtualFillToPosition(state, { ...buy }), state);
        assert.equal((state.appliedFills as unknown as { set?: unknown }).set, undefined);
        assert.throws(() => applyVirtualFillToPosition(state, { ...buy, feeKopecks: 2n }), /cash delta|ID conflict/);
        assert.throws(() => applyVirtualFillToPosition(initial, fill('sell-1', 'sell', 1, 100n, 0n)), /long-only/);
    });

    it('rejects malformed or non-reconciling fills', () => {
        const state = emptyVirtualPosition('paper-1', 'SBER', 10);
        assert.throws(() => applyVirtualFillToPosition(state, {
            ...fill('buy-1', 'buy', 1, 100n, 0n), grossAmountKopecks: 999n
        }), /gross amount/);
        assert.throws(() => markVirtualPosition(state, -1n), /non-negative/);
    });
});
