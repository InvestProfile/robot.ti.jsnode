import { RobotConfig } from '../config/robot.config';
import { TradeSignal } from '../strategies/trade-signal';

interface RiskInput {
    averagePrice: number;
    currentPrice: number;
    quantityLots?: number;
    tradingStatus?: number;
    signal?: TradeSignal;
}

interface BuyRiskInput {
    availableCashRub: number;
    dailyOrdersCount: number;
    dailyOrdersRub: number;
    portfolioValueRub?: number;
    positionValueRub?: number;
    portfolioPositionsCount?: number;
    alreadyInPortfolio?: boolean;
    signal?: TradeSignal;
    tradingStatus?: number;
}

interface RiskResult {
    allowed: boolean;
    reason: string;
    quantity?: number;
    profitPercent: number;
    estimatedOrderRub?: number;
    projectedPositionRub?: number;
    projectedPositionSharePercent?: number;
    maxPositionRub?: number;
}

const NORMAL_TRADING_STATUS = 5;

export default class RiskManagerService {
    static evaluateSignal(input: RiskInput, config: RobotConfig): RiskResult {
        const profitPercent = ((input.currentPrice - input.averagePrice) / input.averagePrice) * 100;

        if (!Number.isFinite(input.averagePrice) || input.averagePrice <= 0) {
            return { allowed: false, reason: 'average price is empty or invalid', profitPercent };
        }

        if (!Number.isFinite(input.currentPrice) || input.currentPrice <= 0) {
            return { allowed: false, reason: 'current price is empty or invalid', profitPercent };
        }

        if (input.tradingStatus !== NORMAL_TRADING_STATUS) {
            return { allowed: false, reason: 'instrument is not in normal trading status', profitPercent };
        }

        if (!input.signal) {
            return {
                allowed: false,
                reason: 'no strategy signal',
                profitPercent
            };
        }

        if (input.signal.action === 'hold') {
            return {
                allowed: false,
                reason: `${input.signal.source}: ${input.signal.reason}`,
                profitPercent: input.signal.profitPercent
            };
        }

        if (input.signal.action !== 'sell') {
            return { allowed: false, reason: `unsupported signal action: ${input.signal.action}`, profitPercent };
        }

        const signalLots = Math.trunc(input.signal.quantityLots ?? 0);
        if (signalLots <= 0) {
            return { allowed: false, reason: 'quantityLots is empty or zero', profitPercent };
        }

        return {
            allowed: true,
            reason: `${input.signal.source}: ${input.signal.reason}`,
            quantity: Math.min(signalLots, config.maxLotsPerOrder),
            profitPercent: input.signal.profitPercent
        };
    }

    static evaluateBuySignal(input: BuyRiskInput, config: RobotConfig): RiskResult {
        if (input.tradingStatus !== NORMAL_TRADING_STATUS) {
            return { allowed: false, reason: 'instrument is not in normal trading status', profitPercent: 0 };
        }

        if (!input.signal) {
            return { allowed: false, reason: 'no buy strategy signal', profitPercent: 0 };
        }

        if (input.signal.action !== 'buy') {
            return { allowed: false, reason: `unsupported signal action: ${input.signal.action}`, profitPercent: 0 };
        }

        if (input.dailyOrdersCount >= config.maxDailyOrders) {
            return { allowed: false, reason: 'daily order limit reached', profitPercent: 0 };
        }

        const estimatedOrderRub = input.signal.estimatedOrderRub ?? 0;
        if (estimatedOrderRub <= 0) {
            return { allowed: false, reason: 'estimated order amount is empty', profitPercent: 0 };
        }

        if (estimatedOrderRub > config.maxOrderRub) {
            return { allowed: false, reason: 'estimated order amount is above max order RUB', profitPercent: 0 };
        }

        if (config.maxDailyRub <= 0) {
            return { allowed: false, reason: 'daily RUB limit is zero', profitPercent: 0 };
        }

        if (input.dailyOrdersRub + estimatedOrderRub > config.maxDailyRub) {
            return { allowed: false, reason: 'daily RUB limit reached', profitPercent: 0 };
        }

        if (estimatedOrderRub > input.availableCashRub) {
            return { allowed: false, reason: 'not enough cash for buy signal', profitPercent: 0 };
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
                profitPercent: 0,
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
                profitPercent: 0,
                estimatedOrderRub,
                projectedPositionRub,
                projectedPositionSharePercent,
                maxPositionRub
            };
        }

        const signalLots = Math.trunc(input.signal.quantityLots ?? 0);
        if (signalLots <= 0) {
            return { allowed: false, reason: 'quantityLots is empty or zero', profitPercent: 0 };
        }

        return {
            allowed: true,
            reason: `${input.signal.source}: ${input.signal.reason}`,
            quantity: Math.min(signalLots, config.maxLotsPerOrder),
            profitPercent: 0,
            estimatedOrderRub,
            projectedPositionRub,
            projectedPositionSharePercent,
            maxPositionRub
        };
    }
}
