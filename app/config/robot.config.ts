import { getEnv } from './env.config';

const LIVE_CONFIRMATION = 'I_UNDERSTAND_THIS_TRADES_REAL_MONEY';
const DEFAULT_STRATEGIES = ['stop-loss', 'trailing-stop', 'profit-take'];

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

export interface RobotConfig {
    accountIds: string[];
    observeAccountIds: string[];
    accountAliases: Record<string, string>;
    protectedAccountIds: string[];
    dryRun: boolean;
    liveConfirmationRequired: boolean;
    intervalMs: number;
    positionDelayMs: number;
    enabledStrategies: string[];
    minProfitMultiplier: number;
    minProfitPercent: number;
    stopLossPercent: number;
    trailingStopPercent: number;
    maxLotsPerOrder: number;
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
        intervalMs: parseNumber(env.ROBOT_INTERVAL_MS, 60_000),
        positionDelayMs: parseNumber(env.ROBOT_POSITION_DELAY_MS, 1_000),
        enabledStrategies: parseStrategies(env.ROBOT_ENABLED_STRATEGIES),
        minProfitMultiplier: 1 + minProfitPercent / 100,
        minProfitPercent,
        stopLossPercent: parseNumber(env.ROBOT_STOP_LOSS_PERCENT, 3),
        trailingStopPercent: parseNumber(env.ROBOT_TRAILING_STOP_PERCENT, 2),
        maxLotsPerOrder: Math.max(1, Math.trunc(parseNumber(env.ROBOT_MAX_LOTS_PER_ORDER, 1)))
    };
};
