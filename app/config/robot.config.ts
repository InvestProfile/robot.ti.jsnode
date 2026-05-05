import { getEnv } from './env.config';

const LIVE_CONFIRMATION = 'I_UNDERSTAND_THIS_TRADES_REAL_MONEY';
const DEFAULT_STRATEGIES = ['stop-loss', 'trailing-stop', 'profit-take', 'trend-follow-buy', 'watchlist-buy'];
const TRAILING_BASELINES = ['observed', 'history_30d', 'history_90d'] as const;
const LIVE_ACTIONS = ['buy', 'sell'] as const;

export type TrailingBaseline = typeof TRAILING_BASELINES[number];
export type LiveAction = typeof LIVE_ACTIONS[number];

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
    trailingStopPercent: number;
    trailingBaseline: TrailingBaseline;
    maxLotsPerOrder: number;
    buyTickers: string[];
    buyTrendDays: number;
    buyMinTrendPercent: number;
    buyMinMomentumPercent: number;
    maxOrderRub: number;
    maxDailyOrders: number;
    maxDailyRub: number;
    signalCooldownMs: number;
    signalPriceChangePercent: number;
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
        trailingStopPercent: parseNumber(env.ROBOT_TRAILING_STOP_PERCENT, 2),
        trailingBaseline: parseTrailingBaseline(env.ROBOT_TRAILING_BASELINE),
        maxLotsPerOrder: Math.max(1, Math.trunc(parseNumber(env.ROBOT_MAX_LOTS_PER_ORDER, 1))),
        buyTickers: parseOptionalAccountIds(env.ROBOT_BUY_TICKERS).map(ticker => ticker.toUpperCase()),
        buyTrendDays: Math.max(2, Math.trunc(parseNumber(env.ROBOT_BUY_TREND_DAYS, 20))),
        buyMinTrendPercent: parseNumber(env.ROBOT_BUY_MIN_TREND_PERCENT, 0.5),
        buyMinMomentumPercent: parseNumber(env.ROBOT_BUY_MIN_MOMENTUM_PERCENT, 0),
        maxOrderRub: parseNumber(env.ROBOT_MAX_ORDER_RUB, 1_000),
        maxDailyOrders: Math.max(0, Math.trunc(parseNumber(env.ROBOT_MAX_DAILY_ORDERS, 3))),
        maxDailyRub: Math.max(0, parseNumber(env.ROBOT_MAX_DAILY_RUB, 2_000)),
        signalCooldownMs: Math.max(0, parseNumber(env.ROBOT_SIGNAL_COOLDOWN_MS, 30 * 60 * 1000)),
        signalPriceChangePercent: Math.max(0, parseNumber(env.ROBOT_SIGNAL_PRICE_CHANGE_PERCENT, 1))
    };
};
