import { describe, it } from 'node:test';
import assert from 'node:assert';
import { isFinalOrderStatus, isIgnoredAccountingOrderStatus, isOpenOrderStatus, isRejectedOrderStatus } from './order-status';

describe('order-status helpers', () => {
    it('treats local rejected statuses as final and rejected', () => {
        for (const status of ['LOCAL_POST_REJECTED', 'LOCAL_VALIDATION_FAILED']) {
            assert.strictEqual(isFinalOrderStatus(status), true);
            assert.strictEqual(isRejectedOrderStatus(status), true);
        }
    });

    it('does not treat unknown submit state as final or rejected', () => {
        assert.strictEqual(isFinalOrderStatus('LOCAL_SUBMIT_UNKNOWN'), false);
        assert.strictEqual(isRejectedOrderStatus('LOCAL_SUBMIT_UNKNOWN'), false);
    });

    it('marks local unknown and pending statuses as open but ignored by accounting', () => {
        for (const status of ['LOCAL_PENDING_SUBMIT', 'LOCAL_SUBMIT_UNKNOWN', 'EXECUTION_REPORT_STATUS_NEW']) {
            assert.strictEqual(isOpenOrderStatus(status), true);
            assert.strictEqual(isIgnoredAccountingOrderStatus(status), true);
        }
    });

    it('marks rejected statuses as ignored by accounting', () => {
        for (const status of ['EXECUTION_REPORT_STATUS_REJECTED', 'EXECUTION_REPORT_STATUS_CANCELLED', 'LOCAL_POST_REJECTED']) {
            assert.strictEqual(isIgnoredAccountingOrderStatus(status), true);
        }
    });

    it('keeps filled orders eligible for accounting', () => {
        assert.strictEqual(isIgnoredAccountingOrderStatus('EXECUTION_REPORT_STATUS_FILL'), false);
    });
});
