import sequelize from '../config/database';
import DatabaseService from '../services/database.service';
import SocialSignalEvidenceService from '../services/social-signal-evidence.service';

const format = (value: number | undefined | null, digits = 2) => {
    if (value === undefined || value === null || !Number.isFinite(value)) return '-';
    return value.toFixed(digits);
};

const main = async () => {
    await DatabaseService.init();

    const evidence = await SocialSignalEvidenceService.getEvidence(200);

    console.log('Social Signal Evidence');
    console.log('======================');
    console.log(`Generated: ${evidence.generatedAt}`);
    console.log(`Signals: ${evidence.signals}`);
    console.log(`Measured: ${evidence.measured}`);
    console.log('');

    for (const [horizon, row] of Object.entries(evidence.summary)) {
        console.log(`${horizon}: n=${row.count} avg=${format(row.avgActionReturnPercent)}% raw=${format(row.avgReturnPercent)}% wr=${format(row.winRatePercent, 0)}%`);
    }

    console.log('');
    console.log('Time                  Actor             Ticker  Act   Price       1d      3d      5d      10d     Status');
    console.log('--------------------  ----------------  ------  ----  ----------  ------  ------  ------  ------  --------');

    for (const row of evidence.rows.slice(0, 80)) {
        console.log([
            new Date(row.observedAt).toISOString().slice(0, 19).replace('T', ' ').padEnd(20),
            String(row.actorName || row.actorKey).slice(0, 16).padEnd(16),
            row.ticker.padEnd(6),
            row.action.padEnd(4),
            format(row.signalPrice).padStart(10),
            `${format(row.actionReturn1dPercent)}%`.padStart(6),
            `${format(row.actionReturn3dPercent)}%`.padStart(6),
            `${format(row.actionReturn5dPercent)}%`.padStart(6),
            `${format(row.actionReturn10dPercent)}%`.padStart(6),
            row.status
        ].join('  '));
    }
};

void main()
    .catch(error => {
        console.error('Social evidence report failed:', error);
        process.exitCode = 1;
    })
    .finally(async () => {
        await sequelize.close().catch(() => undefined);
    });
