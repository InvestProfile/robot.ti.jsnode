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
}

export const getEnv = () => {
    return {
        INVEST_TOKEN: process.env.INVEST_TOKEN,
        DB_HOST: process.env.DB_HOST,
        DB_USER: process.env.DB_USER,
        DB_PASSWORD: process.env.DB_PASSWORD,
        DB_NAME: process.env.DB_NAME,
        DB_DIALECT: process.env.DB_DIALECT,
        DB_PORT: process.env.DB_PORT
    };
};
