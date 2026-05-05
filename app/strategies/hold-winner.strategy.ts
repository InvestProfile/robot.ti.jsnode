import { RobotConfig } from '../config/robot.config';
import PositionStateService from '../services/position-state.service';
import { PositionStrategyInput, TradeSignal } from './trade-signal';

interface HoldWinnerInput extends PositionStrategyInput {
    highestPrice?: number;
}

const profitPercent = (averagePrice: number, currentPrice: number) =>
    (currentPrice / averagePrice - 1) * 100;

const drawdownPercent = (highestPrice: number | undefined, currentPrice: number) =>
    highestPrice && highestPrice > 0
        ? (highestPrice - currentPrice) / highestPrice * 100
        : 0;

export default class HoldWinnerStrategy {
    static async evaluate(input: HoldWinnerInput, config: RobotConfig): Promise<TradeSignal | undefined> {
        if (!Number.isFinite(input.averagePrice) || input.averagePrice <= 0) return undefined;
        if (!Number.isFinite(input.currentPrice) || input.currentPrice <= 0) return undefined;

        const profit = profitPercent(input.averagePrice, input.currentPrice);
        if (profit < config.minProfitPercent) return undefined;

        const state = input.highestPrice === undefined
            ? await PositionStateService.updateHighWaterMark({
                accountId: input.accountId,
                figi: input.figi,
                instrumentUid: input.instrumentUid,
                ticker: input.ticker,
                name: input.name,
                currentPrice: input.currentPrice,
                trailingBaseline: config.trailingBaseline
            })
            : { highestPrice: input.highestPrice };
        const drawdown = drawdownPercent(state.highestPrice, input.currentPrice);
        const shouldWaitForBiggerProfit = profit < config.sellHoldWinnerMinProfitPercent;
        const shouldLetWinnerRun = profit >= config.sellHoldWinnerMinProfitPercent
            && drawdown <= config.sellHoldWinnerMaxDrawdownPercent;

        if (!shouldWaitForBiggerProfit && !shouldLetWinnerRun) return undefined;

        return {
            action: 'hold',
            source: 'hold-winner',
            confidence: 0.8,
            reason: shouldWaitForBiggerProfit
                ? `profit ${profit.toFixed(2)}% is below winner target ${config.sellHoldWinnerMinProfitPercent.toFixed(2)}%`
                : `winner is still close to high: drawdown ${drawdown.toFixed(2)}% <= ${config.sellHoldWinnerMaxDrawdownPercent.toFixed(2)}%`,
            quantityLots: 0,
            profitPercent: profit,
            factors: {
                profitPercent: profit,
                drawdownPercent: drawdown,
                highestPrice: state.highestPrice,
                targetProfitPercent: config.sellHoldWinnerMinProfitPercent
            }
        };
    }
}
