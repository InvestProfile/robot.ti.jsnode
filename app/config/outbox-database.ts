import { Sequelize } from 'sequelize';
import { getEnv } from './env.config';

export const createOutboxDatabase = () => {
    const env = getEnv();
    const port = Number.parseInt(env.DB_PORT || '', 10);
    if (!env.DB_NAME || !env.DB_USER || !env.DB_HOST || env.DB_DIALECT !== 'postgres' || !Number.isFinite(port)) {
        throw new Error('Shadow outbox requires complete PostgreSQL database configuration');
    }
    return new Sequelize(env.DB_NAME, env.DB_USER, env.DB_PASSWORD, {
        host: env.DB_HOST,
        port,
        dialect: 'postgres',
        logging: false,
        pool: { max: 1, min: 0, acquire: 2_500, idle: 1_000 },
        dialectOptions: {
            statement_timeout: 2_000,
            query_timeout: 2_500,
            connectionTimeoutMillis: 2_000
        }
    });
};
