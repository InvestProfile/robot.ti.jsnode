import { RobotConfig } from '../config/robot.config';
import ProfitTakeStrategy from './profit-take.strategy';
import StopLossStrategy from './stop-loss.strategy';
import TrailingStopStrategy from './trailing-stop.strategy';
import { PositionStrategyInput, TradeSignal } from './trade-signal';

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
}
