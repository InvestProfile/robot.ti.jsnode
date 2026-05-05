import sequelize from '../config/database';
import DatabaseService from '../services/database.service';
import StrategyEvidenceService from '../services/strategy-evidence.service';

const format = (value: number | undefined | null, digits = 2) => {
    if (value === undefined || value === null || !Number.isFinite(value)) return '-';
    return value.toFixed(digits);
};

const main = async () => {
    await DatabaseService.init();

    const evidence = await StrategyEvidenceService.getEvidence();
    const returns = evidence.buySignalJournal;

    console.log('Strategy Evidence');
    console.log('=================');
    console.log(`Generated: ${evidence.generatedAt}`);
    console.log(`Buy signals: ${returns.signals}`);
    console.log(`1d: n=${returns.return1d.count} avg=${format(returns.return1d.avg)}% wr=${format(returns.return1d.winRatePercent, 0)}%`);
    console.log(`3d: n=${returns.return3d.count} avg=${format(returns.return3d.avg)}% wr=${format(returns.return3d.winRatePercent, 0)}%`);
    console.log(`5d: n=${returns.return5d.count} avg=${format(returns.return5d.avg)}% wr=${format(returns.return5d.winRatePercent, 0)}%`);
    console.log(`10d: n=${returns.return10d.count} avg=${format(returns.return10d.avg)}% wr=${format(returns.return10d.winRatePercent, 0)}%`);
    console.log('');
    console.log('Strategy          Type      Data                         Conf   WR       Avg      P/L       Fee       Status');
    console.log('----------------  --------  ---------------------------  -----  -------  -------  --------  --------  -----------');

    for (const row of evidence.strategies as Array<Record<string, unknown>>) {
        const data = [
            row.signals !== undefined ? `signals=${row.signals}` : undefined,
            row.paperPositions !== undefined ? `paper=${row.paperPositions}` : undefined,
            row.closed !== undefined ? `closed=${row.closed}` : undefined,
            row.decisions !== undefined ? `decisions=${row.decisions}` : undefined
        ].filter(Boolean).join(' ');

        console.log([
            String(row.strategy).padEnd(16),
            String(row.type).padEnd(8),
            data.padEnd(27),
            String(row.confidence ?? '-').padStart(5),
            `${format(row.winRatePercent as number | undefined, 0)}%`.padStart(7),
            `${format(row.averageProfitPercent as number | undefined)}%`.padStart(7),
            format(row.profitRub as number | undefined).padStart(8),
            format(row.commissionRub as number | undefined).padStart(8),
            String(row.status ?? '-')
        ].join('  '));
    }

    console.log('');
    console.log('Social Alpha');
    console.log('------------');
    console.log(`Signals 30d: ${evidence.socialAlpha.signals}`);
    console.log(`Actors: ${evidence.socialAlpha.actors}`);
    console.log(`Tickers: ${evidence.socialAlpha.tickers}`);
    console.log(`Avg actor return: ${format(evidence.socialAlpha.averageActorReturnPercent)}%`);
};

void main()
    .catch(error => {
        console.error('Strategy evidence report failed:', error);
        process.exitCode = 1;
    })
    .finally(async () => {
        await sequelize.close().catch(() => undefined);
    });
