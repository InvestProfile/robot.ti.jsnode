import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { VirtualFill } from '../virtual/execution';
import { replayVirtualLedger } from '../virtual/ledger';
import { InMemoryVirtualPositionRepository } from '../virtual/position-repository';
import type { VirtualLedgerEvent } from '../virtual/types';
import { VirtualReconciliationService } from './virtual-reconciliation.service';

const at = '2026-08-29T10:00:00Z';
const fill: VirtualFill = {
    id: 'fill-1', orderId: 'order-1', virtualAccountId: 'paper-1', instrumentId: 'SBER',
    side: 'buy', quantityLots: 1, lotSize: 10, referencePriceKopecks: 100n,
    executionPriceKopecks: 100n, grossAmountKopecks: 1_000n, feeKopecks: 5n,
    netCashDeltaKopecks: -1_005n, filledAt: at
};
const events: VirtualLedgerEvent[] = [
    { id: 'open', virtualAccountId: 'paper-1', occurredAt: at, kind: 'account-opened', amountKopecks: 10_000n },
    {
        id: 'order-1:cash', virtualAccountId: 'paper-1', occurredAt: at, kind: 'trade-cash',
        amountKopecks: 1_000n, direction: 'debit', tradeReference: 'fill-1'
    },
    {
        id: 'order-1:fee', virtualAccountId: 'paper-1', occurredAt: at, kind: 'fee',
        amountKopecks: 5n, reason: 'execution fee for fill-1'
    }
];

describe('read-only virtual reconciliation service', () => {
    it('loads independent repositories and requests marks only for open positions', async () => {
        const requested: string[][] = [];
        const service = new VirtualReconciliationService(
            { async load() { return replayVirtualLedger(events); } },
            new InMemoryVirtualPositionRepository([fill]),
            {
                async getMarks(accountId, instrumentIds) {
                    assert.equal(accountId, 'paper-1');
                    requested.push([...instrumentIds]);
                    return [{ instrumentId: 'SBER', priceKopecks: 110n }];
                }
            }
        );
        const result = await service.load('paper-1');
        assert.deepEqual(requested, [['SBER']]);
        assert.equal(result.equityKopecks, 10_095n);
        assert.equal(result.feesKopecks, 5n);
        assert.equal(result.turnoverKopecks, 1_000n);
        assert.equal(result.fillCount, 1);
        assert.equal(result.openPositionCount, 1);
    });

    it('propagates reconciliation failure instead of returning partial metrics', async () => {
        const service = new VirtualReconciliationService(
            { async load() { return replayVirtualLedger(events); } },
            new InMemoryVirtualPositionRepository([fill]),
            { async getMarks() { return []; } }
        );
        await assert.rejects(service.load('paper-1'), /missing position mark/);
    });
});
