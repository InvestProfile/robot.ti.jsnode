import sequelize from '../config/database';
import { getRobotConfig } from '../config/robot.config';
import ScanUniverseService from '../services/scan-universe.service';

const format = (value: number | undefined, digits = 2) => {
    if (value === undefined || !Number.isFinite(value)) return '-';
    return value.toFixed(digits);
};

const main = async () => {
    const config = {
        ...getRobotConfig(),
        scanUniverse: 'auto' as const
    };
    const universe = await ScanUniverseService.build(config);

    console.log('Scan Universe');
    console.log('=============');
    console.log(`Mode: ${universe.mode}`);
    console.log(`Total shares: ${universe.totalShares}`);
    console.log(`Eligible before price filter: ${universe.eligibleBeforePriceFilter}`);
    console.log(`Limit: ${universe.limit}`);
    console.log(`Max lot RUB: ${universe.maxLotRub}`);
    console.log(`Selected: ${universe.items.length}`);
    console.log('');
    console.log('Ticker  Lot    Price       Lot RUB     Sector       Name');
    console.log('------  -----  ----------  ----------  -----------  ------------------------------');

    for (const item of universe.items) {
        console.log([
            item.ticker.padEnd(6),
            String(item.lot ?? '-').padStart(5),
            format(item.lastPrice).padStart(10),
            format(item.estimatedLotRub).padStart(10),
            String(item.sector ?? '-').slice(0, 11).padEnd(11),
            item.name ?? '-'
        ].join('  '));
    }
};

void main()
    .catch(error => {
        console.error('Scan universe failed:', error);
        process.exitCode = 1;
    })
    .finally(async () => {
        await sequelize.close().catch(() => undefined);
    });
