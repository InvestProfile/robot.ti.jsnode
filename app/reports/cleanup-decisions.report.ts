import sequelize from '../config/database';
import { TradeDecisionModel } from '../models/trade-decision.model';
import { Op, QueryTypes } from 'sequelize';

const getKeepHours = () => {
    const value = Number(process.env.CLEANUP_KEEP_HOURS ?? process.argv[2] ?? 24);
    return Number.isFinite(value) && value > 0 ? value : 24;
};

const getApply = () => process.env.CLEANUP_APPLY === 'true';

const getBackupTableName = () => {
    const stamp = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
    return `trade_decisions_cleanup_${stamp}`;
};

const main = async () => {
    const keepHours = getKeepHours();
    const apply = getApply();
    const cutoff = new Date(Date.now() - keepHours * 60 * 60 * 1000);
    const where = {
        status: {
            [Op.in]: ['dry-run', 'skip']
        },
        createdAt: {
            [Op.lt]: cutoff
        }
    };
    const before = await TradeDecisionModel.count();
    const deletable = await TradeDecisionModel.count({ where });

    if (!apply) {
        console.log(JSON.stringify({
            apply,
            keepHours,
            cutoff,
            before,
            deletable,
            after: before - deletable
        }, null, 2));
        return;
    }

    const backupTable = getBackupTableName();
    await sequelize.query(
        `CREATE TABLE ${backupTable} AS
         SELECT *
         FROM trade_decisions
         WHERE status IN (:statuses)
           AND "createdAt" < :cutoff`,
        {
            replacements: {
                statuses: ['dry-run', 'skip'],
                cutoff
            }
        }
    );

    const backupRows = await sequelize.query<{ count: number }>(
        `SELECT COUNT(*)::int AS count FROM ${backupTable}`,
        { type: QueryTypes.SELECT }
    );
    const backupCount = Number(backupRows[0]?.count ?? 0);

    if (backupCount !== deletable) {
        throw new Error(`Backup count mismatch: backup=${backupCount}, deletable=${deletable}`);
    }

    const deleted = await TradeDecisionModel.destroy({ where });
    await sequelize.query('VACUUM ANALYZE trade_decisions');
    const after = await TradeDecisionModel.count();

    console.log(JSON.stringify({
        apply,
        keepHours,
        cutoff,
        backupTable,
        before,
        backupCount,
        deleted,
        after
    }, null, 2));
};

void main()
    .catch(error => {
        console.error('Failed to cleanup decisions:', error);
        process.exitCode = 1;
    })
    .finally(async () => {
        await sequelize.close().catch(() => undefined);
    });
