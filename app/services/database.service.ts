import sequelize from '../config/database';
import { TradesModel } from '../models/trades.model';

export default class DatabaseService {
    static async init() {
        await sequelize.authenticate();
        await TradesModel.sync();

        console.log('Database connection: OK');
        console.log('Database models: trades synced');
    }
}
