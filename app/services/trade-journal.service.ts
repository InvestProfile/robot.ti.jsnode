import { TradeDecisionModel } from '../models/trade-decision.model';

export type TradeDecisionStatus = 'skip' | 'dry-run' | 'order-posted' | 'order-failed';

interface TradeDecisionLog {
    accountId: string;
    accountAlias?: string;
    accountMode?: string;
    figi?: string;
    instrumentUid?: string;
    ticker?: string;
    name?: string;
    status: TradeDecisionStatus;
    signalSource?: string;
    reason: string;
    averagePrice?: number;
    currentPrice?: number;
    profitPercent?: number;
    quantityLots?: number;
    estimatedOrderRub?: number;
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
            accountAlias: decision.accountAlias,
            accountMode: decision.accountMode ?? 'trade',
            figi: decision.figi,
            instrumentUid: decision.instrumentUid,
            ticker: decision.ticker,
            name: decision.name,
            status: decision.status,
            signalSource: decision.signalSource,
            reason: decision.reason,
            averagePrice: decision.averagePrice,
            currentPrice: decision.currentPrice,
            profitPercent: decision.profitPercent,
            quantityLots: decision.quantityLots,
            estimatedOrderRub: decision.estimatedOrderRub
        });
    }
}
