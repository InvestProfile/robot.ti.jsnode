import { Op } from 'sequelize';
import { TradesModel } from '../models/trades.model';
import OrdersService from './orders.service';
import { isFinalOrderStatus, normalizeOrderStatus, normalizeOrderType } from '../utils/order-status';

const moneyParts = (value: unknown) => {
    const money = value as Record<string, unknown> | undefined;
    return {
        units: money?.units,
        nano: money?.nano
    };
};

export default class OrderReconciliationService {
    static async reconcileOpenOrders() {
        const trades = await TradesModel.findAll({
            where: {
                orderId: {
                    [Op.ne]: null
                }
            } as any,
            order: [['createdAt', 'DESC']],
            limit: 100
        });

        let checked = 0;
        let updated = 0;
        let skippedFinal = 0;
        let failed = 0;

        for (const trade of trades) {
            const data = trade.get({ plain: true }) as Record<string, unknown>;
            const accountId = data.accountId ? String(data.accountId) : undefined;
            const orderId = data.orderId ? String(data.orderId) : undefined;
            const currentStatus = data.status ? String(data.status) : undefined;

            if (!accountId || !orderId) continue;
            if (isFinalOrderStatus(currentStatus)) {
                skippedFinal += 1;
                continue;
            }

            checked += 1;

            try {
                const orderState = await OrdersService.getOrderState(accountId, orderId);
                if (!orderState) continue;

                const state = orderState as unknown as Record<string, unknown>;
                const status = normalizeOrderStatus(state.executionReportStatus);
                const orderType = normalizeOrderType(state.orderType);
                const executedPrice = moneyParts(state.executedOrderPrice);
                const totalAmount = moneyParts(state.totalOrderAmount);

                await trade.update({
                    status,
                    orderType,
                    lotsRequested: typeof state.lotsRequested === 'number' ? state.lotsRequested : data.lotsRequested,
                    lotsExecuted: typeof state.lotsExecuted === 'number' ? state.lotsExecuted : data.lotsExecuted,
                    executedPriceUnits: executedPrice.units ?? data.executedPriceUnits,
                    executedPriceNano: executedPrice.nano ?? data.executedPriceNano,
                    totalAmountUnits: totalAmount.units ?? data.totalAmountUnits,
                    totalAmountNano: totalAmount.nano ?? data.totalAmountNano,
                    tradeDateTime: state.orderDate instanceof Date ? state.orderDate.toISOString() : data.tradeDateTime
                });

                updated += 1;
            } catch (error) {
                failed += 1;
                console.error('Order reconciliation failed:', {
                    accountId,
                    orderId,
                    error: error instanceof Error ? error.message : String(error)
                });
            }
        }

        if (checked > 0 || failed > 0) {
            console.log(`Order reconciliation: checked=${checked}, updated=${updated}, skippedFinal=${skippedFinal}, failed=${failed}`);
        }

        return { checked, updated, skippedFinal, failed };
    }
}
