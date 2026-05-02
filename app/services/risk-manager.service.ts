import { RobotConfig } from '../config/robot.config';
import { TradeSignal } from '../strategies/trade-signal';

interface RiskInput {
    averagePrice: number;
    currentPrice: number;
    quantityLots?: number;
    tradingStatus?: number;
    signal?: TradeSignal;
}

interface RiskResult {
    allowed: boolean;
    reason: string;
    quantity?: number;
    profitPercent: number;
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
}
