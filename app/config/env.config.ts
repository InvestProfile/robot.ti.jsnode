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
    ROBOT_INTERVAL_MS: string | undefined;
    ROBOT_POSITION_DELAY_MS: string | undefined;
    ROBOT_ENABLED_STRATEGIES: string | undefined;
    ROBOT_MIN_PROFIT_PERCENT: string | undefined;
    ROBOT_STOP_LOSS_PERCENT: string | undefined;
    ROBOT_TRAILING_STOP_PERCENT: string | undefined;
    ROBOT_TRAILING_BASELINE: string | undefined;
    ROBOT_MAX_LOTS_PER_ORDER: string | undefined;
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
        ROBOT_INTERVAL_MS: process.env.ROBOT_INTERVAL_MS,
        ROBOT_POSITION_DELAY_MS: process.env.ROBOT_POSITION_DELAY_MS,
        ROBOT_ENABLED_STRATEGIES: process.env.ROBOT_ENABLED_STRATEGIES,
        ROBOT_MIN_PROFIT_PERCENT: process.env.ROBOT_MIN_PROFIT_PERCENT,
        ROBOT_STOP_LOSS_PERCENT: process.env.ROBOT_STOP_LOSS_PERCENT,
        ROBOT_TRAILING_STOP_PERCENT: process.env.ROBOT_TRAILING_STOP_PERCENT,
        ROBOT_TRAILING_BASELINE: process.env.ROBOT_TRAILING_BASELINE,
        ROBOT_MAX_LOTS_PER_ORDER: process.env.ROBOT_MAX_LOTS_PER_ORDER
    };
};
