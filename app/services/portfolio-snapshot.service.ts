import { Op } from 'sequelize';
import { RobotConfig } from '../config/robot.config';
import { PortfolioSnapshotModel } from '../models/portfolio-snapshot.model';
import OperationsService from './operations.service';
import { quotationToNumber } from '../utils/money';

type AccountMode = 'trade' | 'observe';

const getAccounts = (config: RobotConfig) => [
    ...config.accountIds.map(accountId => ({ accountId, mode: 'trade' as AccountMode })),
    ...config.observeAccountIds.map(accountId => ({ accountId, mode: 'observe' as AccountMode }))
];

export default class PortfolioSnapshotService {
    private static async shouldWriteSnapshot(accountId: string, intervalMs: number) {
        if (intervalMs <= 0) return true;

        const since = new Date(Date.now() - intervalMs);
        const recent = await PortfolioSnapshotModel.findOne({
            where: {
                accountId,
                createdAt: {
                    [Op.gte]: since
                }
            } as any,
            order: [['createdAt', 'DESC']]
        });

        return !recent;
    }

    static async capture(config: RobotConfig) {
        const snapshots = [];

        for (const account of getAccounts(config)) {
            if (!await this.shouldWriteSnapshot(account.accountId, config.snapshotIntervalMs)) {
                continue;
            }

            const portfolio = await OperationsService.getPortfolio(account.accountId);
            const snapshot = await PortfolioSnapshotModel.create({
                accountId: account.accountId,
                accountAlias: config.accountAliases[account.accountId],
                accountMode: account.mode,
                cashRub: quotationToNumber(portfolio?.totalAmountCurrencies),
                totalRub: quotationToNumber(portfolio?.totalAmountPortfolio),
                positionsCount: portfolio?.positions?.length ?? 0
            });

            snapshots.push(snapshot);
        }

        if (snapshots.length > 0) {
            console.log(`Portfolio snapshots captured: ${snapshots.length}`);
        }

        return snapshots;
    }
}
