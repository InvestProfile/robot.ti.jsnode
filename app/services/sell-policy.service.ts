import { Op } from 'sequelize';
import { TradesModel } from '../models/trades.model';

const BLOCKED_STATUSES = new Set([
    'EXECUTION_REPORT_STATUS_REJECTED',
    'EXECUTION_REPORT_STATUS_CANCELLED'
]);

const sameInstrument = (data: Record<string, unknown>, figi?: string, instrumentUid?: string) =>
    Boolean(
        (instrumentUid && (data.instrumentUid === instrumentUid || data.instrumentId === instrumentUid || data.uid === instrumentUid))
        || (figi && data.figi === figi)
    );

const lotsFromTrade = (data: Record<string, unknown>) => {
    const executed = Number(data.lotsExecuted ?? 0);
    if (Number.isFinite(executed) && executed > 0) return executed;

    const requested = Number(data.lotsRequested ?? 0);
    if (Number.isFinite(requested) && requested > 0) return requested;

    const lot = Number(data.lot ?? data.quantity ?? 0);
    return Number.isFinite(lot) && lot > 0 ? lot : 0;
};

export default class SellPolicyService {
    static async getRobotOwnedLots(accountId: string, figi?: string, instrumentUid?: string) {
        if (!accountId || (!figi && !instrumentUid)) return 0;

        const trades = await TradesModel.findAll({
            where: {
                accountId,
                direction: {
                    [Op.in]: ['1', '2']
                }
            } as any,
            order: [['createdAt', 'ASC']],
            limit: 500
        });

        return Math.max(0, trades.reduce((netLots, trade) => {
            const data = trade.get({ plain: true }) as Record<string, unknown>;
            if (!sameInstrument(data, figi, instrumentUid)) return netLots;

            const status = data.status ? String(data.status) : undefined;
            if (status && BLOCKED_STATUSES.has(status)) return netLots;

            const lots = lotsFromTrade(data);
            if (String(data.direction) === '1') return netLots + lots;
            if (String(data.direction) === '2') return netLots - lots;
            return netLots;
        }, 0));
    }

    static async evaluateSellPermission(input: {
        accountId: string;
        figi?: string;
        instrumentUid?: string;
        requestedLots?: number;
    }) {
        const requestedLots = Math.max(0, Math.trunc(input.requestedLots ?? 0));
        const robotOwnedLots = await this.getRobotOwnedLots(input.accountId, input.figi, input.instrumentUid);
        const allowedLots = Math.min(requestedLots, Math.trunc(robotOwnedLots));

        if (requestedLots <= 0) {
            return {
                allowed: false,
                allowedLots: 0,
                robotOwnedLots,
                reason: 'sell policy blocked: requested lots is empty'
            };
        }

        if (allowedLots <= 0) {
            return {
                allowed: false,
                allowedLots: 0,
                robotOwnedLots,
                reason: 'sell policy blocked: no robot-owned lots'
            };
        }

        return {
            allowed: true,
            allowedLots,
            robotOwnedLots,
            reason: allowedLots < requestedLots
                ? `sell policy capped: ${allowedLots}/${requestedLots} robot-owned lots`
                : `sell policy passed: ${allowedLots} robot-owned lots`
        };
    }
}
