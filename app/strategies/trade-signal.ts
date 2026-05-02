export type TradeAction = 'sell';
export type TradeSignalSource = 'profit-take' | 'stop-loss' | 'trailing-stop';

export interface TradeSignal {
    action: TradeAction;
    source: TradeSignalSource;
    confidence: number;
    reason: string;
    quantityLots?: number;
    profitPercent: number;
}

export interface PositionStrategyInput {
    accountId: string;
    figi?: string;
    instrumentUid: string;
    ticker?: string;
    name?: string;
    averagePrice: number;
    currentPrice: number;
    quantityLots?: number;
}
