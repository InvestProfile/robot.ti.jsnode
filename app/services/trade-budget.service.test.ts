import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import TradeBudgetService from './trade-budget.service';
import { RobotConfig } from '../config/robot.config';

const baseConfig = {
    maxOrderRub: 5_000,
    maxDailyOrders: 30,
    maxDailyRub: 50_000,
    maxPositionSharePercent: 20,
    minDiversificationPositions: 5,
    diversificationFirst: true,
    stopLossPercent: 3,
    trailingStopPercent: 2
} as RobotConfig;

describe('TradeBudgetService', () => {
    it('blocks buy when daily RUB budget would be exceeded', () => {
        const result = TradeBudgetService.evaluateBuy({
            availableCashRub: 100_000,
            dailyOrdersCount: 2,
            dailyOrdersRub: 49_000,
            estimatedOrderRub: 2_000
        }, baseConfig);

        assert.equal(result.allowed, false);
        assert.equal(result.reason, 'daily RUB limit reached');
    });

    it('treats zero order and daily limits as unlimited', () => {
        const result = TradeBudgetService.evaluateBuy({
            availableCashRub: 100_000,
            dailyOrdersCount: 999,
            dailyOrdersRub: 999_000,
            estimatedOrderRub: 20_000,
            requestedLots: 2,
            lotRub: 10_000,
            portfolioValueRub: 200_000,
            positionValueRub: 0
        }, {
            ...baseConfig,
            maxOrderRub: 0,
            maxDailyOrders: 0,
            maxDailyRub: 0,
            maxLotsPerOrder: 10
        });

        assert.equal(result.allowed, true);
        assert.equal(result.quantityLots, 2);
        assert.equal(result.estimatedOrderRub, 20_000);
    });

    it('blocks buy when projected ticker position exceeds portfolio share limit', () => {
        const result = TradeBudgetService.evaluateBuy({
            availableCashRub: 100_000,
            dailyOrdersCount: 2,
            dailyOrdersRub: 10_000,
            estimatedOrderRub: 5_000,
            portfolioValueRub: 20_000,
            positionValueRub: 0
        }, baseConfig);

        assert.equal(result.allowed, false);
        assert.match(result.reason, /position concentration limit/);
        assert.equal(result.maxPositionRub, 4_000);
        assert.equal(result.projectedPositionSharePercent, 25);
    });

    it('resizes multi-lot buy to the available cash and position budget', () => {
        const result = TradeBudgetService.evaluateBuy({
            availableCashRub: 2_500,
            dailyOrdersCount: 2,
            dailyOrdersRub: 10_000,
            estimatedOrderRub: 5_000,
            requestedLots: 5,
            lotRub: 1_000,
            portfolioValueRub: 20_000,
            positionValueRub: 1_500
        }, {
            ...baseConfig,
            maxLotsPerOrder: 10
        });

        assert.equal(result.allowed, true);
        assert.equal(result.quantityLots, 2);
        assert.equal(result.estimatedOrderRub, 2_000);
        assert.equal(result.reason, 'trade budget resized: 2/5 lots');
    });

    it('resizes buy when adaptive stop would make the RUB risk too large', () => {
        const result = TradeBudgetService.evaluateBuy({
            availableCashRub: 100_000,
            dailyOrdersCount: 2,
            dailyOrdersRub: 10_000,
            estimatedOrderRub: 5_000,
            requestedLots: 5,
            lotRub: 1_000,
            riskStopPercent: 6,
            portfolioValueRub: 100_000,
            positionValueRub: 0
        }, {
            ...baseConfig,
            maxLotsPerOrder: 10
        });

        assert.equal(result.allowed, true);
        assert.equal(result.quantityLots, 2);
        assert.equal(result.estimatedOrderRub, 2_000);
        assert.equal(result.maxRiskAdjustedOrderRub, 2_500);
        assert.equal(result.riskStopPercent, 6);
        assert.equal(result.reason, 'trade budget resized: 2/5 lots, risk stop 6.00%');
    });

    it('blocks buy when one lot is too large for volatility-adjusted risk budget', () => {
        const result = TradeBudgetService.evaluateBuy({
            availableCashRub: 100_000,
            dailyOrdersCount: 2,
            dailyOrdersRub: 10_000,
            estimatedOrderRub: 3_000,
            requestedLots: 1,
            lotRub: 3_000,
            riskStopPercent: 8,
            portfolioValueRub: 100_000,
            positionValueRub: 0
        }, baseConfig);

        assert.equal(result.allowed, false);
        assert.match(result.reason, /risk budget limit reached/);
        assert.equal(result.maxRiskAdjustedOrderRub, 1_875);
        assert.equal(result.riskStopPercent, 8);
    });

    it('builds one account budget payload from the same risk inputs', () => {
        const budget = TradeBudgetService.buildAccountBudget(baseConfig, {
            totalRub: 20_000,
            cashRub: 10_000
        });

        assert.equal(budget.dailyExposureRub, 50_000);
        assert.equal(budget.stopLossRiskRub, 1_500);
        assert.equal(budget.baseTrailingGivebackRub, 1_000);
        assert.equal(budget.maxPositionRub, 4_000);
        assert.equal(budget.dailyExposurePortfolioPercent, 250);
        assert.equal(budget.cashUsagePercent, 500);
    });
});
