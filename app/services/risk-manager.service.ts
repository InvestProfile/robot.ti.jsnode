import { RobotConfig } from '../config/robot.config';
import { TradeSignal } from '../strategies/trade-signal';
import TradeBudgetService from './trade-budget.service';

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
    riskStopPercent?: number;
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

        const estimatedOrderRub = input.signal.estimatedOrderRub ?? 0;
        const budget = TradeBudgetService.evaluateBuy({
            availableCashRub: input.availableCashRub,
            dailyOrdersCount: input.dailyOrdersCount,
            dailyOrdersRub: input.dailyOrdersRub,
            portfolioValueRub: input.portfolioValueRub,
            positionValueRub: input.positionValueRub,
            portfolioPositionsCount: input.portfolioPositionsCount,
            alreadyInPortfolio: input.alreadyInPortfolio,
            estimatedOrderRub,
            requestedLots: input.signal.quantityLots,
            riskStopPercent: input.riskStopPercent,
            lotRub: input.signal.quantityLots && input.signal.quantityLots > 0
                ? estimatedOrderRub / input.signal.quantityLots
                : estimatedOrderRub
        }, config);

        if (!budget.allowed) {
            return {
                allowed: false,
                reason: budget.reason,
                profitPercent: 0,
                estimatedOrderRub: budget.estimatedOrderRub,
                projectedPositionRub: budget.projectedPositionRub,
                projectedPositionSharePercent: budget.projectedPositionSharePercent,
                maxPositionRub: budget.maxPositionRub
            };
        }

        const signalLots = Math.trunc(input.signal.quantityLots ?? 0);
        if (signalLots <= 0) {
            return { allowed: false, reason: 'quantityLots is empty or zero', profitPercent: 0 };
        }

        return {
            allowed: true,
            reason: `${input.signal.source}: ${input.signal.reason}`,
            quantity: Math.min(signalLots, budget.quantityLots ?? signalLots, config.maxLotsPerOrder),
            profitPercent: 0,
            estimatedOrderRub: budget.estimatedOrderRub,
            projectedPositionRub: budget.projectedPositionRub,
            projectedPositionSharePercent: budget.projectedPositionSharePercent,
            maxPositionRub: budget.maxPositionRub
        };
    }
}
