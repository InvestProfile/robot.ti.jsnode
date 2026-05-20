import { Op } from 'sequelize';
import { RobotConfig } from '../config/robot.config';
import { TradesModel } from '../models/trades.model';
import OperationsService from './operations.service';
import InstrumentsService from './instruments.service';
import { quotationToNumber } from '../utils/money';
import TradesService from './trades.service';
import { isRejectedOrderStatus } from '../utils/order-status';

const BUY_DIRECTION = '1';
const SELL_DIRECTION = '2';

const toNumber = (value: unknown) => {
    const number = Number(value ?? 0);
    return Number.isFinite(number) ? number : 0;
};

const lotsFromTrade = (data: Record<string, unknown>) => {
    const executed = toNumber(data.lotsExecuted);
    if (executed > 0) return executed;

    const status = data.status ? String(data.status) : undefined;
    if (
        status === 'LOCAL_PENDING_SUBMIT'
        || status === 'LOCAL_SUBMIT_UNKNOWN'
        || status === 'EXECUTION_REPORT_STATUS_NEW'
    ) {
        return 0;
    }

    const requested = toNumber(data.lotsRequested);
    if (requested > 0) return requested;

    return Math.max(0, toNumber(data.lot || data.quantity));
};

const priceFromTrade = (data: Record<string, unknown>) => {
    const executedUnits = data.executedPriceUnits;
    const executedNano = data.executedPriceNano;
    const fallbackUnits = data.price_units;
    const fallbackNano = data.price_nano;

    const units = toNumber(executedUnits ?? fallbackUnits);
    const nano = toNumber(executedNano ?? fallbackNano);
    const price = units + nano * 1e-9;

    return price > 0 ? price : undefined;
};

const getInstrumentKey = (data: Record<string, unknown>) =>
    String(data.instrumentUid || data.instrumentId || data.uid || data.figi || data.ticker || '');

const getInstrumentLot = (instrument: { lot?: number } | undefined, data: Record<string, unknown>) => {
    const instrumentLot = toNumber(instrument?.lot);
    if (instrumentLot > 0) return instrumentLot;

    const storedLot = toNumber(data.lot);
    return storedLot > 0 ? storedLot : 1;
};

export default class RobotPositionLedgerService {
    static async getLedger(config: RobotConfig) {
        const accountIds = config.accountIds;
        const trades = await TradesModel.findAll({
            where: {
                accountId: { [Op.in]: accountIds },
                direction: { [Op.in]: [BUY_DIRECTION, SELL_DIRECTION] }
            } as any,
            order: [['createdAt', 'ASC']],
            limit: 1000
        });
        const shares = await InstrumentsService.getShares();
        const instruments = shares?.instruments ?? [];
        const currentByAccountAndInstrument = new Map<string, number>();

        for (const accountId of accountIds) {
            const portfolio = await OperationsService.getPortfolio(accountId);
            for (const position of portfolio?.positions ?? []) {
                const currentPrice = quotationToNumber(position.currentPrice);
                if (!currentPrice) continue;
                currentByAccountAndInstrument.set(`${accountId}:${position.instrumentUid}`, currentPrice);
                currentByAccountAndInstrument.set(`${accountId}:${position.figi}`, currentPrice);
            }
        }

        const positions = new Map<string, any>();
        const events = [];

        for (const trade of trades) {
            const data = trade.get({ plain: true }) as Record<string, unknown>;
            const status = data.status ? String(data.status) : undefined;
            if (isRejectedOrderStatus(status)) continue;

            const accountId = String(data.accountId || '');
            const instrumentKey = getInstrumentKey(data);
            if (!accountId || !instrumentKey) continue;

            const direction = String(data.direction);
            const lots = lotsFromTrade(data);
            const price = priceFromTrade(data);
            if (lots <= 0 || !price) continue;

            const key = `${accountId}:${instrumentKey}`;
            const instrument = instruments.find(item => item.uid === data.instrumentUid || item.uid === data.instrumentId || item.figi === data.figi || item.ticker === data.ticker);
            const lotSize = getInstrumentLot(instrument, data);
            const position = positions.get(key) ?? {
                accountId,
                accountAlias: config.accountAliases[accountId],
                figi: data.figi,
                instrumentUid: data.instrumentUid || data.instrumentId || data.uid,
                ticker: data.ticker || instrument?.ticker,
                name: data.name || instrument?.name,
                lots: 0,
                cost: 0,
                buys: 0,
                sells: 0,
                realizedPnl: 0,
                lotSize,
                lastTradeAt: undefined
            };
            const tradeAmount = TradesService.amountFromTrade(data) ?? price * lots * lotSize;

            if (direction === BUY_DIRECTION) {
                position.lots += lots;
                position.cost += tradeAmount;
                position.buys += 1;
            } else if (direction === SELL_DIRECTION) {
                const sellLots = Math.min(lots, position.lots);
                const averageLotCost = position.lots > 0 ? position.cost / position.lots : 0;
                position.realizedPnl += sellLots * (price * lotSize - averageLotCost);
                position.lots -= sellLots;
                position.cost -= sellLots * averageLotCost;
                position.sells += 1;
            }

            position.lastTradeAt = data.tradeDateTime || data.createdAt;
            positions.set(key, position);
            events.push({
                id: data.id,
                accountId,
                accountAlias: config.accountAliases[accountId],
                ticker: position.ticker,
                name: position.name,
                direction: direction === BUY_DIRECTION ? 'buy' : 'sell',
                lots,
                price,
                amount: tradeAmount,
                status,
                orderId: data.orderId,
                at: data.tradeDateTime || data.createdAt
            });
        }

        const items = [...positions.values()]
            .filter(position => position.lots > 0 || position.buys > 0 || position.sells > 0)
            .map(position => {
                const currentPrice = currentByAccountAndInstrument.get(`${position.accountId}:${position.instrumentUid}`)
                    ?? currentByAccountAndInstrument.get(`${position.accountId}:${position.figi}`);
                const averagePrice = position.lots > 0 ? position.cost / position.lots / position.lotSize : undefined;
                const marketValue = currentPrice ? currentPrice * position.lots * position.lotSize : undefined;
                const unrealizedPnl = position.cost && marketValue ? marketValue - position.cost : undefined;
                const unrealizedPnlPercent = averagePrice && currentPrice ? (currentPrice / averagePrice - 1) * 100 : undefined;

                return {
                    ...position,
                    averagePrice,
                    currentPrice,
                    unrealizedPnl,
                    unrealizedPnlPercent,
                    marketValue
                };
            })
            .sort((a, b) => (b.marketValue ?? 0) - (a.marketValue ?? 0));

        return {
            generatedAt: new Date().toISOString(),
            summary: {
                positions: items.filter(item => item.lots > 0).length,
                lots: items.reduce((sum, item) => sum + item.lots, 0),
                marketValue: items.reduce((sum, item) => sum + (item.marketValue ?? 0), 0),
                unrealizedPnl: items.reduce((sum, item) => sum + (item.unrealizedPnl ?? 0), 0),
                events: events.length
            },
            items,
            events: events.slice(-50).reverse()
        };
    }
}
