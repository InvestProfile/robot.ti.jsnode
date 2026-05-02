import { RobotConfig } from '../config/robot.config';
import { TradeSignal } from './trade-signal';

interface ProfitTakeInput {
    averagePrice: number;
    currentPrice: number;
    quantityLots?: number;
}

export default class ProfitTakeStrategy {
    static evaluate(input: ProfitTakeInput, config: RobotConfig): TradeSignal | undefined {
        const profitPercent = ((input.currentPrice - input.averagePrice) / input.averagePrice) * 100;

        if (!Number.isFinite(input.averagePrice) || input.averagePrice <= 0) {
            return undefined;
        }

        if (!Number.isFinite(input.currentPrice) || input.currentPrice <= 0) {
            return undefined;
        }

        if (input.currentPrice <= input.averagePrice * config.minProfitMultiplier) {
            return undefined;
        }

        const availableLots = Math.trunc(input.quantityLots ?? 0);
        if (availableLots <= 0) {
            return undefined;
        }

        return {
            action: 'sell',
            source: 'profit-take',
            confidence: 1,
            reason: `current price is above average price by ${profitPercent.toFixed(2)}%`,
            quantityLots: Math.min(availableLots, config.maxLotsPerOrder),
            profitPercent
        };
    }
}
