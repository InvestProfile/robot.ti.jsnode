export type TradeAction = 'buy' | 'sell';
export type TradeSignalSource = 'profit-take' | 'stop-loss' | 'trailing-stop' | 'watchlist-buy' | 'trend-follow-buy';

export interface TradeSignal {
    action: TradeAction;
    source: TradeSignalSource;
    confidence: number;
    reason: string;
    quantityLots?: number;
    profitPercent: number;
    estimatedOrderRub?: number;
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

export interface BuyStrategyInput {
    accountId: string;
    figi: string;
    instrumentUid: string;
    ticker: string;
    name?: string;
    lot: number;
    lastPrice: number;
    availableCashRub: number;
    alreadyInPortfolio: boolean;
    dailyCloses?: number[];
}
