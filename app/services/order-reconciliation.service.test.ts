import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { Op } from 'sequelize';
import { TradesModel } from '../models/trades.model';
import OrderReconciliationService from './order-reconciliation.service';

// Evaluate the Sequelize predicates against an in-memory fixture; no broker or DB calls.
const matches = (value: any, predicate: any): boolean => {
    if (predicate === null) return value == null;
    if (typeof predicate !== 'object') return value === predicate;
    return Reflect.ownKeys(predicate).every(key => {
        const expected = predicate[key];
        if (key === Op.and) return expected.every((p: any) => matches(value, p));
        if (key === Op.or) return expected.some((p: any) => matches(value, p));
        if (key === Op.ne) return !matches(value, expected);
        if (key === Op.notIn) return value != null && !expected.includes(value);
        if (key === Op.gt) return value > expected;
        if (key === Op.gte) return value >= expected;
        if (key === Op.lte) return value != null && value <= expected;
        assert.equal(typeof key, 'string', `Unsupported predicate ${String(key)}`);
        return matches(value?.[key], expected);
    });
};
const trade = (id: number, status: string, extra = {}) => ({
    id, status, accountId: 'test-account', orderId: `order-${id}`,
    createdAt: new Date('2020-01-01'), lotsExecuted: 2, executedPriceUnits: '100',
    ...extra
});
let rows: ReturnType<typeof trade>[];
let visited: number[];

beforeEach(async () => {
    rows = [];
    visited = [];
    mock.method(console, 'log', () => undefined);
    mock.method(console, 'error', () => undefined);
    mock.method(console, 'warn', () => undefined);
    mock.method(TradesModel, 'findAll', async (options: any) => {
        assert.deepEqual(options.order, [['id', 'ASC']]);
        assert.equal(options.limit, 40);
        return rows.filter(row => matches(row, options.where))
            .sort((a, b) => a.id - b.id).slice(0, options.limit)
            .map(row => ({ id: row.id, get: () => row }));
    });
    // An empty page resets the persisted in-process cursor between tests.
    await OrderReconciliationService.reconcileOpenOrders();
    mock.method(OrderReconciliationService, 'reconcileTrade', async (row: TradesModel) => {
        visited.push(row.id);
        return true;
    });
});
afterEach(() => mock.restoreAll());

describe('order reconciliation scheduling', () => {
    it('finds old unknown orders even with more than 40 newer completed orders', async () => {
        rows = [trade(1, 'LOCAL_SUBMIT_UNKNOWN'),
            ...Array.from({ length: 60 }, (_, i) => trade(i + 2, 'EXECUTION_REPORT_STATUS_FILL'))];
        await OrderReconciliationService.reconcileOpenOrders();
        assert.deepEqual(visited, [1]);
    });

    it('rotates bounded batches past persistent failures and returns to earlier orders', async () => {
        rows = Array.from({ length: 45 }, (_, i) => trade(i + 1, 'LOCAL_SUBMIT_UNKNOWN'));
        mock.method(OrderReconciliationService, 'reconcileTrade', async (row: TradesModel) => {
            visited.push(row.id);
            throw new Error('unresolved order');
        });
        await OrderReconciliationService.reconcileOpenOrders();
        assert.equal(visited.length, 40);
        await OrderReconciliationService.reconcileOpenOrders();
        assert.deepEqual(visited, rows.map(row => row.id));
        await OrderReconciliationService.reconcileOpenOrders();
        assert.equal(visited[45], 1);
    });

    it('continues after a rate-limit interruption without skipping unvisited rows', async () => {
        rows = Array.from({ length: 45 }, (_, i) => trade(i + 1, 'LOCAL_PENDING_SUBMIT'));
        mock.method(OrderReconciliationService, 'reconcileTrade', async (row: TradesModel) => {
            visited.push(row.id);
            if (row.id === 2) throw new Error('RESOURCE_EXHAUSTED');
            return true;
        });
        await OrderReconciliationService.reconcileOpenOrders();
        assert.deepEqual(visited, [1, 2]);
        await OrderReconciliationService.reconcileOpenOrders();
        assert.equal(visited[2], 3);
        assert.equal(visited.at(-1), 42);
    });

    it('repairs missing fill metadata without polling terminal zero-fill rejections', async () => {
        rows = [
            trade(1, 'EXECUTION_REPORT_STATUS_FILL', { lotsExecuted: 0 }),
            trade(2, 'EXECUTION_REPORT_STATUS_FILL', { executedPriceUnits: null, totalAmountUnits: null }),
            trade(3, 'LOCAL_POST_REJECTED', { lotsExecuted: 0 }),
            trade(4, 'EXECUTION_REPORT_STATUS_CANCELLED', { lotsExecuted: 0 })
        ];
        await OrderReconciliationService.reconcileOpenOrders();
        assert.deepEqual(visited, [1, 2]);
    });
});
