import { PositionStateModel } from '../models/position-state.model';

interface UpdateInput {
    accountId: string;
    figi?: string;
    instrumentUid: string;
    ticker?: string;
    name?: string;
    currentPrice: number;
}

export default class PositionStateService {
    static async updateHighWaterMark(input: UpdateInput) {
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
}
