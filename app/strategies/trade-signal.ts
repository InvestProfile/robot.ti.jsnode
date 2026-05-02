export type TradeAction = 'sell';
export type TradeSignalSource = 'profit-take';

export interface TradeSignal {
    action: TradeAction;
    source: TradeSignalSource;
    confidence: number;
    reason: string;
    quantityLots?: number;
    profitPercent: number;
}
