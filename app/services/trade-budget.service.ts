import { RobotConfig } from '../config/robot.config';

export interface TradeBudgetInput {
    dailyOrdersCount: number;
    dailyOrdersRub: number;
    availableCashRub: number;
    estimatedOrderRub: number;
    portfolioValueRub?: number;
    positionValueRub?: number;
    portfolioPositionsCount?: number;
    alreadyInPortfolio?: boolean;
}

export interface TradeBudgetResult {
    allowed: boolean;
    reason: string;
    estimatedOrderRub: number;
    projectedPositionRub?: number;
    projectedPositionSharePercent?: number;
    maxPositionRub?: number;
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
        const estimatedOrderRub = input.estimatedOrderRub;
        if (estimatedOrderRub <= 0) {
            return { allowed: false, reason: 'estimated order amount is empty', estimatedOrderRub };
        }

        if (input.dailyOrdersCount >= config.maxDailyOrders) {
            return { allowed: false, reason: 'daily order limit reached', estimatedOrderRub };
        }

        if (estimatedOrderRub > config.maxOrderRub) {
            return { allowed: false, reason: 'estimated order amount is above max order RUB', estimatedOrderRub };
        }

        if (config.maxDailyRub <= 0) {
            return { allowed: false, reason: 'daily RUB limit is zero', estimatedOrderRub };
        }

        if (input.dailyOrdersRub + estimatedOrderRub > config.maxDailyRub) {
            return { allowed: false, reason: 'daily RUB limit reached', estimatedOrderRub };
        }

        if (estimatedOrderRub > input.availableCashRub) {
            return { allowed: false, reason: 'not enough cash for buy signal', estimatedOrderRub };
        }

        const portfolioValueRub = input.portfolioValueRub ?? 0;
        const positionValueRub = Math.max(0, input.positionValueRub ?? 0);
        const projectedPositionRub = positionValueRub + estimatedOrderRub;
        const maxPositionRub = portfolioValueRub > 0
            ? portfolioValueRub * Math.max(0, config.maxPositionSharePercent) / 100
            : undefined;
        const projectedPositionSharePercent = portfolioValueRub > 0
            ? projectedPositionRub / portfolioValueRub * 100
            : undefined;

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
                projectedPositionRub,
                projectedPositionSharePercent,
                maxPositionRub
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
                projectedPositionRub,
                projectedPositionSharePercent,
                maxPositionRub
            };
        }

        return {
            allowed: true,
            reason: 'trade budget passed',
            estimatedOrderRub,
            projectedPositionRub,
            projectedPositionSharePercent,
            maxPositionRub
        };
    }
}
