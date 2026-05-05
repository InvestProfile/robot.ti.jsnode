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

        if (drawdownPercent >= config.trailingStopPercent) {
            return {
                source: 'trailing-stop',
                reason: `paper trailing-stop: ${drawdownPercent.toFixed(2)}% below high ${highestPrice.toFixed(2)}`
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
        let opened = 0;

        for (const item of scan.items) {
            if (opened >= slots) break;
            if (!item.passed || !item.instrumentUid || !item.lastPrice || item.score === undefined) continue;
            if (openTickers.has(item.ticker)) continue;

            const lot = Math.max(1, Math.trunc((item.estimatedOrderRub ?? item.lastPrice) / item.lastPrice));
            const quantityLots = 1;
            const entryAmountRub = calculateAmount(item.lastPrice, lot, quantityLots);

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
            const profitRub = currentAmountRub - position.entryAmountRub;
            const profitPercent = calculateProfitPercent(position.entryPrice, currentPrice);
            const exit = this.getExitSignal(position, currentPrice, config);

            if (exit) {
                await position.update({
                    status: 'closed',
                    currentPrice,
                    exitPrice: currentPrice,
                    highestPrice,
                    currentAmountRub,
                    exitAmountRub: currentAmountRub,
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

        return {
            summary: {
                open: openPositions.length,
                closed: closedPositions.length,
                openProfitRub,
                closedProfitRub,
                totalProfitRub: openProfitRub + closedProfitRub
            },
            positions: positions.map(position => position.toJSON())
        };
    }
}
