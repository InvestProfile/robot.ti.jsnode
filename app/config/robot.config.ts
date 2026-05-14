import { getEnv } from './env.config';

const LIVE_CONFIRMATION = 'I_UNDERSTAND_THIS_TRADES_REAL_MONEY';
const DEFAULT_STRATEGIES = ['stop-loss', 'trailing-stop', 'hold-winner', 'profit-take', 'score-buy', 'trend-follow-buy', 'watchlist-buy'];
const TRAILING_BASELINES = ['observed', 'history_30d', 'history_90d'] as const;
const LIVE_ACTIONS = ['buy', 'sell'] as const;
const SCAN_UNIVERSES = ['manual', 'auto'] as const;

export type TrailingBaseline = typeof TRAILING_BASELINES[number];
export type LiveAction = typeof LIVE_ACTIONS[number];
export type ScanUniverse = typeof SCAN_UNIVERSES[number];

export interface BuyScoreProfile {
    buyTrendDays: number;
    buyMinScore: number;
}

const parseBoolean = (value: string | undefined, defaultValue: boolean) => {
    if (value === undefined) return defaultValue;
    return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
};

const parseNumber = (value: string | undefined, defaultValue: number) => {
    if (value === undefined || value.trim() === '') return defaultValue;

    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : defaultValue;
};

const parseAccountIds = (value: string | undefined, name: string) => {
    if (!value) {
        throw new Error(`${name} must be set explicitly. Refusing to use a default brokerage account.`);
    }

    const ids = value
        .split(',')
        .map(accountId => accountId.trim())
        .filter(Boolean);

    if (ids.length === 0) {
        throw new Error(`${name} must contain at least one account id.`);
    }

    return ids;
};

const parseOptionalAccountIds = (value: string | undefined) => {
    if (!value) return [];

    return value
        .split(',')
        .map(accountId => accountId.trim())
        .filter(Boolean);
};

const parseAccountAliases = (value: string | undefined) => {
    if (!value) return {};

    return value
        .split(',')
        .map(item => item.trim())
        .filter(Boolean)
        .reduce<Record<string, string>>((aliases, item) => {
            const [accountId, ...aliasParts] = item.split(':');
            const alias = aliasParts.join(':').trim();

            if (accountId?.trim() && alias) {
                aliases[accountId.trim()] = alias;
            }

            return aliases;
        }, {});
};

const parseStrategies = (value: string | undefined) => {
    if (!value) return DEFAULT_STRATEGIES;

    const strategies = value
        .split(',')
        .map(strategy => strategy.trim())
        .filter(Boolean);

    return strategies.length > 0 ? strategies : DEFAULT_STRATEGIES;
};

const parseLiveActions = (value: string | undefined) => {
    if (!value) return ['buy'] as LiveAction[];

    const actions = value
        .split(',')
        .map(action => action.trim())
        .filter((action): action is LiveAction => LIVE_ACTIONS.includes(action as LiveAction));

    return actions.length > 0 ? actions : ['buy'] as LiveAction[];
};

const parseTrailingBaseline = (value: string | undefined): TrailingBaseline => {
    if (!value) return 'observed';

    const normalized = value.trim();
    if (TRAILING_BASELINES.includes(normalized as TrailingBaseline)) {
        return normalized as TrailingBaseline;
    }

    throw new Error(`Unsupported ROBOT_TRAILING_BASELINE=${value}. Use: ${TRAILING_BASELINES.join(', ')}`);
};

const parseScanUniverse = (value: string | undefined): ScanUniverse => {
    if (!value) return 'manual';

    const normalized = value.trim().toLowerCase();
    if (SCAN_UNIVERSES.includes(normalized as ScanUniverse)) {
        return normalized as ScanUniverse;
    }

    throw new Error(`Unsupported ROBOT_SCAN_UNIVERSE=${value}. Use: ${SCAN_UNIVERSES.join(', ')}`);
};

const parseBuyScoreProfiles = (value: string | undefined) => {
    if (!value) return {};

    return value
        .split(',')
        .map(item => item.trim())
        .filter(Boolean)
        .reduce<Record<string, BuyScoreProfile>>((profiles, item) => {
            const [ticker, trendDays, minScore] = item.split(':').map(part => part.trim());
            const parsedTrendDays = Number(trendDays);
            const parsedMinScore = Number(minScore);

            if (
                ticker
                && Number.isFinite(parsedTrendDays)
                && parsedTrendDays >= 2
                && Number.isFinite(parsedMinScore)
                && parsedMinScore >= 1
            ) {
                profiles[ticker.toUpperCase()] = {
                    buyTrendDays: Math.trunc(parsedTrendDays),
                    buyMinScore: Math.min(100, Math.trunc(parsedMinScore))
                };
            }

            return profiles;
        }, {});
};

export interface RobotConfig {
    accountIds: string[];
    observeAccountIds: string[];
    accountAliases: Record<string, string>;
    protectedAccountIds: string[];
    dryRun: boolean;
    liveConfirmationRequired: boolean;
    liveAllowedActions: LiveAction[];
    tradingPaused: boolean;
    maxConsecutiveTickErrors: number;
    snapshotIntervalMs: number;
    intervalMs: number;
    positionDelayMs: number;
    enabledStrategies: string[];
    minProfitMultiplier: number;
    minProfitPercent: number;
    stopLossPercent: number;
    stopLossVolatilityDays: number;
    stopLossVolatilityMultiplier: number;
    stopLossMaxPercent: number;
    trailingStopPercent: number;
    trailingStopMinProfitPercent: number;
    trailingStopVolatilityDays: number;
    trailingStopVolatilityMultiplier: number;
    trailingBaseline: TrailingBaseline;
    sellHoldWinnerMinProfitPercent: number;
    sellHoldWinnerMaxDrawdownPercent: number;
    maxLotsPerOrder: number;
    buyTickers: string[];
    scanTickers: string[];
    scanUniverse: ScanUniverse;
    scanUniverseLimit: number;
    scanMaxLotRub: number;
    buyTrendDays: number;
    buyMinTrendPercent: number;
    buyMinMomentumPercent: number;
    buyMinScore: number;
    buyScoreProfiles: Record<string, BuyScoreProfile>;
    maxOrderRub: number;
    maxDailyOrders: number;
    maxDailyRub: number;
    maxRuntimeOrderRub: number;
    maxRuntimeDailyOrders: number;
    maxRuntimeDailyRub: number;
    maxPositionSharePercent: number;
    minDiversificationPositions: number;
    diversificationFirst: boolean;
    liquidityRiskEnabled: boolean;
    liquidityRiskEnforced: boolean;
    maxSpreadPercent: number;
    minOrderbookAskRub: number;
    minDailyTurnoverRub: number;
    sectorRiskEnabled: boolean;
    sectorRiskEnforced: boolean;
    maxSectorSharePercent: number;
    signalCooldownMs: number;
    signalPriceChangePercent: number;
    buySignalJournalIntervalMs: number;
    marketRegimeEnabled: boolean;
    marketRegimeTickers: string[];
    marketRegimeDays: number;
    marketRegimeMinHealthPercent: number;
    marketRegimeMinAvgTrendPercent: number;
    paperTradingEnabled: boolean;
    paperTradingIntervalMs: number;
    paperMaxPositions: number;
    paperMaxPositionRub: number;
    paperCommissionPercent: number;
    paperReentryCooldownMs: number;
    socialConsensusEnabled: boolean;
    socialConsensusDays: number;
    socialConsensusMaxScoreAdjustment: number;
    socialConsensusMinActors: number;
    analystConsensusEnabled: boolean;
    analystConsensusMaxScoreAdjustment: number;
    technicalScoreEnabled: boolean;
    technicalMaxScoreAdjustment: number;
}

export const getRobotConfig = (): RobotConfig => {
    const env = getEnv();
    const minProfitPercent = parseNumber(env.ROBOT_MIN_PROFIT_PERCENT, 0.5);
    const accountIds = parseAccountIds(env.ROBOT_ACCOUNT_IDS, 'ROBOT_ACCOUNT_IDS');
    const observeAccountIds = parseOptionalAccountIds(env.ROBOT_OBSERVE_ACCOUNT_IDS);
    const accountAliases = parseAccountAliases(env.ROBOT_ACCOUNT_ALIASES);
    const protectedAccountIds = parseOptionalAccountIds(env.ROBOT_PROTECTED_ACCOUNT_IDS);
    const protectedAccountIdSet = new Set(protectedAccountIds);
    const forbiddenAccountIds = accountIds.filter(accountId => protectedAccountIdSet.has(accountId));
    const dryRun = parseBoolean(env.ROBOT_DRY_RUN, true);

    if (forbiddenAccountIds.length > 0) {
        throw new Error(`Protected accounts cannot be traded: ${forbiddenAccountIds.join(', ')}`);
    }

    if (!dryRun && env.ROBOT_LIVE_CONFIRMATION !== LIVE_CONFIRMATION) {
        throw new Error(`Live trading requires ROBOT_LIVE_CONFIRMATION=${LIVE_CONFIRMATION}`);
    }

    const buyTickers = parseOptionalAccountIds(env.ROBOT_BUY_TICKERS).map(ticker => ticker.toUpperCase());
    const scanTickers = parseOptionalAccountIds(env.ROBOT_SCAN_TICKERS).map(ticker => ticker.toUpperCase());
    const maxOrderRub = Math.max(0, parseNumber(env.ROBOT_MAX_ORDER_RUB, 1_000));
    const maxDailyOrders = Math.max(0, Math.trunc(parseNumber(env.ROBOT_MAX_DAILY_ORDERS, 3)));
    const maxDailyRub = Math.max(0, parseNumber(env.ROBOT_MAX_DAILY_RUB, 2_000));

    return {
        accountIds,
        observeAccountIds,
        accountAliases,
        protectedAccountIds,
        dryRun,
        liveConfirmationRequired: !dryRun,
        liveAllowedActions: parseLiveActions(env.ROBOT_LIVE_ALLOWED_ACTIONS),
        tradingPaused: parseBoolean(env.ROBOT_TRADING_PAUSED, false),
        maxConsecutiveTickErrors: Math.max(1, Math.trunc(parseNumber(env.ROBOT_MAX_CONSECUTIVE_TICK_ERRORS, 3))),
        snapshotIntervalMs: Math.max(0, parseNumber(env.ROBOT_SNAPSHOT_INTERVAL_MS, 15 * 60 * 1000)),
        intervalMs: parseNumber(env.ROBOT_INTERVAL_MS, 60_000),
        positionDelayMs: parseNumber(env.ROBOT_POSITION_DELAY_MS, 1_000),
        enabledStrategies: parseStrategies(env.ROBOT_ENABLED_STRATEGIES),
        minProfitMultiplier: 1 + minProfitPercent / 100,
        minProfitPercent,
        stopLossPercent: parseNumber(env.ROBOT_STOP_LOSS_PERCENT, 3),
        stopLossVolatilityDays: Math.max(2, Math.trunc(parseNumber(env.ROBOT_STOP_LOSS_VOLATILITY_DAYS, 14))),
        stopLossVolatilityMultiplier: Math.max(0, parseNumber(env.ROBOT_STOP_LOSS_VOLATILITY_MULTIPLIER, 1)),
        stopLossMaxPercent: Math.max(0, parseNumber(env.ROBOT_STOP_LOSS_MAX_PERCENT, 8)),
        trailingStopPercent: parseNumber(env.ROBOT_TRAILING_STOP_PERCENT, 2),
        trailingStopMinProfitPercent: parseNumber(env.ROBOT_TRAILING_STOP_MIN_PROFIT_PERCENT, minProfitPercent),
        trailingStopVolatilityDays: Math.max(2, Math.trunc(parseNumber(env.ROBOT_TRAILING_STOP_VOLATILITY_DAYS, 14))),
        trailingStopVolatilityMultiplier: Math.max(0, parseNumber(env.ROBOT_TRAILING_STOP_VOLATILITY_MULTIPLIER, 1)),
        trailingBaseline: parseTrailingBaseline(env.ROBOT_TRAILING_BASELINE),
        sellHoldWinnerMinProfitPercent: Math.max(
            minProfitPercent,
            parseNumber(env.ROBOT_SELL_HOLD_WINNER_MIN_PROFIT_PERCENT, 2)
        ),
        sellHoldWinnerMaxDrawdownPercent: Math.max(0, parseNumber(env.ROBOT_SELL_HOLD_WINNER_MAX_DRAWDOWN_PERCENT, 1)),
        maxLotsPerOrder: Math.max(1, Math.trunc(parseNumber(env.ROBOT_MAX_LOTS_PER_ORDER, 1))),
        buyTickers,
        scanTickers: scanTickers.length > 0 ? scanTickers : buyTickers,
        scanUniverse: parseScanUniverse(env.ROBOT_SCAN_UNIVERSE),
        scanUniverseLimit: Math.max(1, Math.trunc(parseNumber(env.ROBOT_SCAN_UNIVERSE_LIMIT, 150))),
        scanMaxLotRub: Math.max(0, parseNumber(env.ROBOT_SCAN_MAX_LOT_RUB, 10_000)),
        buyTrendDays: Math.max(2, Math.trunc(parseNumber(env.ROBOT_BUY_TREND_DAYS, 20))),
        buyMinTrendPercent: parseNumber(env.ROBOT_BUY_MIN_TREND_PERCENT, 0.5),
        buyMinMomentumPercent: parseNumber(env.ROBOT_BUY_MIN_MOMENTUM_PERCENT, 0),
        buyMinScore: Math.max(1, Math.min(100, parseNumber(env.ROBOT_BUY_MIN_SCORE, 70))),
        buyScoreProfiles: parseBuyScoreProfiles(env.ROBOT_BUY_SCORE_PROFILES),
        maxOrderRub,
        maxDailyOrders,
        maxDailyRub,
        maxRuntimeOrderRub: Math.max(0, parseNumber(env.ROBOT_MAX_RUNTIME_ORDER_RUB, maxOrderRub)),
        maxRuntimeDailyOrders: Math.max(0, Math.trunc(parseNumber(env.ROBOT_MAX_RUNTIME_DAILY_ORDERS, maxDailyOrders))),
        maxRuntimeDailyRub: Math.max(0, parseNumber(env.ROBOT_MAX_RUNTIME_DAILY_RUB, maxDailyRub)),
        maxPositionSharePercent: Math.max(0, Math.min(100, parseNumber(env.ROBOT_MAX_POSITION_SHARE_PERCENT, 15))),
        minDiversificationPositions: Math.max(0, Math.trunc(parseNumber(env.ROBOT_MIN_DIVERSIFICATION_POSITIONS, 5))),
        diversificationFirst: parseBoolean(env.ROBOT_DIVERSIFICATION_FIRST, true),
        liquidityRiskEnabled: parseBoolean(env.ROBOT_LIQUIDITY_RISK_ENABLED, true),
        liquidityRiskEnforced: parseBoolean(env.ROBOT_LIQUIDITY_RISK_ENFORCED, false),
        maxSpreadPercent: Math.max(0, parseNumber(env.ROBOT_MAX_SPREAD_PERCENT, 0.5)),
        minOrderbookAskRub: Math.max(0, parseNumber(env.ROBOT_MIN_ORDERBOOK_ASK_RUB, 50_000)),
        minDailyTurnoverRub: Math.max(0, parseNumber(env.ROBOT_MIN_DAILY_TURNOVER_RUB, 3_000_000)),
        sectorRiskEnabled: parseBoolean(env.ROBOT_SECTOR_RISK_ENABLED, true),
        sectorRiskEnforced: parseBoolean(env.ROBOT_SECTOR_RISK_ENFORCED, false),
        maxSectorSharePercent: Math.max(0, Math.min(100, parseNumber(env.ROBOT_MAX_SECTOR_SHARE_PERCENT, 40))),
        signalCooldownMs: Math.max(0, parseNumber(env.ROBOT_SIGNAL_COOLDOWN_MS, 30 * 60 * 1000)),
        signalPriceChangePercent: Math.max(0, parseNumber(env.ROBOT_SIGNAL_PRICE_CHANGE_PERCENT, 1)),
        buySignalJournalIntervalMs: Math.max(0, parseNumber(env.ROBOT_BUY_SIGNAL_JOURNAL_INTERVAL_MS, 15 * 60 * 1000)),
        marketRegimeEnabled: parseBoolean(env.ROBOT_MARKET_REGIME_ENABLED, true),
        marketRegimeTickers: (parseOptionalAccountIds(env.ROBOT_MARKET_REGIME_TICKERS).length > 0
            ? parseOptionalAccountIds(env.ROBOT_MARKET_REGIME_TICKERS)
            : ['SBER', 'LKOH', 'GAZP', 'YDEX', 'MOEX']
        ).map(ticker => ticker.toUpperCase()),
        marketRegimeDays: Math.max(2, Math.trunc(parseNumber(env.ROBOT_MARKET_REGIME_DAYS, 20))),
        marketRegimeMinHealthPercent: Math.max(0, Math.min(100, parseNumber(env.ROBOT_MARKET_REGIME_MIN_HEALTH_PERCENT, 40))),
        marketRegimeMinAvgTrendPercent: parseNumber(env.ROBOT_MARKET_REGIME_MIN_AVG_TREND_PERCENT, -1),
        paperTradingEnabled: parseBoolean(env.ROBOT_PAPER_TRADING_ENABLED, true),
        paperTradingIntervalMs: Math.max(0, parseNumber(env.ROBOT_PAPER_TRADING_INTERVAL_MS, 15 * 60 * 1000)),
        paperMaxPositions: Math.max(1, Math.trunc(parseNumber(env.ROBOT_PAPER_MAX_POSITIONS, 10))),
        paperMaxPositionRub: Math.max(0, parseNumber(env.ROBOT_PAPER_MAX_POSITION_RUB, 1_000)),
        paperCommissionPercent: Math.max(0, parseNumber(env.ROBOT_PAPER_COMMISSION_PERCENT, 0.05)),
        paperReentryCooldownMs: Math.max(0, parseNumber(env.ROBOT_PAPER_REENTRY_COOLDOWN_MS, 3 * 60 * 60 * 1000)),
        socialConsensusEnabled: parseBoolean(env.ROBOT_SOCIAL_CONSENSUS_ENABLED, true),
        socialConsensusDays: Math.max(1, Math.trunc(parseNumber(env.ROBOT_SOCIAL_CONSENSUS_DAYS, 3))),
        socialConsensusMaxScoreAdjustment: Math.max(0, Math.min(25, parseNumber(env.ROBOT_SOCIAL_CONSENSUS_MAX_SCORE_ADJUSTMENT, 10))),
        socialConsensusMinActors: Math.max(1, Math.trunc(parseNumber(env.ROBOT_SOCIAL_CONSENSUS_MIN_ACTORS, 1))),
        analystConsensusEnabled: parseBoolean(env.ROBOT_ANALYST_CONSENSUS_ENABLED, true),
        analystConsensusMaxScoreAdjustment: Math.max(0, Math.min(15, parseNumber(env.ROBOT_ANALYST_CONSENSUS_MAX_SCORE_ADJUSTMENT, 5))),
        technicalScoreEnabled: parseBoolean(env.ROBOT_TECHNICAL_SCORE_ENABLED, true),
        technicalMaxScoreAdjustment: Math.max(0, Math.min(15, parseNumber(env.ROBOT_TECHNICAL_MAX_SCORE_ADJUSTMENT, 5)))
    };
};

export const getBuyScoreConfigForTicker = (config: RobotConfig, ticker?: string): RobotConfig => {
    const profile = ticker ? config.buyScoreProfiles[ticker.toUpperCase()] : undefined;

    if (!profile) return config;

    return {
        ...config,
        buyTrendDays: profile.buyTrendDays,
        buyMinScore: profile.buyMinScore
    };
};
