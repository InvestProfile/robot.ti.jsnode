import { RobotConfig } from '../config/robot.config';
import ProfitTakeStrategy from './profit-take.strategy';
import ScoreBuyStrategy from './score-buy.strategy';
import StopLossStrategy from './stop-loss.strategy';
import TrendFollowBuyStrategy from './trend-follow-buy.strategy';
import TrailingStopStrategy from './trailing-stop.strategy';
import WatchlistBuyStrategy from './watchlist-buy.strategy';
import { BuyStrategyInput, PositionStrategyInput, TradeSignal } from './trade-signal';

export default class StrategyEngine {
    static async evaluate(input: PositionStrategyInput, config: RobotConfig): Promise<TradeSignal | undefined> {
        const enabledStrategies = new Set(config.enabledStrategies);
        const trailingStopSignal = enabledStrategies.has('trailing-stop')
            ? await TrailingStopStrategy.evaluate(input, config)
            : undefined;

        if (enabledStrategies.has('stop-loss')) {
            const stopLossSignal = StopLossStrategy.evaluate(input, config);
            if (stopLossSignal) return stopLossSignal;
        }

        if (trailingStopSignal) return trailingStopSignal;

        if (enabledStrategies.has('profit-take')) {
            const profitTakeSignal = ProfitTakeStrategy.evaluate(input, config);
            if (profitTakeSignal) return profitTakeSignal;
        }

        return undefined;
    }

    static evaluateBuy(input: BuyStrategyInput, config: RobotConfig): TradeSignal | undefined {
        const scoreSignal = ScoreBuyStrategy.evaluate(input, config);
        if (scoreSignal) return scoreSignal;

        if (config.enabledStrategies.includes('score-buy')) {
            return undefined;
        }

        const trendSignal = TrendFollowBuyStrategy.evaluate(input, config);
        if (trendSignal) return trendSignal;

        if (config.enabledStrategies.includes('trend-follow-buy')) {
            return undefined;
        }

        return WatchlistBuyStrategy.evaluate(input, config);
    }
}
