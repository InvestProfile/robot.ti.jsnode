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

    const status = data.status ? String(data.status) : undefined;
    if (
        status === 'LOCAL_PENDING_SUBMIT'
        || status === 'LOCAL_SUBMIT_UNKNOWN'
        || status === 'EXECUTION_REPORT_STATUS_NEW'
    ) {
        return 0;
    }

    const requested = Number(data.lotsRequested ?? 0);
    if (Number.isFinite(requested) && requested > 0) return requested;

    const lot = Number(data.lot ?? data.quantity ?? 0);
    return Number.isFinite(lot) && lot > 0 ? lot : 0;
};

export default class SellPolicyService {
    private static async getRobotPosition(accountId: string, figi?: string, instrumentUid?: string) {
        if (!accountId || (!figi && !instrumentUid)) {
            return {
                robotOwnedLots: 0,
                latestDirection: undefined as string | undefined,
                latestTradeAt: undefined as unknown
            };
        }

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

        let latestDirection: string | undefined;
        let latestTradeAt: unknown;
        const robotOwnedLots = Math.max(0, trades.reduce((netLots, trade) => {
            const data = trade.get({ plain: true }) as Record<string, unknown>;
            if (!sameInstrument(data, figi, instrumentUid)) return netLots;

            const status = data.status ? String(data.status) : undefined;
            if (status && BLOCKED_STATUSES.has(status)) return netLots;

            const lots = lotsFromTrade(data);
            if (lots > 0) {
                latestDirection = String(data.direction);
                latestTradeAt = data.tradeDateTime || data.createdAt;
            }
            if (String(data.direction) === '1') return netLots + lots;
            if (String(data.direction) === '2') return netLots - lots;
            return netLots;
        }, 0));

        return {
            robotOwnedLots,
            latestDirection,
            latestTradeAt
        };
    }

    static async getRobotOwnedLots(accountId: string, figi?: string, instrumentUid?: string) {
        return (await this.getRobotPosition(accountId, figi, instrumentUid)).robotOwnedLots;
    }

    static async evaluateSellPermission(input: {
        accountId: string;
        figi?: string;
        instrumentUid?: string;
        requestedLots?: number;
        signalSource?: string;
        profitPercent?: number;
        minProfitPercent?: number;
    }) {
        const requestedLots = Math.max(0, Math.trunc(input.requestedLots ?? 0));
        const robotPosition = await this.getRobotPosition(input.accountId, input.figi, input.instrumentUid);
        const robotOwnedLots = robotPosition.robotOwnedLots;
        const allowedLots = Math.min(requestedLots, Math.trunc(robotOwnedLots));
        const minProfitPercent = Number(input.minProfitPercent ?? 0);
        const profitPercent = Number(input.profitPercent);
        const latestWasBuy = robotPosition.latestDirection === '1';
        const emergencySell = input.signalSource === 'stop-loss';

        if (requestedLots <= 0) {
            return {
                allowed: false,
                allowedLots: 0,
                robotOwnedLots,
                latestDirection: robotPosition.latestDirection,
                latestTradeAt: robotPosition.latestTradeAt,
                reason: 'sell policy blocked: requested lots is empty'
            };
        }

        if (allowedLots <= 0) {
            return {
                allowed: false,
                allowedLots: 0,
                robotOwnedLots,
                latestDirection: robotPosition.latestDirection,
                latestTradeAt: robotPosition.latestTradeAt,
                reason: 'sell policy blocked: no robot-owned lots'
            };
        }

        if (
            latestWasBuy
            && !emergencySell
            && minProfitPercent > 0
            && (!Number.isFinite(profitPercent) || profitPercent < minProfitPercent)
        ) {
            return {
                allowed: false,
                allowedLots: 0,
                robotOwnedLots,
                latestDirection: robotPosition.latestDirection,
                latestTradeAt: robotPosition.latestTradeAt,
                reason: `sell policy blocked: latest robot action is buy and ${input.signalSource ?? 'sell'} signal is not strong enough, profit ${Number.isFinite(profitPercent) ? profitPercent.toFixed(2) : '-'}% < min ${minProfitPercent.toFixed(2)}%`
            };
        }

        return {
            allowed: true,
            allowedLots,
            robotOwnedLots,
            latestDirection: robotPosition.latestDirection,
            latestTradeAt: robotPosition.latestTradeAt,
            reason: allowedLots < requestedLots
                ? `sell policy capped: ${allowedLots}/${requestedLots} robot-owned lots`
                : `sell policy passed: ${allowedLots} robot-owned lots`
        };
    }
}
