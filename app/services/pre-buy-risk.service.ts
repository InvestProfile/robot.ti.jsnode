import { RobotConfig } from '../config/robot.config';
import { Op } from 'sequelize';
import { TradeDecisionModel } from '../models/trade-decision.model';
import { DailyCandle } from '../strategies/trade-signal';
import MarketDataService from './marketData.service';
import SellPolicyService from './sell-policy.service';

type OrderBookMetrics = NonNullable<Awaited<ReturnType<typeof MarketDataService.getOrderBookMetrics>>>;

interface PreBuyRiskInput {
    accountId: string;
    figi?: string;
    instrumentUid: string;
    ticker?: string;
    lot: number;
    currentPrice?: number;
    estimatedOrderRub: number;
    sector?: string;
    portfolioValueRub: number;
    sectorValueRub: number;
    dailyCandles?: DailyCandle[];
    orderBookMetrics?: OrderBookMetrics;
    orderBookError?: unknown;
}

export interface PreBuyRiskCheck {
    key: string;
    status: 'pass' | 'warn' | 'block' | 'unknown';
    reason: string;
    enforced: boolean;
    value?: number;
    limit?: number;
}

export interface PreBuyRiskResult {
    passed: boolean;
    mode: 'enforced' | 'observe';
    warnings: string[];
    blockingReasons: string[];
    checks: PreBuyRiskCheck[];
    spreadPercent?: number;
    askLiquidityRub?: number;
    avgDailyTurnoverRub?: number;
    sector?: string;
    projectedSectorSharePercent?: number;
    robotOwnedLots?: number;
    robotAverageLotCostRub?: number;
    robotProfitPercent?: number;
}

const average = (values: number[]) => values.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : undefined;

const formatPercent = (value: number | undefined) =>
    value === undefined || !Number.isFinite(value) ? '-' : `${value.toFixed(2)}%`;

const formatRub = (value: number | undefined) =>
    value === undefined || !Number.isFinite(value) ? '-' : `${Math.round(value)} RUB`;

const getAvgDailyTurnoverRub = (candles: DailyCandle[] | undefined, lot: number) => {
    const values = candles
        ?.slice(-20)
        .map(candle => candle.close * candle.volume * Math.max(1, lot))
        .filter(value => Number.isFinite(value) && value > 0) ?? [];

    return average(values);
};

const BUY_SIGNAL_SOURCES = ['score-buy', 'watchlist-buy', 'trend-follow-buy'];

export default class PreBuyRiskService {
    private static getStartOfToday() {
        const startOfDay = new Date();
        startOfDay.setHours(0, 0, 0, 0);
        return startOfDay;
    }

    static async hasStopLossToday(accountId: string, ticker?: string) {
        const normalizedTicker = ticker?.trim().toUpperCase();
        if (!accountId || !normalizedTicker) return false;

        const count = await TradeDecisionModel.count({
            where: {
                accountId,
                ticker: normalizedTicker,
                signalSource: 'stop-loss',
                status: 'order-posted',
                createdAt: {
                    [Op.gte]: this.getStartOfToday()
                }
            } as any
        });

        return count > 0;
    }

    static async hasRejectedBuyToday(accountId: string, ticker?: string) {
        const normalizedTicker = ticker?.trim().toUpperCase();
        if (!accountId || !normalizedTicker) return false;

        const count = await TradeDecisionModel.count({
            where: {
                accountId,
                ticker: normalizedTicker,
                signalSource: { [Op.in]: BUY_SIGNAL_SOURCES },
                status: 'order-rejected',
                createdAt: {
                    [Op.gte]: this.getStartOfToday()
                }
            } as any
        });

        return count > 0;
    }

    static async evaluate(input: PreBuyRiskInput, config: RobotConfig): Promise<PreBuyRiskResult> {
        const checks: PreBuyRiskCheck[] = [];
        const warnings: string[] = [];
        const blockingReasons: string[] = [];

        const addCheck = (check: PreBuyRiskCheck) => {
            checks.push(check);

            if (check.status === 'block') {
                if (check.enforced) {
                    blockingReasons.push(check.reason);
                } else {
                    warnings.push(`observe-only: ${check.reason}`);
                }
            }

            if (check.status === 'warn' || check.status === 'unknown') {
                warnings.push(check.reason);
            }
        };

        if (await this.hasStopLossToday(input.accountId, input.ticker)) {
            addCheck({
                key: 'same-day-stop-loss-reentry',
                status: 'block',
                reason: `same-day re-entry blocked after stop-loss for ${input.ticker}`,
                enforced: true
            });
        }

        if (await this.hasRejectedBuyToday(input.accountId, input.ticker)) {
            addCheck({
                key: 'same-day-buy-rejected-reentry',
                status: 'block',
                reason: `same-day re-entry blocked after rejected buy order for ${input.ticker}`,
                enforced: true
            });
        }

        const addOnMinProfitPercent = Number(config.buyAddOnMinProfitPercent ?? 0);
        let robotOwnedLots: number | undefined;
        let robotAverageLotCostRub: number | undefined;
        let robotProfitPercent: number | undefined;

        if (addOnMinProfitPercent > 0) {
            const robotPosition = await SellPolicyService.getRobotPosition(input.accountId, input.figi, input.instrumentUid);
            robotOwnedLots = robotPosition.robotOwnedLots;
            robotAverageLotCostRub = robotPosition.robotAverageLotCostRub;

            const currentLotValueRub = Number(input.currentPrice) * Math.max(1, Number(input.lot || 1));
            robotProfitPercent = robotAverageLotCostRub && Number.isFinite(currentLotValueRub) && currentLotValueRub > 0
                ? (currentLotValueRub / robotAverageLotCostRub - 1) * 100
                : undefined;

            if (robotOwnedLots > 0) {
                addCheck({
                    key: 'add-on-position-profit',
                    status: robotProfitPercent !== undefined && robotProfitPercent >= addOnMinProfitPercent ? 'pass' : 'block',
                    reason: `add-on blocked: existing robot position P/L ${formatPercent(robotProfitPercent)} < ${formatPercent(addOnMinProfitPercent)}`,
                    enforced: true,
                    value: robotProfitPercent,
                    limit: addOnMinProfitPercent
                });
            }
        }

        let spreadPercent: number | undefined;
        let askLiquidityRub: number | undefined;

        if (config.liquidityRiskEnabled) {
            try {
                if (input.orderBookError) throw input.orderBookError;
                const orderBook = input.orderBookMetrics ?? await MarketDataService.getOrderBookMetrics(input.instrumentUid, input.lot);
                spreadPercent = orderBook?.spreadPercent;
                askLiquidityRub = orderBook?.askLiquidityRub;

                if (spreadPercent === undefined) {
                    addCheck({
                        key: 'spread',
                        status: 'unknown',
                        reason: 'spread is unavailable',
                        enforced: config.liquidityRiskEnforced
                    });
                } else {
                    addCheck({
                        key: 'spread',
                        status: spreadPercent > config.maxSpreadPercent ? 'block' : 'pass',
                        reason: `spread ${formatPercent(spreadPercent)} > ${formatPercent(config.maxSpreadPercent)}`,
                        enforced: config.liquidityRiskEnforced,
                        value: spreadPercent,
                        limit: config.maxSpreadPercent
                    });
                }

                if (askLiquidityRub === undefined || askLiquidityRub <= 0) {
                    addCheck({
                        key: 'orderbook-ask',
                        status: 'unknown',
                        reason: 'ask liquidity is unavailable',
                        enforced: config.liquidityRiskEnforced
                    });
                } else {
                    addCheck({
                        key: 'orderbook-ask',
                        status: askLiquidityRub < config.minOrderbookAskRub ? 'block' : 'pass',
                        reason: `ask liquidity ${formatRub(askLiquidityRub)} < ${formatRub(config.minOrderbookAskRub)}`,
                        enforced: config.liquidityRiskEnforced,
                        value: askLiquidityRub,
                        limit: config.minOrderbookAskRub
                    });
                }
            } catch (error) {
                addCheck({
                    key: 'orderbook',
                    status: 'unknown',
                    reason: `orderbook unavailable: ${error instanceof Error ? error.message : String(error)}`,
                    enforced: config.liquidityRiskEnforced
                });
            }

            const avgDailyTurnoverRub = getAvgDailyTurnoverRub(input.dailyCandles, input.lot);
            if (avgDailyTurnoverRub === undefined) {
                addCheck({
                    key: 'daily-turnover',
                    status: 'unknown',
                    reason: 'daily turnover is unavailable',
                    enforced: config.liquidityRiskEnforced
                });
            } else {
                addCheck({
                    key: 'daily-turnover',
                    status: avgDailyTurnoverRub < config.minDailyTurnoverRub ? 'block' : 'pass',
                    reason: `avg daily turnover ${formatRub(avgDailyTurnoverRub)} < ${formatRub(config.minDailyTurnoverRub)}`,
                    enforced: config.liquidityRiskEnforced,
                    value: avgDailyTurnoverRub,
                    limit: config.minDailyTurnoverRub
                });
            }
        }

        const avgDailyTurnoverRub = checks.find(check => check.key === 'daily-turnover')?.value;
        let projectedSectorSharePercent: number | undefined;
        const sector = input.sector?.trim() || undefined;

        if (config.sectorRiskEnabled) {
            if (!sector) {
                addCheck({
                    key: 'sector',
                    status: 'unknown',
                    reason: 'sector is unavailable',
                    enforced: config.sectorRiskEnforced
                });
            } else if (input.portfolioValueRub > 0) {
                projectedSectorSharePercent = (input.sectorValueRub + input.estimatedOrderRub) / input.portfolioValueRub * 100;
                addCheck({
                    key: 'sector-share',
                    status: projectedSectorSharePercent > config.maxSectorSharePercent ? 'block' : 'pass',
                    reason: `sector ${sector} share ${formatPercent(projectedSectorSharePercent)} > ${formatPercent(config.maxSectorSharePercent)}`,
                    enforced: config.sectorRiskEnforced,
                    value: projectedSectorSharePercent,
                    limit: config.maxSectorSharePercent
                });
            }
        }

        return {
            passed: blockingReasons.length === 0,
            mode: config.liquidityRiskEnforced || config.sectorRiskEnforced ? 'enforced' : 'observe',
            warnings,
            blockingReasons,
            checks,
            spreadPercent,
            askLiquidityRub,
            avgDailyTurnoverRub,
            sector,
            projectedSectorSharePercent,
            robotOwnedLots,
            robotAverageLotCostRub,
            robotProfitPercent
        };
    }
}
