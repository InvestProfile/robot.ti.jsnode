import * as dotenv from 'dotenv';
dotenv.config();

interface EnvConfig {
    INVEST_TOKEN: string | undefined;
    DB_HOST: string | undefined;
    DB_USER: string | undefined;
    DB_PASSWORD: string | undefined;
    DB_NAME: string | undefined;
    DB_DIALECT: string | undefined;
    DB_PORT: string | undefined;
    ROBOT_ACCOUNT_IDS: string | undefined;
    ROBOT_OBSERVE_ACCOUNT_IDS: string | undefined;
    ROBOT_ACCOUNT_ALIASES: string | undefined;
    ROBOT_PROTECTED_ACCOUNT_IDS: string | undefined;
    ROBOT_DRY_RUN: string | undefined;
    ROBOT_LIVE_CONFIRMATION: string | undefined;
    ROBOT_LIVE_ALLOWED_ACTIONS: string | undefined;
    ROBOT_TRADING_PAUSED: string | undefined;
    ROBOT_MAX_CONSECUTIVE_TICK_ERRORS: string | undefined;
    ROBOT_SNAPSHOT_INTERVAL_MS: string | undefined;
    ROBOT_INTERVAL_MS: string | undefined;
    ROBOT_POSITION_DELAY_MS: string | undefined;
    ROBOT_ENABLED_STRATEGIES: string | undefined;
    ROBOT_MIN_PROFIT_PERCENT: string | undefined;
    ROBOT_STOP_LOSS_PERCENT: string | undefined;
    ROBOT_TRAILING_STOP_PERCENT: string | undefined;
    ROBOT_TRAILING_BASELINE: string | undefined;
    ROBOT_MAX_LOTS_PER_ORDER: string | undefined;
    ROBOT_BUY_TICKERS: string | undefined;
    ROBOT_BUY_TREND_DAYS: string | undefined;
    ROBOT_BUY_MIN_TREND_PERCENT: string | undefined;
    ROBOT_BUY_MIN_MOMENTUM_PERCENT: string | undefined;
    ROBOT_MAX_ORDER_RUB: string | undefined;
    ROBOT_MAX_DAILY_ORDERS: string | undefined;
    ROBOT_MAX_DAILY_RUB: string | undefined;
    ROBOT_SIGNAL_COOLDOWN_MS: string | undefined;
    ROBOT_SIGNAL_PRICE_CHANGE_PERCENT: string | undefined;
    ROBOT_HTTP_ENABLED: string | undefined;
    ROBOT_HTTP_PORT: string | undefined;
    ROBOT_WEB_USERNAME: string | undefined;
    ROBOT_WEB_PASSWORD: string | undefined;
}

export const getEnv = () => {
    return {
        INVEST_TOKEN: process.env.INVEST_TOKEN,
        DB_HOST: process.env.DB_HOST,
        DB_USER: process.env.DB_USER,
        DB_PASSWORD: process.env.DB_PASSWORD,
        DB_NAME: process.env.DB_NAME,
        DB_DIALECT: process.env.DB_DIALECT,
        DB_PORT: process.env.DB_PORT,
        ROBOT_ACCOUNT_IDS: process.env.ROBOT_ACCOUNT_IDS,
        ROBOT_OBSERVE_ACCOUNT_IDS: process.env.ROBOT_OBSERVE_ACCOUNT_IDS,
        ROBOT_ACCOUNT_ALIASES: process.env.ROBOT_ACCOUNT_ALIASES,
        ROBOT_PROTECTED_ACCOUNT_IDS: process.env.ROBOT_PROTECTED_ACCOUNT_IDS,
        ROBOT_DRY_RUN: process.env.ROBOT_DRY_RUN,
        ROBOT_LIVE_CONFIRMATION: process.env.ROBOT_LIVE_CONFIRMATION,
        ROBOT_LIVE_ALLOWED_ACTIONS: process.env.ROBOT_LIVE_ALLOWED_ACTIONS,
        ROBOT_TRADING_PAUSED: process.env.ROBOT_TRADING_PAUSED,
        ROBOT_MAX_CONSECUTIVE_TICK_ERRORS: process.env.ROBOT_MAX_CONSECUTIVE_TICK_ERRORS,
        ROBOT_SNAPSHOT_INTERVAL_MS: process.env.ROBOT_SNAPSHOT_INTERVAL_MS,
        ROBOT_INTERVAL_MS: process.env.ROBOT_INTERVAL_MS,
        ROBOT_POSITION_DELAY_MS: process.env.ROBOT_POSITION_DELAY_MS,
        ROBOT_ENABLED_STRATEGIES: process.env.ROBOT_ENABLED_STRATEGIES,
        ROBOT_MIN_PROFIT_PERCENT: process.env.ROBOT_MIN_PROFIT_PERCENT,
        ROBOT_STOP_LOSS_PERCENT: process.env.ROBOT_STOP_LOSS_PERCENT,
        ROBOT_TRAILING_STOP_PERCENT: process.env.ROBOT_TRAILING_STOP_PERCENT,
        ROBOT_TRAILING_BASELINE: process.env.ROBOT_TRAILING_BASELINE,
        ROBOT_MAX_LOTS_PER_ORDER: process.env.ROBOT_MAX_LOTS_PER_ORDER,
        ROBOT_BUY_TICKERS: process.env.ROBOT_BUY_TICKERS,
        ROBOT_BUY_TREND_DAYS: process.env.ROBOT_BUY_TREND_DAYS,
        ROBOT_BUY_MIN_TREND_PERCENT: process.env.ROBOT_BUY_MIN_TREND_PERCENT,
        ROBOT_BUY_MIN_MOMENTUM_PERCENT: process.env.ROBOT_BUY_MIN_MOMENTUM_PERCENT,
        ROBOT_MAX_ORDER_RUB: process.env.ROBOT_MAX_ORDER_RUB,
        ROBOT_MAX_DAILY_ORDERS: process.env.ROBOT_MAX_DAILY_ORDERS,
        ROBOT_MAX_DAILY_RUB: process.env.ROBOT_MAX_DAILY_RUB,
        ROBOT_SIGNAL_COOLDOWN_MS: process.env.ROBOT_SIGNAL_COOLDOWN_MS,
        ROBOT_SIGNAL_PRICE_CHANGE_PERCENT: process.env.ROBOT_SIGNAL_PRICE_CHANGE_PERCENT,
        ROBOT_HTTP_ENABLED: process.env.ROBOT_HTTP_ENABLED,
        ROBOT_HTTP_PORT: process.env.ROBOT_HTTP_PORT,
        ROBOT_WEB_USERNAME: process.env.ROBOT_WEB_USERNAME,
        ROBOT_WEB_PASSWORD: process.env.ROBOT_WEB_PASSWORD
    };
};
