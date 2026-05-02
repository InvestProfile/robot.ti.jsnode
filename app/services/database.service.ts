import sequelize from '../config/database';
import { TradeDecisionModel } from '../models/trade-decision.model';
import { TradesModel } from '../models/trades.model';

export default class DatabaseService {
    static async init() {
        await sequelize.authenticate();
        await TradesModel.sync();
        await TradeDecisionModel.sync();

        console.log('Database connection: OK');
        console.log('Database models: trades, trade_decisions synced');
    }
}
