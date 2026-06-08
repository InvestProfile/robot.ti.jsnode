import { RobotConfig } from '../config/robot.config';
import StopLossStrategy from '../strategies/stop-loss.strategy';
import { PositionStrategyInput, TradeSignal } from '../strategies/trade-signal';

export interface ExitPolicyCandidateResult {
    label: string;
    mode: 'observe';
    status: 'same-hold' | 'same-sell' | 'would-hold' | 'would-sell' | 'not-applicable' | 'unknown';
    action: 'hold' | 'sell' | 'unknown';
    reason: string;
    lossPercent?: number;
    currentStopPercent?: number;
    candidateStopPercent?: number;
    currentAverageDailyRangePercent?: number;
    candidateAverageDailyRangePercent?: number;
    currentSource?: string;
}

const CANDIDATE_LABEL = 'ATR x2 max10';

const numberOrUndefined = (value: number | undefined) =>
    value !== undefined && Number.isFinite(value) ? value : undefined;

const sourceLabel = (signal: TradeSignal | undefined) =>
    signal?.source ? String(signal.source) : undefined;

const formatPercent = (value: number | undefined) =>
    value === undefined || !Number.isFinite(value) ? '-' : value.toFixed(2);

export default class ExitPolicyCandidateService {
    static async evaluate(
        input: PositionStrategyInput,
        config: RobotConfig,
        currentSignal?: TradeSignal
    ): Promise<ExitPolicyCandidateResult> {
        if (!Number.isFinite(input.averagePrice) || input.averagePrice <= 0) {
            return {
                label: CANDIDATE_LABEL,
                mode: 'observe',
                status: 'unknown',
                action: 'unknown',
                reason: 'average price is empty or invalid'
            };
        }

        if (!Number.isFinite(input.currentPrice) || input.currentPrice <= 0) {
            return {
                label: CANDIDATE_LABEL,
                mode: 'observe',
                status: 'unknown',
                action: 'unknown',
                reason: 'current price is empty or invalid'
            };
        }

        const lossPercent = ((input.averagePrice - input.currentPrice) / input.averagePrice) * 100;
        const currentStop = await StopLossStrategy.calculateEffectiveStop(input, config);
        const candidateStop = await StopLossStrategy.calculateEffectiveStop(input, {
            ...config,
            stopLossVolatilityMultiplier: 2,
            stopLossMaxPercent: 10
        });

        if (currentSignal?.action === 'sell' && currentSignal.source !== 'stop-loss') {
            return {
                label: CANDIDATE_LABEL,
                mode: 'observe',
                status: 'not-applicable',
                action: 'unknown',
                reason: `${CANDIDATE_LABEL} compares stop-loss exits only; current signal is ${currentSignal.source}`,
                lossPercent,
                currentStopPercent: numberOrUndefined(currentStop.effectiveStopPercent),
                candidateStopPercent: numberOrUndefined(candidateStop.effectiveStopPercent),
                currentAverageDailyRangePercent: numberOrUndefined(currentStop.averageDailyRangePercent),
                candidateAverageDailyRangePercent: numberOrUndefined(candidateStop.averageDailyRangePercent),
                currentSource: sourceLabel(currentSignal)
            };
        }

        const currentWouldSell = currentSignal?.source === 'stop-loss' && currentSignal.action === 'sell';
        const candidateWouldSell = lossPercent >= candidateStop.effectiveStopPercent;
        const action = candidateWouldSell ? 'sell' : 'hold';
        const status = currentWouldSell && !candidateWouldSell
            ? 'would-hold'
            : !currentWouldSell && candidateWouldSell
                ? 'would-sell'
                : candidateWouldSell
                    ? 'same-sell'
                    : 'same-hold';

        return {
            label: CANDIDATE_LABEL,
            mode: 'observe',
            status,
            action,
            reason: `${CANDIDATE_LABEL} observe-only: loss ${formatPercent(lossPercent)}%, current stop ${formatPercent(currentStop.effectiveStopPercent)}%, candidate stop ${formatPercent(candidateStop.effectiveStopPercent)}%${currentSignal?.source ? `, current signal ${currentSignal.source}` : ''}`,
            lossPercent,
            currentStopPercent: numberOrUndefined(currentStop.effectiveStopPercent),
            candidateStopPercent: numberOrUndefined(candidateStop.effectiveStopPercent),
            currentAverageDailyRangePercent: numberOrUndefined(currentStop.averageDailyRangePercent),
            candidateAverageDailyRangePercent: numberOrUndefined(candidateStop.averageDailyRangePercent),
            currentSource: sourceLabel(currentSignal)
        };
    }
}
