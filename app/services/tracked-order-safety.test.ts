import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { submitTrackedOrder } from '../modules/common.module';
import { RobotConfig } from '../config/robot.config';
import { TradesModel } from '../models/trades.model';
import OrdersService from './orders.service';
import TradesService from './trades.service';
import PositionStateService from './position-state.service';
import ProtectiveStopService from './protective-stop.service';
import RobotPositionLedgerService from './robot-position-ledger.service';
import OrderReconciliationService from './order-reconciliation.service';
import StopLossStrategy from '../strategies/stop-loss.strategy';

const config = {
    dryRun: false, tradingPaused: false, liveAllowedActions: ['buy', 'sell'],
    buyOrderType: 'limit', sellOrderType: 'limit', protectiveStopsEnabled: true
} as RobotConfig;
const input = {
    config, accountId: 'test-account', side: 'buy' as const, quantityLots: 2,
    lot: 10, price: { units: 100, nano: 0 }, figi: 'test-figi', instrumentUid: 'test-uid'
};
let row: Record<string, unknown>;
const postResult = (status = 'EXECUTION_REPORT_STATUS_FILL', lotsExecuted = 2) => ({
    orderId: 'broker-order', executionReportStatus: status, lotsRequested: 2, lotsExecuted,
    executedOrderPrice: { units: 100, nano: 0 }
});

beforeEach(() => {
    row = {};
    mock.method(console, 'log', () => undefined);
    mock.method(console, 'error', () => undefined);
    mock.method(TradesModel, 'create', async (values: Record<string, unknown>) => {
        row = { ...values };
        return {
            ...values,
            get: () => row,
            update: async (patch: Record<string, unknown>) => Object.assign(row, patch)
        };
    });
    mock.method(OrdersService, 'postOrder', async () => postResult());
    mock.method(PositionStateService, 'resetHighWaterMark', async () => undefined);
    mock.method(StopLossStrategy, 'calculateEffectiveStop', async () => ({ effectiveStopPercent: 3 }));
    mock.method(ProtectiveStopService, 'placeStopLoss', async () => ({ skipped: false }));
    mock.method(RobotPositionLedgerService, 'getLedger', async () => ({ items: [] }));
});
afterEach(() => mock.restoreAll());

describe('tracked order execution and protection', () => {
    it('preserves a filled buy when its protective stop is rejected', async () => {
        mock.method(ProtectiveStopService, 'placeStopLoss', async () => {
            throw new Error('INVALID_ARGUMENT: 30099');
        });
        const result = await submitTrackedOrder(input);
        assert.equal(result.unknown, false);
        assert.equal(row.status, 'EXECUTION_REPORT_STATUS_FILL');
        assert.equal(row.lotsExecuted, 2);
        assert.equal(row.orderId, 'broker-order');
    });

    it('stores instrument lot size and computes the correct fallback trade amount', async () => {
        await submitTrackedOrder(input);
        assert.equal(row.lot, 10);
        assert.equal(row.lotsRequested, 2);
        assert.equal(TradesService.amountFromTrade(row), 2000);
    });

    for (const [status, executed] of [
        ['EXECUTION_REPORT_STATUS_NEW', 0],
        ['EXECUTION_REPORT_STATUS_PARTIALLYFILL', 1]
    ] as const) {
        it(`keeps protective stops for ${status}`, async () => {
            mock.method(OrdersService, 'postOrder', async () => postResult(status, executed));
            const cancel = mock.method(ProtectiveStopService, 'cancelActiveSellStopsForInstrument', async () => ({ cancelled: 1, failed: 0 }));
            await submitTrackedOrder({ ...input, side: 'sell' });
            assert.equal(cancel.mock.callCount(), 0);
        });
    }

    it('keeps protection when a filled sell leaves robot-owned lots', async () => {
        mock.method(RobotPositionLedgerService, 'getLedger', async () => ({ items: [
            { accountId: input.accountId, instrumentUid: input.instrumentUid, lots: 3 }
        ] }));
        const cancel = mock.method(ProtectiveStopService, 'cancelActiveSellStopsForInstrument', async () => ({ cancelled: 1, failed: 0 }));
        await submitTrackedOrder({ ...input, side: 'sell' });
        assert.equal(cancel.mock.callCount(), 0);
    });

    it('cancels protection after a filled sell closes the robot position', async () => {
        const cancel = mock.method(ProtectiveStopService, 'cancelActiveSellStopsForInstrument', async () => ({ cancelled: 1, failed: 0 }));
        await submitTrackedOrder({ ...input, side: 'sell' });
        assert.equal(cancel.mock.callCount(), 1);
    });

    it('reconciles metadata persistence errors instead of rejecting an accepted buy', async () => {
        mock.method(TradesService, 'updateOrderMetadata', async () => { throw new Error('FAILED_PRECONDITION'); });
        const reconcile = mock.method(OrderReconciliationService, 'reconcileTrade', async () => true);
        const result = await submitTrackedOrder(input);
        assert.equal(result.reconciled, true);
        assert.equal(reconcile.mock.callCount(), 1);
        assert.notEqual(row.status, 'LOCAL_POST_REJECTED');
    });

    it('still records broker rejection of the original order', async () => {
        mock.method(OrdersService, 'postOrder', async () => { throw new Error('INVALID_ARGUMENT'); });
        const result = await submitTrackedOrder(input);
        assert.equal(result.rejected, true);
        assert.equal(row.status, 'LOCAL_POST_REJECTED');
        assert.equal(row.lotsExecuted, 0);
    });
});
