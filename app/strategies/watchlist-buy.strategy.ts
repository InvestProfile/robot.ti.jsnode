import { RobotConfig } from '../config/robot.config';
import { BuyStrategyInput, TradeSignal } from './trade-signal';

export default class WatchlistBuyStrategy {
    static evaluate(input: BuyStrategyInput, config: RobotConfig): TradeSignal | undefined {
        if (!config.enabledStrategies.includes('watchlist-buy')) return undefined;
        if (!config.buyTickers.includes(input.ticker.toUpperCase())) return undefined;
        if (input.alreadyInPortfolio) return undefined;
        if (!Number.isFinite(input.lastPrice) || input.lastPrice <= 0) return undefined;

        const estimatedLotRub = input.lastPrice * Math.max(1, input.lot);
        if (estimatedLotRub > config.maxOrderRub) return undefined;
        if (estimatedLotRub > input.availableCashRub) return undefined;

        return {
            action: 'buy',
            source: 'watchlist-buy',
            confidence: 1,
            reason: `ticker is in buy watchlist and estimated lot is ${estimatedLotRub.toFixed(2)} RUB`,
            quantityLots: 1,
            profitPercent: 0,
            estimatedOrderRub: estimatedLotRub
        };
    }
}
