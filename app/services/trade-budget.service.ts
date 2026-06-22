import { RobotConfig } from '../config/robot.config';

export interface TradeBudgetInput {
    dailyOrdersCount: number;
    dailyOrdersRub: number;
    availableCashRub: number;
    estimatedOrderRub: number;
    requestedLots?: number;
    lotRub?: number;
    riskStopPercent?: number;
    portfolioValueRub?: number;
    positionValueRub?: number;
    portfolioPositionsCount?: number;
    alreadyInPortfolio?: boolean;
}

export interface TradeBudgetResult {
    allowed: boolean;
    reason: string;
    estimatedOrderRub: number;
    quantityLots?: number;
    projectedPositionRub?: number;
    projectedPositionSharePercent?: number;
    maxPositionRub?: number;
    maxRiskAdjustedOrderRub?: number;
    riskStopPercent?: number;
}

export interface AccountBudgetPayload {
    maxOrderRub: number;
    dailyExposureRub: number;
    stopLossPercent: number;
    stopLossRiskRub: number;
    baseTrailingGivebackRub: number;
    maxOrderPortfolioPercent?: number;
    maxPositionSharePercent: number;
    maxPositionRub?: number;
    minDiversificationPositions: number;
    diversificationFirst: boolean;
    dailyExposurePortfolioPercent?: number;
    stopLossRiskPortfolioPercent?: number;
    cashUsagePercent?: number;
}

const percentOf = (value: number | undefined, total: number | undefined) =>
    total && total > 0 && value !== undefined ? value / total * 100 : undefined;

export default class TradeBudgetService {
    static getDailyExposureRub(config: RobotConfig) {
        if (config.maxDailyRub <= 0 || config.maxDailyOrders <= 0 || config.maxOrderRub <= 0) {
            return 0;
        }

        return Math.min(config.maxDailyRub, config.maxDailyOrders * config.maxOrderRub);
    }

    static buildAccountBudget(config: RobotConfig, input: {
        totalRub?: number;
        cashRub?: number;
    }): AccountBudgetPayload {
        const dailyExposureRub = this.getDailyExposureRub(config);
        const stopLossRiskRub = dailyExposureRub * Math.max(0, config.stopLossPercent) / 100;
        const baseTrailingGivebackRub = dailyExposureRub * Math.max(0, config.trailingStopPercent) / 100;
        const maxPositionRub = input.totalRub && input.totalRub > 0
            ? input.totalRub * Math.max(0, config.maxPositionSharePercent) / 100
            : undefined;

        return {
            maxOrderRub: config.maxOrderRub,
            dailyExposureRub,
            stopLossPercent: config.stopLossPercent,
            stopLossRiskRub,
            baseTrailingGivebackRub,
            maxOrderPortfolioPercent: percentOf(config.maxOrderRub, input.totalRub),
            maxPositionSharePercent: config.maxPositionSharePercent,
            maxPositionRub,
            minDiversificationPositions: config.minDiversificationPositions,
            diversificationFirst: config.diversificationFirst,
            dailyExposurePortfolioPercent: percentOf(dailyExposureRub, input.totalRub),
            stopLossRiskPortfolioPercent: percentOf(stopLossRiskRub, input.totalRub),
            cashUsagePercent: input.cashRub && input.cashRub > 0 ? dailyExposureRub / input.cashRub * 100 : undefined
        };
    }

    static evaluateBuy(input: TradeBudgetInput, config: RobotConfig): TradeBudgetResult {
        const requestedLots = Math.max(1, Math.trunc(input.requestedLots ?? 1));
        const rawEstimatedOrderRub = input.estimatedOrderRub;
        const lotRub = Number.isFinite(input.lotRub)
            ? Number(input.lotRub)
            : rawEstimatedOrderRub > 0 ? rawEstimatedOrderRub / requestedLots : 0;
        if (rawEstimatedOrderRub <= 0 || lotRub <= 0) {
            return { allowed: false, reason: 'estimated order amount is empty', estimatedOrderRub: rawEstimatedOrderRub };
        }

        const hasDailyOrderLimit = config.maxDailyOrders > 0;
        const hasDailyRubLimit = config.maxDailyRub > 0;
        const hasOrderRubLimit = config.maxOrderRub > 0;

        if (hasDailyOrderLimit && input.dailyOrdersCount >= config.maxDailyOrders) {
            return { allowed: false, reason: 'daily order limit reached', estimatedOrderRub: rawEstimatedOrderRub };
        }

        const portfolioValueRub = input.portfolioValueRub ?? 0;
        const positionValueRub = Math.max(0, input.positionValueRub ?? 0);
        const maxPositionRub = portfolioValueRub > 0
            ? portfolioValueRub * Math.max(0, config.maxPositionSharePercent) / 100
            : undefined;
        const remainingDailyRub = hasDailyRubLimit
            ? Math.max(0, config.maxDailyRub - input.dailyOrdersRub)
            : Number.POSITIVE_INFINITY;
        const remainingPositionRub = maxPositionRub === undefined
            ? Number.POSITIVE_INFINITY
            : Math.max(0, maxPositionRub - positionValueRub);
        const baseStopPercent = Math.max(0, Number(config.stopLossPercent) || 0);
        const riskStopPercent = Math.max(baseStopPercent, Number(input.riskStopPercent) || 0);
        const maxRiskAdjustedOrderRub = hasOrderRubLimit && baseStopPercent > 0 && riskStopPercent > baseStopPercent
            ? config.maxOrderRub * baseStopPercent / riskStopPercent
            : undefined;
        const maxLotsByOrder = hasOrderRubLimit ? Math.floor(config.maxOrderRub / lotRub) : Number.MAX_SAFE_INTEGER;
        const maxLotsByRisk = maxRiskAdjustedOrderRub !== undefined && maxRiskAdjustedOrderRub > 0
            ? Math.floor(maxRiskAdjustedOrderRub / lotRub)
            : Number.MAX_SAFE_INTEGER;
        const maxLotsByCash = Math.floor(Math.max(0, input.availableCashRub) / lotRub);
        const maxLotsByDailyRub = hasDailyRubLimit ? Math.floor(remainingDailyRub / lotRub) : Number.MAX_SAFE_INTEGER;
        const maxLotsByPosition = Number.isFinite(remainingPositionRub)
            ? Math.floor(remainingPositionRub / lotRub)
            : Number.MAX_SAFE_INTEGER;
        const maxLotsPerOrder = Math.max(1, Math.trunc(config.maxLotsPerOrder || 1));
        const quantityLots = Math.min(
            requestedLots,
            maxLotsPerOrder,
            maxLotsByOrder,
            maxLotsByRisk,
            maxLotsByCash,
            maxLotsByDailyRub,
            maxLotsByPosition
        );
        const estimatedOrderRub = quantityLots * lotRub;
        const projectedPositionRub = positionValueRub + estimatedOrderRub;
        const projectedPositionSharePercent = portfolioValueRub > 0
            ? projectedPositionRub / portfolioValueRub * 100
            : undefined;

        if (hasOrderRubLimit && maxLotsByOrder <= 0) {
            return { allowed: false, reason: 'estimated lot is above max order RUB', estimatedOrderRub: rawEstimatedOrderRub };
        }

        if (maxRiskAdjustedOrderRub !== undefined && maxLotsByRisk <= 0) {
            return {
                allowed: false,
                reason: `risk budget limit reached: lot ${lotRub.toFixed(2)} RUB > risk-adjusted order ${maxRiskAdjustedOrderRub.toFixed(2)} RUB at stop ${riskStopPercent.toFixed(2)}%`,
                estimatedOrderRub: rawEstimatedOrderRub,
                maxRiskAdjustedOrderRub,
                riskStopPercent
            };
        }

        if (hasDailyRubLimit && maxLotsByDailyRub <= 0) {
            return { allowed: false, reason: 'daily RUB limit reached', estimatedOrderRub: rawEstimatedOrderRub };
        }

        if (maxLotsByCash <= 0) {
            return { allowed: false, reason: 'not enough cash for minimum lot', estimatedOrderRub: rawEstimatedOrderRub };
        }

        if (maxLotsByPosition <= 0) {
            return {
                allowed: false,
                reason: `position concentration limit reached: projected ${projectedPositionSharePercent?.toFixed(2) ?? '0.00'}% > ${config.maxPositionSharePercent}%`,
                estimatedOrderRub: rawEstimatedOrderRub,
                projectedPositionRub: positionValueRub + lotRub,
                projectedPositionSharePercent: portfolioValueRub > 0 ? (positionValueRub + lotRub) / portfolioValueRub * 100 : undefined,
                maxPositionRub
            };
        }

        if (
            config.diversificationFirst
            && input.alreadyInPortfolio
            && config.minDiversificationPositions > 0
            && (input.portfolioPositionsCount ?? 0) < config.minDiversificationPositions
        ) {
            return {
                allowed: false,
                reason: `diversification first: portfolio has ${input.portfolioPositionsCount ?? 0}/${config.minDiversificationPositions} positions`,
                estimatedOrderRub,
                quantityLots,
                projectedPositionRub,
                projectedPositionSharePercent,
                maxPositionRub,
                maxRiskAdjustedOrderRub,
                riskStopPercent
            };
        }

        if (
            config.maxPositionSharePercent > 0
            && maxPositionRub !== undefined
            && projectedPositionRub > maxPositionRub
        ) {
            return {
                allowed: false,
                reason: `position concentration limit reached: projected ${projectedPositionSharePercent?.toFixed(2)}% > ${config.maxPositionSharePercent}%`,
                estimatedOrderRub,
                quantityLots,
                projectedPositionRub,
                projectedPositionSharePercent,
                maxPositionRub,
                maxRiskAdjustedOrderRub,
                riskStopPercent
            };
        }

        return {
            allowed: true,
            reason: quantityLots < requestedLots
                ? `trade budget resized: ${quantityLots}/${requestedLots} lots${riskStopPercent > baseStopPercent ? `, risk stop ${riskStopPercent.toFixed(2)}%` : ''}`
                : 'trade budget passed',
            estimatedOrderRub,
            quantityLots,
            projectedPositionRub,
            projectedPositionSharePercent,
            maxPositionRub,
            maxRiskAdjustedOrderRub,
            riskStopPercent
        };
    }
}
