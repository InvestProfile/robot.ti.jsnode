export type TradeAction = 'buy' | 'sell' | 'hold';
export type TradeSignalSource = 'profit-take' | 'stop-loss' | 'trailing-stop' | 'hold-winner' | 'watchlist-buy' | 'trend-follow-buy' | 'score-buy';

export interface TradeSignal {
    action: TradeAction;
    source: TradeSignalSource;
    confidence: number;
    reason: string;
    quantityLots?: number;
    profitPercent: number;
    estimatedOrderRub?: number;
    score?: number;
    factors?: Record<string, number>;
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
    dailyCandles?: DailyCandle[];
}

export interface DailyCandle {
    close: number;
    high: number;
    low: number;
    volume: number;
    time?: Date;
}
