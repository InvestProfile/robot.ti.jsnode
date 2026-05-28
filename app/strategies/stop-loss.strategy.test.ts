import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert';
import { RobotConfig } from '../config/robot.config';
import MarketDataService from '../services/marketData.service';
import StopLossStrategy from './stop-loss.strategy';

const originalGetDailyCandles = MarketDataService.getDailyCandles;

const config = {
    stopLossPercent: 3,
    stopLossVolatilityDays: 14,
    stopLossVolatilityMultiplier: 1,
    stopLossMaxPercent: 8,
    maxLotsPerOrder: 10
} as unknown as RobotConfig;

afterEach(() => {
    (MarketDataService.getDailyCandles as unknown) = originalGetDailyCandles;
});

describe('StopLossStrategy', () => {
    it('widens effective stop when average daily range is higher than base stop', async () => {
        (MarketDataService.getDailyCandles as unknown) = async () => [
            { high: 110, low: 100, close: 100 },
            { high: 108, low: 100, close: 100 }
        ];

        const result = await StopLossStrategy.calculateEffectiveStop({
            accountId: 'acc-1',
            ticker: 'VOL',
            instrumentUid: 'uid-1'
        }, config);

        assert.strictEqual(result.averageDailyRangePercent, 9);
        assert.strictEqual(result.effectiveStopPercent, 8);
    });

    it('keeps base stop when volatility window is lower than base stop', async () => {
        (MarketDataService.getDailyCandles as unknown) = async () => [
            { high: 101, low: 100, close: 100 },
            { high: 102, low: 100, close: 100 }
        ];

        const result = await StopLossStrategy.calculateEffectiveStop({
            accountId: 'acc-1',
            ticker: 'QUIET',
            instrumentUid: 'uid-1'
        }, config);

        assert.strictEqual(result.averageDailyRangePercent, 1.5);
        assert.strictEqual(result.effectiveStopPercent, 3);
    });

    it('uses the same adaptive stop in sell signal evaluation', async () => {
        (MarketDataService.getDailyCandles as unknown) = async () => [
            { high: 105, low: 100, close: 100 },
            { high: 105, low: 100, close: 100 }
        ];

        const noSignal = await StopLossStrategy.evaluate({
            accountId: 'acc-1',
            ticker: 'VOL',
            instrumentUid: 'uid-1',
            averagePrice: 100,
            currentPrice: 96,
            quantityLots: 1
        }, config);
        assert.strictEqual(noSignal, undefined);

        const signal = await StopLossStrategy.evaluate({
            accountId: 'acc-1',
            ticker: 'VOL',
            instrumentUid: 'uid-1',
            averagePrice: 100,
            currentPrice: 94.9,
            quantityLots: 1
        }, config);
        assert.strictEqual(signal?.source, 'stop-loss');
        assert.match(signal?.reason ?? '', /adaptive stop 5.00%/);
    });
});
