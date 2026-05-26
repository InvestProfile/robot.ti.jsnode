import { describe, it } from 'node:test';
import assert from 'node:assert';
import { RobotConfig } from '../config/robot.config';
import ScoreBuyStrategy from './score-buy.strategy';

const candles = Array.from({ length: 20 }, () => ({
    close: 100,
    high: 102,
    low: 99,
    volume: 1_000
}));

const config = {
    buyTickers: ['SBER'],
    enabledStrategies: ['score-buy'],
    buyTrendDays: 20,
    buyMinScore: 70,
    buyNegativeTechScoreBuffer: 10,
    maxOrderRub: 10_000
} as unknown as RobotConfig;

const input = {
    accountId: 'acc-1',
    figi: 'figi-1',
    instrumentUid: 'uid-1',
    ticker: 'SBER',
    lot: 1,
    lastPrice: 103,
    availableCashRub: 10_000,
    alreadyInPortfolio: false,
    dailyCandles: candles,
    analystScoreAdjustment: 5,
    technicalReason: 'MACD bearish'
};

describe('ScoreBuyStrategy', () => {
    it('requires a higher score when technical adjustment is negative', () => {
        const analysis = ScoreBuyStrategy.analyze({
            ...input,
            technicalScoreAdjustment: -2
        }, config);

        assert.ok(analysis);
        assert.strictEqual(analysis.passed, false);
        assert.ok(analysis.reason.includes('negative tech gate'));
        assert.strictEqual(analysis.factors.negativeTechRequiredScore, 80);
    });

    it('allows the same score when technical adjustment is not negative', () => {
        const analysis = ScoreBuyStrategy.analyze({
            ...input,
            technicalScoreAdjustment: 0
        }, config);

        assert.ok(analysis);
        assert.strictEqual(analysis.passed, true);
    });
});
