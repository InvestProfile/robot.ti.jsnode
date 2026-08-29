import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { VirtualFill } from './execution';
import {
    InMemoryVirtualPositionRepository,
    replayVirtualPositions
} from './position-repository';
import { markVirtualPosition } from './positions';

const fill = (id: string, account = 'paper-1'): VirtualFill => ({
    id, orderId: `order-${id}`, virtualAccountId: account, instrumentId: 'SBER',
    side: 'buy', quantityLots: 1, lotSize: 10, referencePriceKopecks: 100n,
    executionPriceKopecks: 100n, grossAmountKopecks: 1_000n, feeKopecks: 1n,
    netCashDeltaKopecks: -1_001n, filledAt: '2026-08-29T10:00:00Z'
});

describe('restart-safe virtual position repository', () => {
    it('replays canonical fills into the same FIFO state after restart-style load', async () => {
        const stored = [fill('fill-1'), {
            ...fill('fill-2'), side: 'sell' as const, grossAmountKopecks: 1_000n,
            feeKopecks: 0n, netCashDeltaKopecks: 1_000n
        }];
        const first = replayVirtualPositions('paper-1', stored);
        const restarted = await new InMemoryVirtualPositionRepository(
            stored.map(item => ({ ...item }))
        ).load('paper-1');
        assert.deepEqual(
            restarted.positions.map(position => markVirtualPosition(position, 100n)),
            first.positions.map(position => markVirtualPosition(position, 100n))
        );
        assert.equal(restarted.fills.length, 2);
        assert.equal(restarted.fills[0].filledAt, '2026-08-29T10:00:00.000Z');
    });

    it('isolates accounts and rejects cross-account replay', async () => {
        const repository = new InMemoryVirtualPositionRepository([fill('one'), fill('two', 'paper-2')]);
        assert.equal((await repository.load('paper-1')).fills.length, 1);
        assert.equal((await repository.load('paper-2')).fills.length, 1);
        assert.throws(() => replayVirtualPositions('paper-1', [fill('wrong', 'paper-2')]), /multiple/);
    });

    it('deduplicates an exact fill retry and rejects a changed retry', () => {
        const same = fill('same');
        const portfolio = replayVirtualPositions('paper-1', [same, { ...same }]);
        assert.equal(portfolio.fills.length, 1);
        assert.throws(() => replayVirtualPositions('paper-1', [
            same,
            { ...same, feeKopecks: 2n, netCashDeltaKopecks: -1_002n }
        ]), /ID conflict/);
    });
});
