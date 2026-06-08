import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert';
import { RobotConfig } from '../config/robot.config';
import MarketDataService from './marketData.service';
import ExitPolicyCandidateService from './exit-policy-candidate.service';

const originalGetDailyCandles = MarketDataService.getDailyCandles;

const config = {
    stopLossPercent: 3,
    stopLossVolatilityDays: 14,
    stopLossVolatilityMultiplier: 1,
    stopLossMaxPercent: 8
} as unknown as RobotConfig;

const input = {
    accountId: 'acc-1',
    ticker: 'TEST',
    instrumentUid: 'uid-1',
    averagePrice: 100,
    currentPrice: 96.5,
    quantityLots: 1
};

afterEach(() => {
    (MarketDataService.getDailyCandles as unknown) = originalGetDailyCandles;
});

describe('ExitPolicyCandidateService', () => {
    it('marks current stop-loss sell as candidate hold when ATR x2 stop is wider', async () => {
        (MarketDataService.getDailyCandles as unknown) = async () => [
            { high: 102, low: 100, close: 100 },
            { high: 102, low: 100, close: 100 }
        ];

        const result = await ExitPolicyCandidateService.evaluate(input, config, {
            action: 'sell',
            source: 'stop-loss',
            confidence: 1,
            reason: 'current stop-loss',
            quantityLots: 1,
            profitPercent: -3.5
        });

        assert.strictEqual(result.status, 'would-hold');
        assert.strictEqual(result.action, 'hold');
        assert.strictEqual(result.currentStopPercent, 3);
        assert.strictEqual(result.candidateStopPercent, 4);
        assert.match(result.reason, /observe-only/);
    });

    it('marks same sell when current and candidate policies both exit', async () => {
        (MarketDataService.getDailyCandles as unknown) = async () => [
            { high: 102, low: 100, close: 100 },
            { high: 102, low: 100, close: 100 }
        ];

        const result = await ExitPolicyCandidateService.evaluate({
            ...input,
            currentPrice: 95.5
        }, config, {
            action: 'sell',
            source: 'stop-loss',
            confidence: 1,
            reason: 'current stop-loss',
            quantityLots: 1,
            profitPercent: -4.5
        });

        assert.strictEqual(result.status, 'same-sell');
        assert.strictEqual(result.action, 'sell');
        assert.strictEqual(result.candidateStopPercent, 4);
    });

    it('marks candidate-only sell when current policy holds but ATR x2 stop is breached', async () => {
        (MarketDataService.getDailyCandles as unknown) = async () => [
            { high: 101, low: 99, close: 100 },
            { high: 101, low: 99, close: 100 }
        ];

        const result = await ExitPolicyCandidateService.evaluate({
            ...input,
            currentPrice: 95.5
        }, config);

        assert.strictEqual(result.status, 'would-sell');
        assert.strictEqual(result.action, 'sell');
        assert.strictEqual(result.candidateStopPercent, 4);
    });

    it('does not compare non-stop-loss sell signals against the stop candidate', async () => {
        (MarketDataService.getDailyCandles as unknown) = async () => [
            { high: 102, low: 100, close: 100 },
            { high: 102, low: 100, close: 100 }
        ];

        const result = await ExitPolicyCandidateService.evaluate({
            ...input,
            currentPrice: 105
        }, config, {
            action: 'sell',
            source: 'profit-take',
            confidence: 1,
            reason: 'take profit',
            quantityLots: 1,
            profitPercent: 5
        });

        assert.strictEqual(result.status, 'not-applicable');
        assert.strictEqual(result.action, 'unknown');
        assert.match(result.reason, /stop-loss exits only/);
    });
});
