import { PortfolioSnapshotModel } from '../models/portfolio-snapshot.model';

interface SnapshotRow {
    accountId: string;
    accountAlias?: string;
    accountMode: string;
    totalRub?: number;
    cashRub?: number;
    positionsCount?: number;
    createdAt?: Date;
}

const toPlainSnapshot = (snapshot: PortfolioSnapshotModel): SnapshotRow => {
    const data = snapshot.get({ plain: true }) as Record<string, unknown>;

    return {
        accountId: String(data.accountId),
        accountAlias: data.accountAlias ? String(data.accountAlias) : undefined,
        accountMode: String(data.accountMode),
        totalRub: typeof data.totalRub === 'number' ? data.totalRub : undefined,
        cashRub: typeof data.cashRub === 'number' ? data.cashRub : undefined,
        positionsCount: typeof data.positionsCount === 'number' ? data.positionsCount : undefined,
        createdAt: data.createdAt instanceof Date ? data.createdAt : undefined
    };
};

const percentChange = (current: number | undefined, base: number | undefined) => {
    if (current === undefined || base === undefined || base <= 0) return undefined;
    return (current / base - 1) * 100;
};

const calculateMaxDrawdown = (snapshots: SnapshotRow[]) => {
    let peak: number | undefined;
    let maxDrawdownRub = 0;
    let maxDrawdownPercent = 0;

    for (const snapshot of snapshots) {
        const total = snapshot.totalRub;
        if (total === undefined) continue;

        if (peak === undefined || total > peak) {
            peak = total;
            continue;
        }

        const drawdownRub = peak - total;
        const drawdownPercent = peak > 0 ? (drawdownRub / peak) * 100 : 0;

        if (drawdownPercent > maxDrawdownPercent) {
            maxDrawdownRub = drawdownRub;
            maxDrawdownPercent = drawdownPercent;
        }
    }

    return {
        maxDrawdownRub,
        maxDrawdownPercent
    };
};

export default class PerformanceService {
    static async getPerformance(accountIdFilter?: string | null) {
        const rows = await PortfolioSnapshotModel.findAll({
            where: accountIdFilter ? { accountId: accountIdFilter } : undefined,
            order: [['accountId', 'ASC'], ['createdAt', 'ASC']]
        });
        const byAccount = new Map<string, SnapshotRow[]>();

        for (const row of rows.map(toPlainSnapshot)) {
            const accountRows = byAccount.get(row.accountId) ?? [];
            accountRows.push(row);
            byAccount.set(row.accountId, accountRows);
        }

        const accounts = Array.from(byAccount.entries()).map(([accountId, snapshots]) => {
            const first = snapshots.find(snapshot => snapshot.totalRub !== undefined);
            const latest = snapshots.slice().reverse().find(snapshot => snapshot.totalRub !== undefined);
            const previous = snapshots.length > 1 ? snapshots[snapshots.length - 2] : undefined;
            const totalChangeRub = latest?.totalRub !== undefined && first?.totalRub !== undefined
                ? latest.totalRub - first.totalRub
                : undefined;
            const periodChangeRub = latest?.totalRub !== undefined && previous?.totalRub !== undefined
                ? latest.totalRub - previous.totalRub
                : undefined;

            return {
                accountId,
                accountAlias: latest?.accountAlias ?? first?.accountAlias,
                accountMode: latest?.accountMode ?? first?.accountMode,
                snapshotsCount: snapshots.length,
                firstAt: first?.createdAt,
                latestAt: latest?.createdAt,
                firstTotalRub: first?.totalRub,
                latestTotalRub: latest?.totalRub,
                latestCashRub: latest?.cashRub,
                latestPositionsCount: latest?.positionsCount,
                totalChangeRub,
                totalChangePercent: percentChange(latest?.totalRub, first?.totalRub),
                periodChangeRub,
                periodChangePercent: percentChange(latest?.totalRub, previous?.totalRub),
                ...calculateMaxDrawdown(snapshots)
            };
        });

        return { accounts };
    }
}
