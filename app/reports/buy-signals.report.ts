import sequelize from '../config/database';
import { getRobotConfig } from '../config/robot.config';
import DatabaseService from '../services/database.service';
import BuySignalJournalService from '../services/buy-signal-journal.service';

const format = (value: number | undefined | null, digits = 2) => {
    if (value === undefined || value === null || !Number.isFinite(value)) return '-';
    return value.toFixed(digits);
};

const time = (value: string | Date | undefined | null) => {
    if (!value) return '-';
    return new Date(value).toISOString();
};

const parseLimit = (args: string[]) => {
    const value = Number(args.find(arg => /^\d+$/.test(arg)) ?? 50);
    return Number.isFinite(value) && value > 0 ? Math.trunc(value) : 50;
};

const main = async () => {
    const args = process.argv.slice(2);
    const config = getRobotConfig();

    await DatabaseService.init();

    if (args.includes('--capture')) {
        const result = await BuySignalJournalService.capture(config);
        console.log(`Capture complete. captured=${result.captured} updated=${result.updated}`);
    } else if (args.includes('--update')) {
        const updated = await BuySignalJournalService.updatePending();
        console.log(`Update complete. updated=${updated}`);
    }

    const result = await BuySignalJournalService.list(parseLimit(args));

    console.log('Buy Signal Journal');
    console.log('==================');
    console.log('');
    console.log('Ticker  Profile  Score  Price       1d       3d       5d       10d      Signaled');
    console.log('------  -------  -----  ----------  -------  -------  -------  -------  ------------------------');

    for (const signal of result.signals) {
        console.log([
            String(signal.ticker ?? '-').padEnd(6),
            `${signal.profileTrendDays}/${signal.profileMinScore}`.padStart(7),
            String(signal.signalScore ?? '-').padStart(5),
            format(signal.signalPrice).padStart(10),
            format(signal.return1dPercent).padStart(7),
            format(signal.return3dPercent).padStart(7),
            format(signal.return5dPercent).padStart(7),
            format(signal.return10dPercent).padStart(7),
            time(signal.signaledAt)
        ].join('  '));
    }
};

void main()
    .catch(error => {
        console.error('Buy signal journal report failed:', error);
        process.exitCode = 1;
    })
    .finally(async () => {
        await sequelize.close().catch(() => undefined);
    });
