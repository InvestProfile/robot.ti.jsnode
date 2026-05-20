import { Op } from 'sequelize';
import { TradesModel } from '../models/trades.model';
import TradesService from './trades.service';
import { isRejectedOrderStatus } from '../utils/order-status';

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
        let robotOwnedLots = 0;
        let robotCostRub = 0;

        for (const trade of trades) {
            const data = trade.get({ plain: true }) as Record<string, unknown>;
            if (!sameInstrument(data, figi, instrumentUid)) continue;

            const status = data.status ? String(data.status) : undefined;
            if (isRejectedOrderStatus(status)) continue;

            const lots = lotsFromTrade(data);
            if (lots > 0) {
                latestDirection = String(data.direction);
                latestTradeAt = data.tradeDateTime || data.createdAt;
            }
            if (String(data.direction) === '1') {
                const amount = TradesService.amountFromTrade(data);
                robotOwnedLots += lots;
                if (amount !== undefined) robotCostRub += amount;
            } else if (String(data.direction) === '2') {
                const sellLots = Math.min(lots, robotOwnedLots);
                const averageLotCostRub = robotOwnedLots > 0 ? robotCostRub / robotOwnedLots : 0;
                robotOwnedLots -= sellLots;
                robotCostRub -= sellLots * averageLotCostRub;
            }
        }

        return {
            robotOwnedLots: Math.max(0, robotOwnedLots),
            robotAverageLotCostRub: robotOwnedLots > 0 ? robotCostRub / robotOwnedLots : undefined,
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
        currentPrice?: number;
        lotSize?: number;
    }) {
        const requestedLots = Math.max(0, Math.trunc(input.requestedLots ?? 0));
        const robotPosition = await this.getRobotPosition(input.accountId, input.figi, input.instrumentUid);
        const robotOwnedLots = robotPosition.robotOwnedLots;
        const allowedLots = Math.min(requestedLots, Math.trunc(robotOwnedLots));
        const minProfitPercent = Number(input.minProfitPercent ?? 0);
        const profitPercent = Number(input.profitPercent);
        const latestWasBuy = robotPosition.latestDirection === '1';
        const emergencySell = input.signalSource === 'stop-loss';
        const currentLotValueRub = Number(input.currentPrice) * Math.max(1, Number(input.lotSize || 1));
        const robotProfitPercent = robotPosition.robotAverageLotCostRub && Number.isFinite(currentLotValueRub) && currentLotValueRub > 0
            ? (currentLotValueRub / robotPosition.robotAverageLotCostRub - 1) * 100
            : undefined;

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

        if (
            latestWasBuy
            && !emergencySell
            && minProfitPercent > 0
            && (robotProfitPercent === undefined || robotProfitPercent < minProfitPercent)
        ) {
            return {
                allowed: false,
                allowedLots: 0,
                robotOwnedLots,
                latestDirection: robotPosition.latestDirection,
                latestTradeAt: robotPosition.latestTradeAt,
                robotAverageLotCostRub: robotPosition.robotAverageLotCostRub,
                robotProfitPercent,
                reason: `sell policy blocked: robot-owned entry is not profitable enough for ${input.signalSource ?? 'sell'}, robot P/L ${robotProfitPercent !== undefined ? robotProfitPercent.toFixed(2) : '-'}% < min ${minProfitPercent.toFixed(2)}%`
            };
        }

        return {
            allowed: true,
            allowedLots,
            robotOwnedLots,
            latestDirection: robotPosition.latestDirection,
            latestTradeAt: robotPosition.latestTradeAt,
            robotAverageLotCostRub: robotPosition.robotAverageLotCostRub,
            robotProfitPercent,
            reason: allowedLots < requestedLots
                ? `sell policy capped: ${allowedLots}/${requestedLots} robot-owned lots`
                : `sell policy passed: ${allowedLots} robot-owned lots${robotProfitPercent !== undefined ? `, robot P/L ${robotProfitPercent.toFixed(2)}%` : ''}`
        };
    }
}
