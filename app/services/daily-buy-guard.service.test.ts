import { describe, it } from 'node:test';
import assert from 'node:assert';
import { moscowTradingDate, summarizeDailyBuyGuard } from './daily-buy-guard.service';

describe('DailyBuyGuardService', () => {
    it('blocks after the configured stop cascade', () => {
        const result = summarizeDailyBuyGuard({
            accountId: 'acc-1',
            now: new Date('2026-08-13T12:00:00Z'),
            maxStopExits: 3,
            maxNetLossRub: 150,
            roundTrips: [
                { accountId: 'acc-1', exitAt: '2026-08-13T06:00:00Z', exitSignalSource: 'broker-stop-loss', netPnlRub: -20 },
                { accountId: 'acc-1', exitAt: '2026-08-13T07:00:00Z', exitSignalSource: 'stop-loss', netPnlRub: -30 },
                { accountId: 'acc-1', exitAt: '2026-08-13T08:00:00Z', exitSignalSource: 'broker-stop-loss', netPnlRub: -40 }
            ]
        });
        assert.strictEqual(result.blockedByStopCascade, true);
        assert.match(result.reason, /stop exits 3\/3/);
    });

    it('blocks after the configured daily net loss', () => {
        const result = summarizeDailyBuyGuard({
            accountId: 'acc-1',
            now: new Date('2026-08-13T12:00:00Z'),
            maxStopExits: 5,
            maxNetLossRub: 150,
            roundTrips: [
                { accountId: 'acc-1', exitAt: '2026-08-13T08:00:00Z', exitSignalSource: 'profit-take', netPnlRub: 25 },
                { accountId: 'acc-1', exitAt: '2026-08-13T09:00:00Z', exitSignalSource: 'broker-stop-loss', netPnlRub: -180 }
            ]
        });
        assert.strictEqual(result.blockedByDailyLoss, true);
        assert.strictEqual(result.realizedNetPnlRub, -155);
    });

    it('resets on the next Moscow trading date', () => {
        const rows = [{ accountId: 'acc-1', exitAt: '2026-08-13T20:59:59Z', exitSignalSource: 'broker-stop-loss', netPnlRub: -200 }];
        const before = summarizeDailyBuyGuard({ accountId: 'acc-1', now: new Date('2026-08-13T20:59:59Z'), maxStopExits: 1, maxNetLossRub: 150, roundTrips: rows });
        const after = summarizeDailyBuyGuard({ accountId: 'acc-1', now: new Date('2026-08-13T21:00:00Z'), maxStopExits: 1, maxNetLossRub: 150, roundTrips: rows });
        assert.strictEqual(moscowTradingDate('2026-08-13T21:00:00Z'), '2026-08-14');
        assert.strictEqual(before.blocked, true);
        assert.strictEqual(after.blocked, false);
    });
});
