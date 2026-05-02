import { TradeDecisionModel } from '../models/trade-decision.model';

export type TradeDecisionStatus = 'skip' | 'dry-run' | 'order-posted' | 'order-failed';

interface TradeDecisionLog {
    accountId: string;
    figi?: string;
    instrumentUid?: string;
    ticker?: string;
    name?: string;
    status: TradeDecisionStatus;
    reason: string;
    averagePrice?: number;
    currentPrice?: number;
    profitPercent?: number;
    quantityLots?: number;
}

export default class TradeJournalService {
    static async logDecision(decision: TradeDecisionLog) {
        const payload = {
            at: new Date().toISOString(),
            ...decision
        };

        console.log('TRADE_DECISION ' + JSON.stringify(payload));

        await TradeDecisionModel.create({
            accountId: decision.accountId,
            figi: decision.figi,
            instrumentUid: decision.instrumentUid,
            ticker: decision.ticker,
            name: decision.name,
            status: decision.status,
            reason: decision.reason,
            averagePrice: decision.averagePrice,
            currentPrice: decision.currentPrice,
            profitPercent: decision.profitPercent,
            quantityLots: decision.quantityLots
        });
    }
}
