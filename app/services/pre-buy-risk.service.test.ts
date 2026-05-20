import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert';
import { TradeDecisionModel } from '../models/trade-decision.model';
import { RobotConfig } from '../config/robot.config';
import PreBuyRiskService from './pre-buy-risk.service';

const originalCount = TradeDecisionModel.count;

const config = {
    liquidityRiskEnabled: false,
    liquidityRiskEnforced: false,
    sectorRiskEnabled: false,
    sectorRiskEnforced: false
} as unknown as RobotConfig;

const baseInput = {
    accountId: 'acc-1',
    instrumentUid: 'uid-1',
    ticker: 'SBER',
    lot: 1,
    estimatedOrderRub: 100,
    portfolioValueRub: 1_000,
    sectorValueRub: 0
};

afterEach(() => {
    (TradeDecisionModel.count as unknown) = originalCount;
});

describe('PreBuyRiskService', () => {
    it('blocks same-day re-entry after posted stop-loss for the same ticker', async () => {
        (TradeDecisionModel.count as unknown) = async () => 1;

        const result = await PreBuyRiskService.evaluate(baseInput, config);

        assert.strictEqual(result.passed, false);
        assert.ok(result.blockingReasons.some(reason => reason.includes('same-day re-entry blocked after stop-loss')));
        assert.ok(result.checks.some(check => check.key === 'same-day-stop-loss-reentry' && check.status === 'block'));
    });

    it('allows buy risk evaluation when no same-day stop-loss exists', async () => {
        (TradeDecisionModel.count as unknown) = async () => 0;

        const result = await PreBuyRiskService.evaluate(baseInput, config);

        assert.strictEqual(result.passed, true);
        assert.deepStrictEqual(result.blockingReasons, []);
    });
});
