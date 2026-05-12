import DatabaseService from '../services/database.service';
import TradeJournalService from '../services/trade-journal.service';
import sequelize from '../config/database';

const main = async () => {
    const limit = Math.max(1, Math.trunc(Number(process.argv[2] ?? 500)));

    await DatabaseService.init();
    const result = await TradeJournalService.backfillMissingMetadata(limit);
    console.log(JSON.stringify(result, null, 2));
    await sequelize.close();
};

void main().catch(async error => {
    console.error(error);
    await sequelize.close().catch(() => undefined);
    process.exit(1);
});
