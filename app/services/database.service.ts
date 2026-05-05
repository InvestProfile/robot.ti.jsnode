import sequelize from '../config/database';
import { PositionStateModel } from '../models/position-state.model';
import { PortfolioSnapshotModel } from '../models/portfolio-snapshot.model';
import { SignalStateModel } from '../models/signal-state.model';
import { TradeDecisionModel } from '../models/trade-decision.model';
import { TradesModel } from '../models/trades.model';
import { BuySignalJournalModel } from '../models/buy-signal-journal.model';

export default class DatabaseService {
    static async init() {
        await sequelize.authenticate();
        await TradesModel.sync({ alter: true });
        await TradeDecisionModel.sync({ alter: true });
        await PortfolioSnapshotModel.sync({ alter: true });
        await PositionStateModel.sync({ alter: true });
        await SignalStateModel.sync({ alter: true });
        await BuySignalJournalModel.sync({ alter: true });

        console.log('Database connection: OK');
        console.log('Database models: trades, trade_decisions, portfolio_snapshots, position_states, signal_states, buy_signal_journal synced');
    }
}
