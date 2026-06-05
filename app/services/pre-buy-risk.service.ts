import { RobotConfig } from '../config/robot.config';
import { Op } from 'sequelize';
import { TradeDecisionModel } from '../models/trade-decision.model';
import { TradesModel } from '../models/trades.model';
import { DailyCandle } from '../strategies/trade-signal';
import MarketDataService from './marketData.service';
import SellPolicyService from './sell-policy.service';
import TradesService from './trades.service';
import { isIgnoredAccountingOrderStatus } from '../utils/order-status';
import ProtectiveStopService from './protective-stop.service';

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
    sectorPerformance?: {
        sector: string;
        closed: number;
        wins: number;
        losses: number;
        pnlRub: number;
        averagePnlRub?: number;
        winRatePercent?: number;
        stale?: boolean;
    };
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
    sectorPerformance?: PreBuyRiskInput['sectorPerformance'];
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

const getAntiFomoMetrics = (candles: DailyCandle[] | undefined, currentPrice?: number) => {
    const validCandles = candles
        ?.filter(candle =>
            Number.isFinite(candle.close)
            && Number.isFinite(candle.high)
            && candle.close > 0
            && candle.high > 0
        ) ?? [];
    const price = Number(currentPrice);

    if (!Number.isFinite(price) || price <= 0 || validCandles.length < 2) return undefined;

    const previousClose = validCandles[validCandles.length - 2]?.close;
    const recentHigh = Math.max(...validCandles.map(candle => candle.high));
    if (!previousClose || !Number.isFinite(recentHigh) || recentHigh <= 0) return undefined;

    return {
        momentumPercent: (price / previousClose - 1) * 100,
        belowHighPercent: (recentHigh / price - 1) * 100
    };
};

const BUY_SIGNAL_SOURCES = ['score-buy', 'watchlist-buy', 'trend-follow-buy'];
const BUY_DIRECTION = '1';
const SELL_DIRECTION = '2';

const sameInstrument = (data: Record<string, unknown>, figi?: string, instrumentUid?: string, ticker?: string) =>
    Boolean(
        (instrumentUid && (data.instrumentUid === instrumentUid || data.instrumentId === instrumentUid || data.uid === instrumentUid))
        || (figi && data.figi === figi)
        || (ticker && String(data.ticker || '').toUpperCase() === ticker.toUpperCase())
    );

const lotsFromTrade = (data: Record<string, unknown>) => {
    const executed = Number(data.lotsExecuted ?? 0);
    if (Number.isFinite(executed) && executed > 0) return executed;

    const requested = Number(data.lotsRequested ?? 0);
    if (Number.isFinite(requested) && requested > 0) return requested;

    const quantity = Number(data.quantity ?? 0);
    return Number.isFinite(quantity) && quantity > 0 ? quantity : 0;
};

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

    static async getLatestSellToday(input: Pick<PreBuyRiskInput, 'accountId' | 'figi' | 'instrumentUid' | 'ticker'>) {
        if (!input.accountId || (!input.figi && !input.instrumentUid && !input.ticker)) return undefined;

        const trades = await TradesModel.findAll({
            where: {
                accountId: input.accountId,
                direction: SELL_DIRECTION,
                createdAt: {
                    [Op.gte]: this.getStartOfToday()
                }
            } as any,
            order: [['createdAt', 'DESC']],
            limit: 100
        });

        for (const trade of trades) {
            const data = trade.get({ plain: true }) as Record<string, unknown>;
            if (!sameInstrument(data, input.figi, input.instrumentUid, input.ticker)) continue;
            if (isIgnoredAccountingOrderStatus(data.status ? String(data.status) : undefined)) continue;

            const lots = lotsFromTrade(data);
            const amount = TradesService.amountFromTrade(data);
            if (lots <= 0 || amount === undefined) continue;

            return {
                at: data.tradeDateTime || data.createdAt,
                lotValueRub: amount / lots
            };
        }

        return undefined;
    }

    static async getLatestBuyToday(input: Pick<PreBuyRiskInput, 'accountId' | 'figi' | 'instrumentUid' | 'ticker'>) {
        if (!input.accountId || (!input.figi && !input.instrumentUid && !input.ticker)) return undefined;

        const trades = await TradesModel.findAll({
            where: {
                accountId: input.accountId,
                direction: BUY_DIRECTION,
                createdAt: {
                    [Op.gte]: this.getStartOfToday()
                }
            } as any,
            order: [['createdAt', 'DESC']],
            limit: 100
        });

        for (const trade of trades) {
            const data = trade.get({ plain: true }) as Record<string, unknown>;
            if (!sameInstrument(data, input.figi, input.instrumentUid, input.ticker)) continue;
            if (isIgnoredAccountingOrderStatus(data.status ? String(data.status) : undefined)) continue;

            const lots = lotsFromTrade(data);
            const amount = TradesService.amountFromTrade(data);
            if (lots <= 0 || amount === undefined) continue;

            return {
                at: data.tradeDateTime || data.createdAt,
                lotValueRub: amount / lots
            };
        }

        return undefined;
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

        const protectiveStopFailure = ProtectiveStopService.getLastFailure(input.accountId, input.instrumentUid);
        if (protectiveStopFailure) {
            addCheck({
                key: 'protective-stop-broker-rejected',
                status: 'block',
                reason: `buy blocked: broker rejected protective stop for ${input.ticker ?? input.instrumentUid}; software stop can sell existing position, but new entries are blocked until protective stop is accepted`,
                enforced: true
            });
        }

        const addOnMinProfitPercent = Number(config.buyAddOnMinProfitPercent ?? 0);
        const reentryAfterSellMinGainPercent = Number(config.buyReentryAfterSellMinGainPercent ?? 0);
        let robotOwnedLots: number | undefined;
        let robotAverageLotCostRub: number | undefined;
        let robotProfitPercent: number | undefined;

        if (addOnMinProfitPercent > 0) {
            const latestBuyToday = await this.getLatestBuyToday(input);
            const currentLotValueRub = Number(input.currentPrice) * Math.max(1, Number(input.lot || 1));
            const requiredLotValueRub = latestBuyToday?.lotValueRub
                ? latestBuyToday.lotValueRub * (1 + addOnMinProfitPercent / 100)
                : undefined;

            if (
                latestBuyToday
                && requiredLotValueRub
                && Number.isFinite(currentLotValueRub)
                && currentLotValueRub > 0
            ) {
                addCheck({
                    key: 'same-day-buy-price-confirmation',
                    status: currentLotValueRub >= requiredLotValueRub ? 'pass' : 'block',
                    reason: `same-day add-on blocked: current lot ${formatRub(currentLotValueRub)} < required ${formatRub(requiredLotValueRub)} (${formatPercent(addOnMinProfitPercent)} above latest buy)`,
                    enforced: true,
                    value: currentLotValueRub,
                    limit: requiredLotValueRub
                });
            }

            const robotPosition = await SellPolicyService.getRobotPosition(input.accountId, input.figi, input.instrumentUid);
            robotOwnedLots = robotPosition.robotOwnedLots;
            robotAverageLotCostRub = robotPosition.robotAverageLotCostRub;

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

        if (reentryAfterSellMinGainPercent > 0 && (!robotOwnedLots || robotOwnedLots <= 0)) {
            const latestSell = await this.getLatestSellToday(input);
            const currentLotValueRub = Number(input.currentPrice) * Math.max(1, Number(input.lot || 1));
            const requiredLotValueRub = latestSell?.lotValueRub
                ? latestSell.lotValueRub * (1 + reentryAfterSellMinGainPercent / 100)
                : undefined;

            if (
                latestSell
                && requiredLotValueRub
                && Number.isFinite(currentLotValueRub)
                && currentLotValueRub > 0
            ) {
                addCheck({
                    key: 'post-sell-price-confirmation',
                    status: currentLotValueRub >= requiredLotValueRub ? 'pass' : 'block',
                    reason: `re-entry blocked after same-day sell: current lot ${formatRub(currentLotValueRub)} < required ${formatRub(requiredLotValueRub)} (${formatPercent(reentryAfterSellMinGainPercent)} above last sell)`,
                    enforced: true,
                    value: currentLotValueRub,
                    limit: requiredLotValueRub
                });
            }
        }

        if (config.buyAntiFomoEnabled) {
            const antiFomoMetrics = getAntiFomoMetrics(input.dailyCandles, input.currentPrice);
            if (!antiFomoMetrics) {
                addCheck({
                    key: 'anti-fomo',
                    status: 'unknown',
                    reason: 'anti-FOMO metrics are unavailable',
                    enforced: config.buyAntiFomoEnforced
                });
            } else {
                const momentumTooHot = antiFomoMetrics.momentumPercent > config.buyAntiFomoMaxMomentumPercent;
                const tooCloseToHigh = antiFomoMetrics.belowHighPercent <= config.buyAntiFomoMinBelowHighPercent;
                addCheck({
                    key: 'anti-fomo',
                    status: momentumTooHot && tooCloseToHigh ? 'block' : 'pass',
                    reason: `anti-FOMO: momentum ${formatPercent(antiFomoMetrics.momentumPercent)} > ${formatPercent(config.buyAntiFomoMaxMomentumPercent)} and below high ${formatPercent(antiFomoMetrics.belowHighPercent)} <= ${formatPercent(config.buyAntiFomoMinBelowHighPercent)}`,
                    enforced: config.buyAntiFomoEnforced,
                    value: antiFomoMetrics.momentumPercent,
                    limit: config.buyAntiFomoMaxMomentumPercent
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

        if (config.sectorPerformanceRiskEnabled && sector) {
            const performance = input.sectorPerformance;
            if (!performance) {
                addCheck({
                    key: 'sector-performance',
                    status: 'unknown',
                    reason: `sector ${sector} performance is unavailable`,
                    enforced: config.sectorPerformanceRiskEnforced
                });
            } else if (performance.closed < config.sectorPerformanceMinClosed) {
                addCheck({
                    key: 'sector-performance',
                    status: 'warn',
                    reason: `sector ${sector} has only ${performance.closed}/${config.sectorPerformanceMinClosed} closed pairs`,
                    enforced: config.sectorPerformanceRiskEnforced,
                    value: performance.closed,
                    limit: config.sectorPerformanceMinClosed
                });
            } else {
                const winRate = performance.winRatePercent ?? 0;
                const weakByPnl = performance.pnlRub <= config.sectorPerformanceMinPnlRub;
                const weakByWinRate = winRate < config.sectorPerformanceMinWinRatePercent;
                addCheck({
                    key: 'sector-performance',
                    status: weakByPnl || weakByWinRate ? 'block' : 'pass',
                    reason: `sector ${sector} performance: P/L ${formatRub(performance.pnlRub)}, WR ${formatPercent(winRate)}, closed ${performance.closed}${performance.stale ? ', stale cache' : ''}`,
                    enforced: config.sectorPerformanceRiskEnforced,
                    value: performance.pnlRub,
                    limit: config.sectorPerformanceMinPnlRub
                });
            }
        }

        return {
            passed: blockingReasons.length === 0,
            mode: config.liquidityRiskEnforced || config.sectorRiskEnforced || config.sectorPerformanceRiskEnforced || config.buyAntiFomoEnforced ? 'enforced' : 'observe',
            warnings,
            blockingReasons,
            checks,
            spreadPercent,
            askLiquidityRub,
            avgDailyTurnoverRub,
            sector,
            projectedSectorSharePercent,
            sectorPerformance: input.sectorPerformance,
            robotOwnedLots,
            robotAverageLotCostRub,
            robotProfitPercent
        };
    }
}
