import sequelize from '../config/database';
import { PositionStateModel } from '../models/position-state.model';
import { SignalStateModel } from '../models/signal-state.model';
import { TradeDecisionModel } from '../models/trade-decision.model';
import { TradesModel } from '../models/trades.model';

export default class DatabaseService {
    static async init() {
        await sequelize.authenticate();
        await TradesModel.sync({ alter: true });
        await TradeDecisionModel.sync({ alter: true });
        await PositionStateModel.sync({ alter: true });
        await SignalStateModel.sync({ alter: true });

        console.log('Database connection: OK');
        console.log('Database models: trades, trade_decisions, position_states, signal_states synced');
    }
}
