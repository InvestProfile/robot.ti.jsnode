import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert';
import { TradeDecisionModel } from '../models/trade-decision.model';
import { TradesModel } from '../models/trades.model';
import { RobotConfig } from '../config/robot.config';
import PreBuyRiskService from './pre-buy-risk.service';

const originalCount = TradeDecisionModel.count;
const originalFindAll = TradesModel.findAll;

const config = {
    buyAddOnMinProfitPercent: 1,
    liquidityRiskEnabled: false,
    liquidityRiskEnforced: false,
    sectorRiskEnabled: false,
    sectorRiskEnforced: false
} as unknown as RobotConfig;

const baseInput = {
    accountId: 'acc-1',
    figi: 'figi-1',
    instrumentUid: 'uid-1',
    ticker: 'SBER',
    lot: 1,
    currentPrice: 100,
    estimatedOrderRub: 100,
    portfolioValueRub: 1_000,
    sectorValueRub: 0
};

afterEach(() => {
    (TradeDecisionModel.count as unknown) = originalCount;
    (TradesModel.findAll as unknown) = originalFindAll;
});

const mockTrades = (trades: Record<string, unknown>[]) => {
    (TradesModel.findAll as unknown) = async () => trades.map(trade => ({
        get: () => trade
    }));
};

describe('PreBuyRiskService', () => {
    it('blocks same-day re-entry after posted stop-loss for the same ticker', async () => {
        (TradeDecisionModel.count as unknown) = async (_options: unknown) => {
            const where = (_options as { where?: Record<string, unknown> }).where ?? {};
            return where.signalSource === 'stop-loss' ? 1 : 0;
        };
        mockTrades([]);

        const result = await PreBuyRiskService.evaluate(baseInput, config);

        assert.strictEqual(result.passed, false);
        assert.ok(result.blockingReasons.some(reason => reason.includes('same-day re-entry blocked after stop-loss')));
        assert.ok(result.checks.some(check => check.key === 'same-day-stop-loss-reentry' && check.status === 'block'));
    });

    it('blocks same-day re-entry after rejected buy order for the same ticker', async () => {
        (TradeDecisionModel.count as unknown) = async (_options: unknown) => {
            const where = (_options as { where?: Record<string, unknown> }).where ?? {};
            return where.status === 'order-rejected' ? 1 : 0;
        };
        mockTrades([]);

        const result = await PreBuyRiskService.evaluate(baseInput, config);

        assert.strictEqual(result.passed, false);
        assert.ok(result.blockingReasons.some(reason => reason.includes('same-day re-entry blocked after rejected buy order')));
        assert.ok(result.checks.some(check => check.key === 'same-day-buy-rejected-reentry' && check.status === 'block'));
    });

    it('allows buy risk evaluation when no same-day stop-loss exists', async () => {
        (TradeDecisionModel.count as unknown) = async () => 0;
        mockTrades([]);

        const result = await PreBuyRiskService.evaluate(baseInput, config);

        assert.strictEqual(result.passed, true);
        assert.deepStrictEqual(result.blockingReasons, []);
    });

    it('blocks add-on buy when existing robot position is not profitable enough', async () => {
        (TradeDecisionModel.count as unknown) = async () => 0;
        mockTrades([{
            accountId: 'acc-1',
            figi: 'figi-1',
            instrumentId: 'uid-1',
            direction: '1',
            status: 'EXECUTION_REPORT_STATUS_FILL',
            lotsExecuted: 1,
            totalAmountUnits: '105',
            totalAmountNano: '0',
            createdAt: new Date()
        }]);

        const result = await PreBuyRiskService.evaluate(baseInput, config);

        assert.strictEqual(result.passed, false);
        assert.ok(result.blockingReasons.some(reason => reason.includes('add-on blocked')));
        assert.ok(result.checks.some(check => check.key === 'add-on-position-profit' && check.status === 'block'));
    });

    it('allows add-on buy when existing robot position is already working', async () => {
        (TradeDecisionModel.count as unknown) = async () => 0;
        mockTrades([{
            accountId: 'acc-1',
            figi: 'figi-1',
            instrumentId: 'uid-1',
            direction: '1',
            status: 'EXECUTION_REPORT_STATUS_FILL',
            lotsExecuted: 1,
            totalAmountUnits: '98',
            totalAmountNano: '0',
            createdAt: new Date()
        }]);

        const result = await PreBuyRiskService.evaluate(baseInput, config);

        assert.strictEqual(result.passed, true);
        assert.ok(result.checks.some(check => check.key === 'add-on-position-profit' && check.status === 'pass'));
    });
});
