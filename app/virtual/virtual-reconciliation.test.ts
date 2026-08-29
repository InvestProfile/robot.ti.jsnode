import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { VirtualFill } from './execution';
import { replayVirtualLedger } from './ledger';
import { reconcileVirtualAccount } from './reconciliation';
import type { VirtualLedgerEvent } from './types';

const at = '2026-08-29T10:00:00Z';
const fill = (
    id: string, orderId: string, side: 'buy' | 'sell', lots: number,
    price: bigint, fee: bigint
): VirtualFill => {
    const gross = price * 10n * BigInt(lots);
    return {
        id, orderId, virtualAccountId: 'paper-1', instrumentId: 'SBER', side,
        quantityLots: lots, lotSize: 10, referencePriceKopecks: price,
        executionPriceKopecks: price, grossAmountKopecks: gross, feeKopecks: fee,
        netCashDeltaKopecks: side === 'buy' ? -(gross + fee) : gross - fee,
        filledAt: at
    };
};
const opened: VirtualLedgerEvent = {
    id: 'open', virtualAccountId: 'paper-1', occurredAt: at,
    kind: 'account-opened', amountKopecks: 10_000n
};
const entriesFor = (value: VirtualFill): VirtualLedgerEvent[] => [
    {
        id: `${value.orderId}:cash`, virtualAccountId: 'paper-1', occurredAt: at,
        kind: 'trade-cash', amountKopecks: value.grossAmountKopecks,
        direction: value.side === 'buy' ? 'debit' : 'credit', tradeReference: value.id
    },
    ...(value.feeKopecks > 0n ? [{
        id: `${value.orderId}:fee`, virtualAccountId: 'paper-1', occurredAt: at,
        kind: 'fee' as const, amountKopecks: value.feeKopecks, reason: `execution fee for ${value.id}`
    }] : [])
];

describe('virtual account reconciliation', () => {
    it('reconciles cash plus an open FIFO position to contributions plus net P/L', () => {
        const buy = fill('fill-buy', 'buy-1', 'buy', 2, 100n, 10n);
        const account = replayVirtualLedger([opened, ...entriesFor(buy)]);
        assert.deepEqual(reconcileVirtualAccount(account, [buy], [
            { instrumentId: 'SBER', priceKopecks: 110n }
        ]), {
            cashKopecks: 7_990n,
            positionsValueKopecks: 2_200n,
            equityKopecks: 10_190n,
            contributionsKopecks: 10_000n,
            interestKopecks: 0n,
            realizedPnlKopecks: 0n,
            unrealizedPnlKopecks: 190n,
            feesKopecks: 10n,
            turnoverKopecks: 2_000n,
            fillCount: 1,
            openPositionCount: 1
        });
    });

    it('reconciles a closed FIFO round trip net of both fees', () => {
        const buy = fill('fill-buy', 'buy-1', 'buy', 1, 100n, 10n);
        const sell = fill('fill-sell', 'sell-1', 'sell', 1, 120n, 5n);
        const account = replayVirtualLedger([
            opened, ...entriesFor(buy), ...entriesFor(sell)
        ]);
        const result = reconcileVirtualAccount(account, [buy, sell], []);
        assert.equal(result.equityKopecks, 10_185n);
        assert.equal(result.realizedPnlKopecks, 185n);
        assert.equal(result.unrealizedPnlKopecks, 0n);
    });

    it('fails on missing marks, mismatched ledger cash, and orphan trades', () => {
        const buy = fill('fill-buy', 'buy-1', 'buy', 1, 100n, 10n);
        const validEntries = [opened, ...entriesFor(buy)];
        assert.throws(() => reconcileVirtualAccount(
            replayVirtualLedger(validEntries), [buy], []
        ), /missing position mark/);
        const wrongCash = validEntries.map(entry => entry.id === 'buy-1:cash'
            ? { ...entry, amountKopecks: 999n } as VirtualLedgerEvent
            : entry);
        assert.throws(() => reconcileVirtualAccount(
            replayVirtualLedger(wrongCash), [buy], [{ instrumentId: 'SBER', priceKopecks: 100n }]
        ), /cash ledger mismatch/);
        assert.throws(() => reconcileVirtualAccount(
            replayVirtualLedger(validEntries), [], []
        ), /orphan trade cash/);
    });
});
