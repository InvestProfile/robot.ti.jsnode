// database.ts
import { Sequelize } from 'sequelize';

import { getEnv } from './env.config';

const envVariables = getEnv();

// Предоставляем значения по умолчанию для переменных окружения
const dbName = envVariables.DB_NAME || '';
const dbUser = envVariables.DB_USER || '';
const dbPassword = envVariables.DB_PASSWORD || '';
const dbHost = envVariables.DB_HOST || '';
const dbDialect = envVariables.DB_DIALECT || '';
const dbPort = parseInt(envVariables.DB_PORT || '', 10);

if (!dbName || !dbUser || !dbHost || !dbDialect || !Number.isFinite(dbPort)) {
    throw new Error('Database config is incomplete. Check DB_NAME, DB_USER, DB_HOST, DB_DIALECT and DB_PORT.');
}

// Создаем новый экземпляр Sequelize
const sequelize = new Sequelize(dbName, dbUser, dbPassword, {
    host: dbHost,
    dialect: dbDialect as any, // Приведение типа, если TypeScript не распознает диалект как валидный
    logging: false,
    port: dbPort,
    pool: {
        max: 5,
        min: 0,
        acquire: 3000,
        idle: 1000
    }
});

export default sequelize;
