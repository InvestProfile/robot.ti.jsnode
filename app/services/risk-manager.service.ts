import { RobotConfig } from '../config/robot.config';

interface RiskInput {
    averagePrice: number;
    currentPrice: number;
    quantityLots?: number;
    tradingStatus?: number;
}

interface RiskResult {
    allowed: boolean;
    reason: string;
    quantity?: number;
    profitPercent: number;
}

const NORMAL_TRADING_STATUS = 5;

export default class RiskManagerService {
    static evaluateProfitSell(input: RiskInput, config: RobotConfig): RiskResult {
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

        if (input.currentPrice <= input.averagePrice * config.minProfitMultiplier) {
            return {
                allowed: false,
                reason: `profit is below ${config.minProfitPercent}% threshold`,
                profitPercent
            };
        }

        const availableLots = Math.trunc(input.quantityLots ?? 0);
        if (availableLots <= 0) {
            return { allowed: false, reason: 'quantityLots is empty or zero', profitPercent };
        }

        return {
            allowed: true,
            reason: 'profit sell rule passed',
            quantity: Math.min(availableLots, config.maxLotsPerOrder),
            profitPercent
        };
    }
}
