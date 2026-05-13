import { RobotConfig } from '../config/robot.config';
import PositionStateService from '../services/position-state.service';
import { PositionStrategyInput, TradeSignal } from './trade-signal';

export default class TrailingStopStrategy {
    static async evaluate(input: PositionStrategyInput, config: RobotConfig): Promise<TradeSignal | undefined> {
        if (!Number.isFinite(input.currentPrice) || input.currentPrice <= 0) return undefined;

        const state = await PositionStateService.updateHighWaterMark({
            accountId: input.accountId,
            figi: input.figi,
            instrumentUid: input.instrumentUid,
            ticker: input.ticker,
            name: input.name,
            currentPrice: input.currentPrice,
            trailingBaseline: config.trailingBaseline
        });

        if (state.highestPrice <= 0) return undefined;

        const drawdownPercent = ((state.highestPrice - input.currentPrice) / state.highestPrice) * 100;
        if (drawdownPercent < config.trailingStopPercent) return undefined;

        if (!Number.isFinite(input.averagePrice) || input.averagePrice <= 0) return undefined;

        const profitPercent = ((input.currentPrice - input.averagePrice) / input.averagePrice) * 100;
        if (profitPercent < config.trailingStopMinProfitPercent) return undefined;

        const availableLots = Math.trunc(input.quantityLots ?? 0);
        if (availableLots <= 0) return undefined;

        return {
            action: 'sell',
            source: 'trailing-stop',
            confidence: 1,
            reason: `current price is ${drawdownPercent.toFixed(2)}% below ${config.trailingBaseline} high ${state.highestPrice.toFixed(2)}, profit ${profitPercent.toFixed(2)}% >= trailing min ${config.trailingStopMinProfitPercent.toFixed(2)}%`,
            quantityLots: Math.min(availableLots, config.maxLotsPerOrder),
            profitPercent,
            factors: {
                highestPrice: state.highestPrice,
                drawdownPercent,
                trailingStopMinProfitPercent: config.trailingStopMinProfitPercent
            }
        };
    }
}
