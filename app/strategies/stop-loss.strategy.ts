import { RobotConfig } from '../config/robot.config';
import { PositionStrategyInput, TradeSignal } from './trade-signal';

export default class StopLossStrategy {
    static evaluate(input: PositionStrategyInput, config: RobotConfig): TradeSignal | undefined {
        if (!Number.isFinite(input.averagePrice) || input.averagePrice <= 0) return undefined;
        if (!Number.isFinite(input.currentPrice) || input.currentPrice <= 0) return undefined;

        const lossPercent = ((input.averagePrice - input.currentPrice) / input.averagePrice) * 100;
        if (lossPercent < config.stopLossPercent) return undefined;

        const availableLots = Math.trunc(input.quantityLots ?? 0);
        if (availableLots <= 0) return undefined;

        return {
            action: 'sell',
            source: 'stop-loss',
            confidence: 1,
            reason: `current price is below average price by ${lossPercent.toFixed(2)}%`,
            quantityLots: Math.min(availableLots, config.maxLotsPerOrder),
            profitPercent: -lossPercent
        };
    }
}
