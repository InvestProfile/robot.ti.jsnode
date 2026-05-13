import { Op } from 'sequelize';
import { RobotConfig } from '../config/robot.config';
import PaperPositionModel from '../models/paper-position.model';
import BuyScannerService from './buy-scanner.service';
import MarketDataService from './marketData.service';
import ScanTargetsService from './scan-targets.service';

const calculateProfitPercent = (entryPrice: number, currentPrice: number) =>
    entryPrice > 0 ? (currentPrice / entryPrice - 1) * 100 : 0;

const calculateAmount = (price: number, lot: number, quantityLots: number) =>
    price * Math.max(1, lot) * Math.max(1, quantityLots);

const calculateCommission = (amountRub: number, config: RobotConfig) =>
    amountRub * config.paperCommissionPercent / 100;

const calculateNetProfitRub = (
    entryAmountRub: number,
    currentAmountRub: number,
    entryCommissionRub: number,
    exitCommissionRub: number
) => currentAmountRub - entryAmountRub - entryCommissionRub - exitCommissionRub;

const calculateNetProfitPercent = (entryAmountRub: number, netProfitRub: number) =>
    entryAmountRub > 0 ? netProfitRub / entryAmountRub * 100 : 0;

const average = (values: number[]) => values.length > 0
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : undefined;

const groupByTicker = (positions: PaperPositionModel[]) => {
    const groups = new Map<string, PaperPositionModel[]>();

    for (const position of positions) {
        const ticker = position.ticker;
        groups.set(ticker, [...groups.get(ticker) ?? [], position]);
    }

    return [...groups.entries()]
        .map(([ticker, items]) => {
            const profitRub = items.reduce((sum, position) => sum + (position.profitRub ?? 0), 0);
            const profitPercents = items
                .map(position => position.profitPercent)
                .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));

            return {
                ticker,
                count: items.length,
                open: items.filter(position => position.status === 'open').length,
                closed: items.filter(position => position.status === 'closed').length,
                profitRub,
                averageProfitPercent: average(profitPercents)
            };
        })
        .sort((a, b) => b.profitRub - a.profitRub);
};

const groupClosedByExitSource = (positions: PaperPositionModel[]) => {
    const groups = new Map<string, PaperPositionModel[]>();

    for (const position of positions) {
        const source = position.exitSource ?? 'open';
        groups.set(source, [...groups.get(source) ?? [], position]);
    }

    return [...groups.entries()]
        .map(([source, items]) => {
            const profits = items
                .map(position => position.profitRub)
                .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
            const profitPercents = items
                .map(position => position.profitPercent)
                .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
            const wins = profits.filter(value => value > 0).length;

            return {
                source,
                count: items.length,
                winRatePercent: profits.length > 0 ? wins / profits.length * 100 : undefined,
                profitRub: profits.reduce((sum, value) => sum + value, 0),
                averageProfitPercent: average(profitPercents)
            };
        })
        .sort((a, b) => b.profitRub - a.profitRub);
};

export default class PaperTradingService {
    private static getExitSignal(position: PaperPositionModel, currentPrice: number, config: RobotConfig) {
        const highestPrice = Math.max(position.highestPrice, currentPrice);
        const profitPercent = calculateProfitPercent(position.entryPrice, currentPrice);
        const drawdownPercent = highestPrice > 0 ? (highestPrice - currentPrice) / highestPrice * 100 : 0;

        if (profitPercent <= -config.stopLossPercent) {
            return {
                source: 'stop-loss',
                reason: `paper stop-loss: ${profitPercent.toFixed(2)}%`
            };
        }

        if (drawdownPercent >= config.trailingStopPercent && profitPercent >= config.trailingStopMinProfitPercent) {
            return {
                source: 'trailing-stop',
                reason: `paper trailing-stop: ${drawdownPercent.toFixed(2)}% below high ${highestPrice.toFixed(2)}, profit ${profitPercent.toFixed(2)}% >= trailing min ${config.trailingStopMinProfitPercent.toFixed(2)}%`
            };
        }

        if (profitPercent >= config.minProfitPercent) {
            return {
                source: 'profit-take',
                reason: `paper profit-take: ${profitPercent.toFixed(2)}%`
            };
        }

        return undefined;
    }

    static async tick(config: RobotConfig) {
        if (!config.paperTradingEnabled) return { opened: 0, updated: 0, closed: 0 };

        const closed = await this.updateOpenPositions(config);
        const opened = await this.openNewPositions(config);

        return {
            opened,
            updated: closed.updated,
            closed: closed.closed
        };
    }

    static async openNewPositions(config: RobotConfig) {
        const openCount = await PaperPositionModel.count({ where: { status: 'open' } });
        const slots = config.paperMaxPositions - openCount;
        if (slots <= 0) return 0;

        const targets = await ScanTargetsService.resolve(config);
        if (targets.tickers.length === 0) return 0;

        const scan = await BuyScannerService.scan(config, targets.tickers);
        const openTickers = new Set(
            (await PaperPositionModel.findAll({
                where: { status: 'open' },
                attributes: ['ticker']
            })).map(position => position.ticker)
        );
        const cooldownSince = new Date(Date.now() - config.paperReentryCooldownMs);
        const cooldownTickers = config.paperReentryCooldownMs > 0
            ? new Set((await PaperPositionModel.findAll({
                where: {
                    status: 'closed',
                    closedAt: { [Op.gte]: cooldownSince }
                },
                attributes: ['ticker']
            })).map(position => position.ticker))
            : new Set<string>();
        let opened = 0;

        for (const item of scan.items) {
            if (opened >= slots) break;
            if (!item.passed || !item.instrumentUid || !item.lastPrice || item.score === undefined) continue;
            if (openTickers.has(item.ticker)) continue;
            if (cooldownTickers.has(item.ticker)) continue;

            const lot = Math.max(1, Math.trunc((item.estimatedOrderRub ?? item.lastPrice) / item.lastPrice));
            const quantityLots = 1;
            const entryAmountRub = calculateAmount(item.lastPrice, lot, quantityLots);
            const entryCommissionRub = calculateCommission(entryAmountRub, config);
            const estimatedExitCommissionRub = calculateCommission(entryAmountRub, config);

            if (config.paperMaxPositionRub > 0 && entryAmountRub > config.paperMaxPositionRub) continue;

            await PaperPositionModel.create({
                status: 'open',
                ticker: item.ticker,
                name: item.name,
                figi: item.figi,
                instrumentUid: item.instrumentUid,
                entryPrice: item.lastPrice,
                currentPrice: item.lastPrice,
                highestPrice: item.lastPrice,
                quantityLots,
                lot,
                entryAmountRub,
                currentAmountRub: entryAmountRub,
                entryCommissionRub,
                exitCommissionRub: estimatedExitCommissionRub,
                totalCommissionRub: entryCommissionRub + estimatedExitCommissionRub,
                grossProfitRub: 0,
                profitRub: -entryCommissionRub - estimatedExitCommissionRub,
                profitPercent: calculateNetProfitPercent(entryAmountRub, -entryCommissionRub - estimatedExitCommissionRub),
                entryScore: item.score,
                entryReason: item.reason,
                openedAt: new Date()
            });

            openTickers.add(item.ticker);
            opened += 1;
            console.log(`PAPER_POSITION opened ${item.ticker} score=${item.score} price=${item.lastPrice}`);
        }

        return opened;
    }

    static async updateOpenPositions(config: RobotConfig) {
        const positions = await PaperPositionModel.findAll({
            where: { status: 'open' },
            order: [['openedAt', 'ASC']]
        });
        if (positions.length === 0) return { updated: 0, closed: 0 };

        const prices = await MarketDataService.getLastPrices(positions.map(position => position.instrumentUid));
        let updated = 0;
        let closed = 0;

        for (const position of positions) {
            const currentPrice = prices.get(position.instrumentUid);
            if (!currentPrice) continue;

            const highestPrice = Math.max(position.highestPrice, currentPrice);
            const currentAmountRub = calculateAmount(currentPrice, position.lot, position.quantityLots);
            const grossProfitRub = currentAmountRub - position.entryAmountRub;
            const entryCommissionRub = position.entryCommissionRub ?? calculateCommission(position.entryAmountRub, config);
            const exitCommissionRub = calculateCommission(currentAmountRub, config);
            const totalCommissionRub = entryCommissionRub + exitCommissionRub;
            const profitRub = calculateNetProfitRub(position.entryAmountRub, currentAmountRub, entryCommissionRub, exitCommissionRub);
            const profitPercent = calculateNetProfitPercent(position.entryAmountRub, profitRub);
            const exit = this.getExitSignal(position, currentPrice, config);

            if (exit) {
                await position.update({
                    status: 'closed',
                    currentPrice,
                    exitPrice: currentPrice,
                    highestPrice,
                    currentAmountRub,
                    exitAmountRub: currentAmountRub,
                    entryCommissionRub,
                    exitCommissionRub,
                    totalCommissionRub,
                    grossProfitRub,
                    profitRub,
                    profitPercent,
                    exitSource: exit.source,
                    exitReason: exit.reason,
                    closedAt: new Date()
                });
                closed += 1;
                console.log(`PAPER_POSITION closed ${position.ticker} ${profitPercent.toFixed(2)}% ${exit.source}`);
                continue;
            }

            await position.update({
                currentPrice,
                highestPrice,
                currentAmountRub,
                entryCommissionRub,
                exitCommissionRub,
                totalCommissionRub,
                grossProfitRub,
                profitRub,
                profitPercent
            });
            updated += 1;
        }

        return { updated, closed };
    }

    static async list(limit = 100) {
        const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), 500);
        const positions = await PaperPositionModel.findAll({
            where: {
                status: {
                    [Op.in]: ['open', 'closed']
                }
            },
            order: [['openedAt', 'DESC']],
            limit: safeLimit
        });
        const openPositions = positions.filter(position => position.status === 'open');
        const closedPositions = positions.filter(position => position.status === 'closed');
        const openProfitRub = openPositions.reduce((sum, position) => sum + (position.profitRub ?? 0), 0);
        const closedProfitRub = closedPositions.reduce((sum, position) => sum + (position.profitRub ?? 0), 0);
        const totalCommissionRub = positions.reduce((sum, position) => sum + (position.totalCommissionRub ?? 0), 0);
        const grossProfitRub = positions.reduce((sum, position) => sum + (position.grossProfitRub ?? 0), 0);
        const closedProfits = closedPositions
            .map(position => position.profitRub)
            .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
        const closedProfitPercents = closedPositions
            .map(position => position.profitPercent)
            .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
        const openProfitPercents = openPositions
            .map(position => position.profitPercent)
            .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
        const wins = closedProfits.filter(value => value > 0).length;

        return {
            summary: {
                open: openPositions.length,
                closed: closedPositions.length,
                openProfitRub,
                closedProfitRub,
                totalProfitRub: openProfitRub + closedProfitRub,
                grossProfitRub,
                totalCommissionRub,
                closedWinRatePercent: closedProfits.length > 0 ? wins / closedProfits.length * 100 : undefined,
                averageClosedProfitPercent: average(closedProfitPercents),
                averageOpenProfitPercent: average(openProfitPercents),
                bestClosedProfitRub: closedProfits.length > 0 ? Math.max(...closedProfits) : undefined,
                worstClosedProfitRub: closedProfits.length > 0 ? Math.min(...closedProfits) : undefined
            },
            byTicker: groupByTicker(positions),
            byExitSource: groupClosedByExitSource(closedPositions),
            positions: positions.map(position => position.toJSON())
        };
    }
}
