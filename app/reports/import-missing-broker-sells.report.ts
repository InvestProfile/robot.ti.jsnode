import sequelize from '../config/database';
import { getRobotConfig } from '../config/robot.config';
import BrokerMissingSellImportService from '../services/broker-missing-sell-import.service';
import DatabaseService from '../services/database.service';

const apply = process.argv.includes('--apply');

const format = (value: number | undefined) => {
    if (value === undefined || !Number.isFinite(value)) return '-';
    return value.toFixed(2);
};

const main = async () => {
    await DatabaseService.init();

    const result = await BrokerMissingSellImportService.importMissingSells(getRobotConfig(), { apply });

    console.log(apply ? 'Missing broker SELL import' : 'Missing broker SELL import dry-run');
    console.log('===========================');
    console.log(`checked mismatches: ${result.checkedIssues}`);
    console.log(`candidates: ${result.candidates.length}`);
    console.log(`imported: ${result.imported.length}`);
    console.log(`skipped: ${result.skipped.length}`);
    console.log('');

    for (const candidate of result.candidates) {
        console.log([
            candidate.tradeDateTime ?? '-',
            candidate.accountAlias ?? candidate.accountId,
            candidate.ticker ?? '-',
            `sell lots ${candidate.lots}`,
            `price ${format(candidate.price)}`,
            `amount ${format(candidate.amount)}`,
            `order ${candidate.orderId}`
        ].join(' | '));
    }

    if (!apply) {
        console.log('');
        console.log('Dry-run only. Re-run with --apply to write missing broker SELL fills into local trades.');
    }
};

main()
    .catch(error => {
        console.error(error);
        process.exitCode = 1;
    })
    .finally(async () => {
        await sequelize.close();
    });
