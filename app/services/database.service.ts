import sequelize from '../config/database';
import { PositionStateModel } from '../models/position-state.model';
import { PortfolioSnapshotModel } from '../models/portfolio-snapshot.model';
import { SignalStateModel } from '../models/signal-state.model';
import { TradeDecisionModel } from '../models/trade-decision.model';
import { TradesModel } from '../models/trades.model';
import { BuySignalJournalModel } from '../models/buy-signal-journal.model';
import { PaperPositionModel } from '../models/paper-position.model';
import { SocialProfileModel } from '../models/social-profile.model';
import { SocialSignalModel } from '../models/social-signal.model';
import { RuntimeAccountModeModel } from '../models/runtime-account-mode.model';

export default class DatabaseService {
    static async init() {
        await sequelize.authenticate();
        await TradesModel.sync({ alter: true });
        await TradeDecisionModel.sync({ alter: true });
        await PortfolioSnapshotModel.sync({ alter: true });
        await PositionStateModel.sync({ alter: true });
        await SignalStateModel.sync({ alter: true });
        await BuySignalJournalModel.sync({ alter: true });
        await PaperPositionModel.sync({ alter: true });
        await SocialProfileModel.sync({ alter: true });
        await SocialSignalModel.sync({ alter: true });
        await RuntimeAccountModeModel.sync({ alter: true });

        console.log('Database connection: OK');
        console.log('Database models: trades, trade_decisions, portfolio_snapshots, position_states, signal_states, buy_signal_journal, paper_positions, social_profiles, social_signals, runtime_account_modes synced');
    }
}
