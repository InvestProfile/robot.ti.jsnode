import { Op } from 'sequelize';
import { TradesModel } from '../models/trades.model';
import OrdersService from './orders.service';
import { isFinalOrderStatus, normalizeOrderStatus, normalizeOrderType } from '../utils/order-status';
import { OrderIdType } from 'tinkoff-sdk-grpc-js/dist/generated/orders';

const moneyParts = (value: unknown) => {
    const money = value as Record<string, unknown> | undefined;
    return {
        units: money?.units,
        nano: money?.nano
    };
};

const moneyValue = (units: unknown, nano: unknown) => {
    const value = Number(units ?? 0) + Number(nano ?? 0) * 1e-9;
    return Number.isFinite(value) ? value : 0;
};

const hasExecutionDetails = (data: Record<string, unknown>) => {
    const lotsExecuted = Number(data.lotsExecuted ?? 0);
    const executedPrice = moneyValue(data.executedPriceUnits, data.executedPriceNano);
    const totalAmount = moneyValue(data.totalAmountUnits, data.totalAmountNano);

    return lotsExecuted > 0 && (executedPrice > 0 || totalAmount > 0);
};

export default class OrderReconciliationService {
    private static async getOrderState(accountId: string, orderId: string, clientOrderId?: string) {
        if (clientOrderId) {
            try {
                return await OrdersService.getOrderState(accountId, clientOrderId, OrderIdType.ORDER_ID_TYPE_REQUEST);
            } catch (error) {
                console.warn('Order reconciliation by request id failed, will try stored order id:', {
                    accountId,
                    requestId: clientOrderId,
                    error: error instanceof Error ? error.message : String(error)
                });
            }
        }

        try {
            return await OrdersService.getOrderState(accountId, orderId);
        } catch (error) {
            if (!clientOrderId) throw error;
        }

        return await OrdersService.getOrderState(accountId, clientOrderId, OrderIdType.ORDER_ID_TYPE_REQUEST);
    }

    static async reconcileTrade(trade: TradesModel) {
        const data = trade.get({ plain: true }) as Record<string, unknown>;
        const accountId = data.accountId ? String(data.accountId) : undefined;
        const orderId = data.orderId ? String(data.orderId) : undefined;
        const clientOrderId = data.clientOrderId ? String(data.clientOrderId) : undefined;

        if (!accountId || (!orderId && !clientOrderId)) return false;

        const orderState = await this.getOrderState(accountId, orderId ?? clientOrderId as string, clientOrderId);
        if (!orderState) return false;

        const state = orderState as unknown as Record<string, unknown>;
        const status = normalizeOrderStatus(state.executionReportStatus);
        const orderType = normalizeOrderType(state.orderType);
        const executedPrice = moneyParts(state.executedOrderPrice);
        const totalAmount = moneyParts(state.totalOrderAmount);

        await trade.update({
            orderId: state.orderId ? String(state.orderId) : orderId,
            clientOrderId,
            status,
            orderType,
            lotsRequested: typeof state.lotsRequested === 'number' ? state.lotsRequested : data.lotsRequested,
            lotsExecuted: typeof state.lotsExecuted === 'number' ? state.lotsExecuted : data.lotsExecuted,
            executedPriceUnits: executedPrice.units ?? data.executedPriceUnits,
            executedPriceNano: executedPrice.nano ?? data.executedPriceNano,
            totalAmountUnits: totalAmount.units ?? data.totalAmountUnits,
            totalAmountNano: totalAmount.nano ?? data.totalAmountNano,
            tradeDateTime: state.orderDate instanceof Date ? state.orderDate.toISOString() : data.tradeDateTime,
            orderError: null
        });

        return true;
    }

    static async reconcileOpenOrders() {
        const trades = await TradesModel.findAll({
            where: {
                [Op.or]: [
                    { orderId: { [Op.ne]: null } },
                    { clientOrderId: { [Op.ne]: null } }
                ]
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
            const clientOrderId = data.clientOrderId ? String(data.clientOrderId) : undefined;
            const currentStatus = data.status ? String(data.status) : undefined;

            if (!accountId || (!orderId && !clientOrderId)) continue;
            if (isFinalOrderStatus(currentStatus) && hasExecutionDetails(data)) {
                skippedFinal += 1;
                continue;
            }

            checked += 1;

            try {
                if (await this.reconcileTrade(trade)) updated += 1;
            } catch (error) {
                failed += 1;
                console.error('Order reconciliation failed:', {
                    accountId,
                    orderId: orderId ?? clientOrderId,
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
