import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert';
import { TradeDecisionModel } from '../models/trade-decision.model';
import { TradesModel } from '../models/trades.model';
import { RobotConfig } from '../config/robot.config';
import PreBuyRiskService from './pre-buy-risk.service';
import ProtectiveStopService from './protective-stop.service';

const originalCount = TradeDecisionModel.count;
const originalFindAll = TradesModel.findAll;
const originalGetLastFailure = ProtectiveStopService.getLastFailure;

const config = {
    buyAddOnMinProfitPercent: 1,
    buyReentryAfterSellMinGainPercent: 1,
    liquidityRiskEnabled: false,
    liquidityRiskEnforced: false,
    sectorRiskEnabled: false,
    sectorRiskEnforced: false,
    sectorPerformanceRiskEnabled: false,
    sectorPerformanceRiskEnforced: false,
    sectorPerformanceMinClosed: 5,
    sectorPerformanceMinWinRatePercent: 35,
    sectorPerformanceMinPnlRub: -50,
    buyLossGuardEnabled: false,
    buyLossGuardEnforced: false,
    buyLossGuardScoreBuffer: 10,
    buyLossGuardMinClosed: 3,
    buyLossGuardMinLosses: 2,
    buyLossGuardMinPnlRub: -30,
    buyLossGuardMinWinRatePercent: 35
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
    (ProtectiveStopService.getLastFailure as unknown) = originalGetLastFailure;
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

    it('blocks buy when broker recently rejected protective stop for the instrument', async () => {
        (TradeDecisionModel.count as unknown) = async () => 0;
        (ProtectiveStopService.getLastFailure as unknown) = () => ({
            failedAt: new Date().toISOString(),
            reason: 'PostStopOrder INVALID_ARGUMENT: 30099',
            cooldownLeftMs: 1000
        });
        mockTrades([]);

        const result = await PreBuyRiskService.evaluate(baseInput, config);

        assert.strictEqual(result.passed, false);
        assert.ok(result.blockingReasons.some(reason => reason.includes('broker rejected protective stop')));
        assert.ok(result.checks.some(check => check.key === 'protective-stop-broker-rejected' && check.status === 'block'));
    });

    it('blocks same-day re-entry after sell until price confirms above last exit', async () => {
        (TradeDecisionModel.count as unknown) = async () => 0;
        mockTrades([{
            accountId: 'acc-1',
            figi: 'figi-1',
            instrumentId: 'uid-1',
            ticker: 'SBER',
            direction: '2',
            status: 'EXECUTION_REPORT_STATUS_FILL',
            lotsExecuted: 1,
            totalAmountUnits: '100',
            totalAmountNano: '0',
            createdAt: new Date()
        }]);

        const result = await PreBuyRiskService.evaluate(baseInput, config);

        assert.strictEqual(result.passed, false);
        assert.ok(result.blockingReasons.some(reason => reason.includes('re-entry blocked after same-day sell')));
        assert.ok(result.checks.some(check => check.key === 'post-sell-price-confirmation' && check.status === 'block'));
    });

    it('allows same-day re-entry after sell when price moves far enough above exit', async () => {
        (TradeDecisionModel.count as unknown) = async () => 0;
        mockTrades([{
            accountId: 'acc-1',
            figi: 'figi-1',
            instrumentId: 'uid-1',
            ticker: 'SBER',
            direction: '2',
            status: 'EXECUTION_REPORT_STATUS_FILL',
            lotsExecuted: 1,
            totalAmountUnits: '98',
            totalAmountNano: '0',
            createdAt: new Date()
        }]);

        const result = await PreBuyRiskService.evaluate(baseInput, config);

        assert.strictEqual(result.passed, true);
        assert.ok(result.checks.some(check => check.key === 'post-sell-price-confirmation' && check.status === 'pass'));
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

    it('blocks same-day add-on until price confirms above the latest buy', async () => {
        (TradeDecisionModel.count as unknown) = async () => 0;
        mockTrades([{
            accountId: 'acc-1',
            figi: 'figi-1',
            instrumentId: 'uid-1',
            direction: '1',
            status: 'EXECUTION_REPORT_STATUS_FILL',
            lotsExecuted: 1,
            totalAmountUnits: '100',
            totalAmountNano: '0',
            createdAt: new Date()
        }]);

        const result = await PreBuyRiskService.evaluate({
            ...baseInput,
            currentPrice: 100.5
        }, config);

        assert.strictEqual(result.passed, false);
        assert.ok(result.blockingReasons.some(reason => reason.includes('same-day add-on blocked')));
        assert.ok(result.checks.some(check => check.key === 'same-day-buy-price-confirmation' && check.status === 'block'));
    });

    it('allows same-day add-on when price confirms above the latest buy', async () => {
        (TradeDecisionModel.count as unknown) = async () => 0;
        mockTrades([{
            accountId: 'acc-1',
            figi: 'figi-1',
            instrumentId: 'uid-1',
            direction: '1',
            status: 'EXECUTION_REPORT_STATUS_FILL',
            lotsExecuted: 1,
            totalAmountUnits: '100',
            totalAmountNano: '0',
            createdAt: new Date()
        }]);

        const result = await PreBuyRiskService.evaluate({
            ...baseInput,
            currentPrice: 101.5
        }, config);

        assert.strictEqual(result.passed, true);
        assert.ok(result.checks.some(check => check.key === 'same-day-buy-price-confirmation' && check.status === 'pass'));
    });

    it('blocks hot same-day momentum when price is already near the recent high', async () => {
        (TradeDecisionModel.count as unknown) = async () => 0;
        mockTrades([]);

        const result = await PreBuyRiskService.evaluate({
            ...baseInput,
            currentPrice: 104,
            dailyCandles: [
                { close: 98, high: 100, low: 97, volume: 1000 },
                { close: 100, high: 104.5, low: 99, volume: 1000 }
            ]
        }, {
            ...config,
            buyAntiFomoEnabled: true,
            buyAntiFomoEnforced: true,
            buyAntiFomoMaxMomentumPercent: 3,
            buyAntiFomoMinBelowHighPercent: 1
        } as RobotConfig);

        assert.strictEqual(result.passed, false);
        assert.ok(result.blockingReasons.some(reason => reason.includes('anti-FOMO')));
        assert.ok(result.checks.some(check => check.key === 'anti-fomo' && check.status === 'block' && check.enforced));
    });

    it('allows momentum when price is not too close to the recent high', async () => {
        (TradeDecisionModel.count as unknown) = async () => 0;
        mockTrades([]);

        const result = await PreBuyRiskService.evaluate({
            ...baseInput,
            currentPrice: 103,
            dailyCandles: [
                { close: 98, high: 100, low: 97, volume: 1000 },
                { close: 100, high: 108, low: 99, volume: 1000 }
            ]
        }, {
            ...config,
            buyAntiFomoEnabled: true,
            buyAntiFomoEnforced: true,
            buyAntiFomoMaxMomentumPercent: 3,
            buyAntiFomoMinBelowHighPercent: 1
        } as RobotConfig);

        assert.strictEqual(result.passed, true);
        assert.ok(result.checks.some(check => check.key === 'anti-fomo' && check.status === 'pass'));
    });

    it('keeps weak sector performance observe-only by default', async () => {
        (TradeDecisionModel.count as unknown) = async () => 0;
        mockTrades([]);

        const result = await PreBuyRiskService.evaluate({
            ...baseInput,
            sector: 'industrials',
            sectorPerformance: {
                sector: 'industrials',
                closed: 9,
                wins: 0,
                losses: 9,
                pnlRub: -147,
                winRatePercent: 0
            }
        }, {
            ...config,
            sectorPerformanceRiskEnabled: true,
            sectorPerformanceRiskEnforced: false
        } as RobotConfig);

        assert.strictEqual(result.passed, true);
        assert.ok(result.warnings.some(reason => reason.includes('observe-only: sector industrials performance')));
        assert.ok(result.checks.some(check => check.key === 'sector-performance' && check.status === 'block' && !check.enforced));
    });

    it('blocks weak sector performance when sector performance risk is enforced', async () => {
        (TradeDecisionModel.count as unknown) = async () => 0;
        mockTrades([]);

        const result = await PreBuyRiskService.evaluate({
            ...baseInput,
            sector: 'it',
            sectorPerformance: {
                sector: 'it',
                closed: 16,
                wins: 0,
                losses: 16,
                pnlRub: -105,
                winRatePercent: 0
            }
        }, {
            ...config,
            sectorPerformanceRiskEnabled: true,
            sectorPerformanceRiskEnforced: true
        } as RobotConfig);

        assert.strictEqual(result.passed, false);
        assert.ok(result.blockingReasons.some(reason => reason.includes('sector it performance')));
        assert.ok(result.checks.some(check => check.key === 'sector-performance' && check.status === 'block' && check.enforced));
    });

    it('blocks a weak ticker when loss guard requires a higher score', async () => {
        (TradeDecisionModel.count as unknown) = async () => 0;
        mockTrades([]);

        const result = await PreBuyRiskService.evaluate({
            ...baseInput,
            buyScore: 74,
            buyRequiredScore: 70,
            lossGuard: {
                ticker: {
                    type: 'ticker',
                    key: 'SBER',
                    closed: 4,
                    wins: 0,
                    losses: 4,
                    pnlRub: -64,
                    winRatePercent: 0
                }
            }
        }, {
            ...config,
            buyLossGuardEnabled: true,
            buyLossGuardEnforced: true,
            buyLossGuardScoreBuffer: 10
        } as RobotConfig);

        assert.strictEqual(result.passed, false);
        assert.ok(result.blockingReasons.some(reason => reason.includes('ticker SBER loss guard')));
        assert.ok(result.checks.some(check => check.key === 'ticker-loss-guard' && check.status === 'block'));
    });

    it('allows a weak ticker when score clears the loss guard buffer', async () => {
        (TradeDecisionModel.count as unknown) = async () => 0;
        mockTrades([]);

        const result = await PreBuyRiskService.evaluate({
            ...baseInput,
            buyScore: 83,
            buyRequiredScore: 70,
            lossGuard: {
                ticker: {
                    type: 'ticker',
                    key: 'SBER',
                    closed: 4,
                    wins: 0,
                    losses: 4,
                    pnlRub: -64,
                    winRatePercent: 0
                }
            }
        }, {
            ...config,
            buyLossGuardEnabled: true,
            buyLossGuardEnforced: true,
            buyLossGuardScoreBuffer: 10
        } as RobotConfig);

        assert.strictEqual(result.passed, true);
        assert.ok(result.checks.some(check => check.key === 'ticker-loss-guard' && check.status === 'pass'));
    });
});
