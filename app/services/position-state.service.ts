import { PositionStateModel } from '../models/position-state.model';
import marketData from './marketData.service';
import { TrailingBaseline } from '../config/robot.config';

interface UpdateInput {
    accountId: string;
    figi?: string;
    instrumentUid: string;
    ticker?: string;
    name?: string;
    currentPrice: number;
    trailingBaseline: TrailingBaseline;
}

export default class PositionStateService {
    private static async getInitialHighestPrice(input: UpdateInput) {
        if (input.trailingBaseline === 'observed') {
            return input.currentPrice;
        }

        const days = input.trailingBaseline === 'history_30d' ? 30 : 90;

        try {
            const historyHigh = await marketData.getHighestDailyCandlePrice(input.instrumentUid, days);
            if (historyHigh && historyHigh > 0) {
                return Math.max(historyHigh, input.currentPrice);
            }
        } catch (error) {
            console.error('Unable to load trailing history baseline:', {
                accountId: input.accountId,
                ticker: input.ticker,
                instrumentUid: input.instrumentUid,
                trailingBaseline: input.trailingBaseline,
                error
            });
        }

        return input.currentPrice;
    }

    static async updateHighWaterMark(input: UpdateInput) {
        const initialHighestPrice = await PositionStateService.getInitialHighestPrice(input);
        const [state] = await PositionStateModel.findOrCreate({
            where: {
                accountId: input.accountId,
                instrumentUid: input.instrumentUid
            },
            defaults: {
                accountId: input.accountId,
                figi: input.figi,
                instrumentUid: input.instrumentUid,
                ticker: input.ticker,
                name: input.name,
                highestPrice: initialHighestPrice,
                lastPrice: input.currentPrice
            }
        });

        const highestPrice = Math.max(Number(state.highestPrice), input.currentPrice);

        await state.update({
            figi: input.figi,
            ticker: input.ticker,
            name: input.name,
            highestPrice,
            lastPrice: input.currentPrice
        });

        return {
            highestPrice,
            previousHighestPrice: Number(state.highestPrice)
        };
    }

    static async resetHighWaterMark(input: Omit<UpdateInput, 'trailingBaseline'>) {
        if (!Number.isFinite(input.currentPrice) || input.currentPrice <= 0) return;

        const [state] = await PositionStateModel.findOrCreate({
            where: {
                accountId: input.accountId,
                instrumentUid: input.instrumentUid
            },
            defaults: {
                accountId: input.accountId,
                figi: input.figi,
                instrumentUid: input.instrumentUid,
                ticker: input.ticker,
                name: input.name,
                highestPrice: input.currentPrice,
                lastPrice: input.currentPrice
            }
        });

        await state.update({
            figi: input.figi,
            ticker: input.ticker,
            name: input.name,
            highestPrice: input.currentPrice,
            lastPrice: input.currentPrice
        });
    }
}
