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
import { LossGuardStats } from './loss-guard.service';

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
    buyScore?: number;
    buyRequiredScore?: number;
    lossGuard?: {
        ticker?: LossGuardStats;
        sector?: LossGuardStats;
    };
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
    lossGuard?: PreBuyRiskInput['lossGuard'];
}

const average = (values: number[]) => values.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : undefined;

const formatPercent = (value: number | undefined) =>
    value === undefined || !Number.isFinite(value) ? '-' : `${value.toFixed(2)}%`;

const formatRub = (value: number | undefined) =>
    value === undefined || !Number.isFinite(value) ? '-' : `${Math.round(value)} RUB`;

const isWeakLossGuardStats = (stats: LossGuardStats | undefined, config: RobotConfig) => {
    if (!stats) return false;

    const winRate = stats.winRatePercent ?? 0;
    const weakByPnl = stats.pnlRub <= config.buyLossGuardMinPnlRub;
    const weakByWinRate = winRate < config.buyLossGuardMinWinRatePercent;
    const enoughClosed = stats.closed >= config.buyLossGuardMinClosed;
    const enoughLosses = stats.losses >= config.buyLossGuardMinLosses;
    const stopDamageThreshold = Math.min(config.buyLossGuardMinPnlRub, config.buyLossGuardMinPnlRub * 2);
    const weakByStopCluster = stats.stopLosses >= config.buyLossGuardMinLosses
        && stats.stopLossPnlRub <= config.buyLossGuardMinPnlRub;
    const weakByLargeStopDamage = stats.stopLosses > 0 && stats.stopLossPnlRub <= stopDamageThreshold;

    return (enoughClosed && enoughLosses && (weakByPnl || weakByWinRate))
        || weakByStopCluster
        || weakByLargeStopDamage;
};

const lossGuardReason = (label: string, stats: LossGuardStats, score: number | undefined, requiredScore: number, config: RobotConfig) =>
    `${label} loss guard: score ${score ?? '-'} < required ${requiredScore}; closed ${stats.closed}, losses ${stats.losses}, P/L ${formatRub(stats.pnlRub)}, WR ${formatPercent(stats.winRatePercent)}, stop-losses ${stats.stopLosses ?? 0}, broker stops ${stats.brokerStopLosses ?? 0}, stop P/L ${formatRub(stats.stopLossPnlRub)}, buffer ${formatPercent(config.buyLossGuardScoreBuffer)}${stats.stale ? ', stale cache' : ''}`;

const getAvgDailyTurnoverRub = (candles: DailyCandle[] | undefined, lot: number) => {
    const values = candles
        ?.slice(-20)
        .map(candle => candle.close * candle.volume * Math.max(1, lot))
        .filter(value => Number.isFinite(value) && value > 0) ?? [];

    return average(values);
};

const getAverageDailyRangePercent = (candles: DailyCandle[], days: number) => {
    const ranges = candles
        .slice(0, -1)
        .slice(-days)
        .map(candle => {
            if (!Number.isFinite(candle.high) || !Number.isFinite(candle.low) || !Number.isFinite(candle.close) || candle.close <= 0) {
                return undefined;
            }

            return ((candle.high - candle.low) / candle.close) * 100;
        })
        .filter((value): value is number => value !== undefined && Number.isFinite(value) && value >= 0);

    return average(ranges);
};

const getAntiFomoMetrics = (candles: DailyCandle[] | undefined, currentPrice: number | undefined, config: RobotConfig) => {
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

    const averageDailyRangePercent = getAverageDailyRangePercent(validCandles, config.buyAntiFomoRangeDays);
    const rangeExtensionLimitPercent = averageDailyRangePercent !== undefined
        ? averageDailyRangePercent * config.buyAntiFomoMaxRangeMultiplier
        : undefined;
    const momentumPercent = (price / previousClose - 1) * 100;

    return {
        momentumPercent,
        belowHighPercent: (recentHigh / price - 1) * 100,
        averageDailyRangePercent,
        rangeExtensionLimitPercent
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

    static async getLatestSellSince(input: Pick<PreBuyRiskInput, 'accountId' | 'figi' | 'instrumentUid' | 'ticker'>, since: Date) {
        if (!input.accountId || (!input.figi && !input.instrumentUid && !input.ticker)) return undefined;
        if (!Number.isFinite(since.getTime())) return undefined;

        const trades = await TradesModel.findAll({
            where: {
                accountId: input.accountId,
                direction: SELL_DIRECTION,
                createdAt: {
                    [Op.gte]: since
                }
            } as any,
            order: [['createdAt', 'DESC']],
            limit: 200
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

        if (config.buyLossGuardEnabled) {
            const score = Number(input.buyScore);
            const baseRequiredScore = Number(input.buyRequiredScore ?? config.buyMinScore);
            const requiredScore = Math.min(100, Math.max(1, baseRequiredScore + Number(config.buyLossGuardScoreBuffer ?? 0)));
            const scoreKnown = Number.isFinite(score);

            const addLossGuardCheck = (key: string, label: string, stats: LossGuardStats | undefined) => {
                if (!stats) return;
                if (!isWeakLossGuardStats(stats, config)) {
                    addCheck({
                        key,
                        status: 'pass',
                        reason: `${label} loss guard passed: closed ${stats.closed}, losses ${stats.losses}, P/L ${formatRub(stats.pnlRub)}, WR ${formatPercent(stats.winRatePercent)}, stop-losses ${stats.stopLosses ?? 0}, stop P/L ${formatRub(stats.stopLossPnlRub)}`,
                        enforced: config.buyLossGuardEnforced,
                        value: scoreKnown ? score : undefined,
                        limit: requiredScore
                    });
                    return;
                }

                addCheck({
                    key,
                    status: !scoreKnown || score < requiredScore ? 'block' : 'pass',
                    reason: !scoreKnown || score < requiredScore
                        ? lossGuardReason(label, stats, scoreKnown ? score : undefined, requiredScore, config)
                        : `${label} loss guard passed by strong score ${score}/${requiredScore}: closed ${stats.closed}, losses ${stats.losses}, P/L ${formatRub(stats.pnlRub)}, WR ${formatPercent(stats.winRatePercent)}, stop-losses ${stats.stopLosses ?? 0}, stop P/L ${formatRub(stats.stopLossPnlRub)}`,
                    enforced: config.buyLossGuardEnforced,
                    value: scoreKnown ? score : undefined,
                    limit: requiredScore
                });
            };

            addLossGuardCheck('ticker-loss-guard', `ticker ${input.ticker ?? input.instrumentUid}`, input.lossGuard?.ticker);
            addLossGuardCheck('sector-loss-guard', `sector ${input.sector ?? '-'}`, input.lossGuard?.sector);
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

        if (config.buyRecentSellReentryEnabled && (!robotOwnedLots || robotOwnedLots <= 0)) {
            const windowMs = Math.max(0, Number(config.buyRecentSellReentryWindowMs ?? 0));
            const minGainPercent = Math.max(0, Number(config.buyRecentSellReentryMinGainPercent ?? 0));
            const currentLotValueRub = Number(input.currentPrice) * Math.max(1, Number(input.lot || 1));
            const since = new Date(Date.now() - windowMs);
            const latestSell = windowMs > 0 ? await this.getLatestSellSince(input, since) : undefined;
            const requiredLotValueRub = latestSell?.lotValueRub
                ? latestSell.lotValueRub * (1 + minGainPercent / 100)
                : undefined;

            if (
                latestSell
                && requiredLotValueRub
                && Number.isFinite(currentLotValueRub)
                && currentLotValueRub > 0
            ) {
                addCheck({
                    key: 'recent-sell-reentry',
                    status: currentLotValueRub >= requiredLotValueRub ? 'pass' : 'block',
                    reason: currentLotValueRub >= requiredLotValueRub
                        ? `recent sell re-entry passed: current lot ${formatRub(currentLotValueRub)} >= required ${formatRub(requiredLotValueRub)} (${formatPercent(minGainPercent)} above latest sell within ${Math.round(windowMs / 60 / 60 / 1000)}h)`
                        : `recent sell re-entry blocked: current lot ${formatRub(currentLotValueRub)} < required ${formatRub(requiredLotValueRub)} (${formatPercent(minGainPercent)} above latest sell within ${Math.round(windowMs / 60 / 60 / 1000)}h)`,
                    enforced: config.buyRecentSellReentryEnforced,
                    value: currentLotValueRub,
                    limit: requiredLotValueRub
                });
            }
        }

        if (config.buyAntiFomoEnabled) {
            const antiFomoMetrics = getAntiFomoMetrics(input.dailyCandles, input.currentPrice, config);
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
                const rangeExtensionTooHot = antiFomoMetrics.rangeExtensionLimitPercent !== undefined
                    && antiFomoMetrics.momentumPercent > antiFomoMetrics.rangeExtensionLimitPercent;
                const blocked = tooCloseToHigh && (momentumTooHot || rangeExtensionTooHot);
                const rangeText = antiFomoMetrics.averageDailyRangePercent !== undefined && antiFomoMetrics.rangeExtensionLimitPercent !== undefined
                    ? `, avg range ${formatPercent(antiFomoMetrics.averageDailyRangePercent)}, extension limit ${formatPercent(antiFomoMetrics.rangeExtensionLimitPercent)}`
                    : '';
                addCheck({
                    key: 'anti-fomo',
                    status: blocked ? 'block' : 'pass',
                    reason: blocked
                        ? `anti-FOMO blocked: price is only ${formatPercent(antiFomoMetrics.belowHighPercent)} below high, momentum ${formatPercent(antiFomoMetrics.momentumPercent)}${momentumTooHot ? ` above ${formatPercent(config.buyAntiFomoMaxMomentumPercent)}` : ''}${rangeExtensionTooHot ? ` above normal range extension` : ''}${rangeText}`
                        : `anti-FOMO passed: momentum ${formatPercent(antiFomoMetrics.momentumPercent)}, price is ${formatPercent(antiFomoMetrics.belowHighPercent)} below high${rangeText}`,
                    enforced: config.buyAntiFomoEnforced,
                    value: antiFomoMetrics.momentumPercent,
                    limit: antiFomoMetrics.rangeExtensionLimitPercent !== undefined
                        ? Math.min(config.buyAntiFomoMaxMomentumPercent, antiFomoMetrics.rangeExtensionLimitPercent)
                        : config.buyAntiFomoMaxMomentumPercent
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
                    const blocked = spreadPercent > config.maxSpreadPercent;
                    addCheck({
                        key: 'spread',
                        status: blocked ? 'block' : 'pass',
                        reason: blocked
                            ? `spread blocked: ${formatPercent(spreadPercent)} above limit ${formatPercent(config.maxSpreadPercent)}`
                            : `spread passed: ${formatPercent(spreadPercent)} within limit ${formatPercent(config.maxSpreadPercent)}`,
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
                    const blocked = askLiquidityRub < config.minOrderbookAskRub;
                    addCheck({
                        key: 'orderbook-ask',
                        status: blocked ? 'block' : 'pass',
                        reason: blocked
                            ? `ask liquidity blocked: ${formatRub(askLiquidityRub)} below minimum ${formatRub(config.minOrderbookAskRub)}`
                            : `ask liquidity passed: ${formatRub(askLiquidityRub)} above minimum ${formatRub(config.minOrderbookAskRub)}`,
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
                const blocked = avgDailyTurnoverRub < config.minDailyTurnoverRub;
                addCheck({
                    key: 'daily-turnover',
                    status: blocked ? 'block' : 'pass',
                    reason: blocked
                        ? `daily turnover blocked: ${formatRub(avgDailyTurnoverRub)} below minimum ${formatRub(config.minDailyTurnoverRub)}`
                        : `daily turnover passed: ${formatRub(avgDailyTurnoverRub)} above minimum ${formatRub(config.minDailyTurnoverRub)}`,
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
                const blocked = projectedSectorSharePercent > config.maxSectorSharePercent;
                addCheck({
                    key: 'sector-share',
                    status: blocked ? 'block' : 'pass',
                    reason: blocked
                        ? `sector share blocked: ${sector} would become ${formatPercent(projectedSectorSharePercent)}, above limit ${formatPercent(config.maxSectorSharePercent)}`
                        : `sector share passed: ${sector} would be ${formatPercent(projectedSectorSharePercent)}, within limit ${formatPercent(config.maxSectorSharePercent)}`,
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
            mode: config.liquidityRiskEnforced || config.sectorRiskEnforced || config.sectorPerformanceRiskEnforced || config.buyAntiFomoEnforced || config.buyLossGuardEnforced || config.buyRecentSellReentryEnforced ? 'enforced' : 'observe',
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
            robotProfitPercent,
            lossGuard: input.lossGuard
        };
    }
}
