import sequelize from '../config/database';
import { getRobotConfig } from '../config/robot.config';
import { TradeDecisionModel } from '../models/trade-decision.model';
import { TradesModel } from '../models/trades.model';
import { Op } from 'sequelize';
import { PortfolioSnapshotModel } from '../models/portfolio-snapshot.model';
import InstrumentsService from '../services/instruments.service';
import marketData from '../services/marketData.service';
import operationService from '../services/operations.service';
import { quotationToNumber } from '../utils/money';
import { isFinalOrderStatus } from '../utils/order-status';
import MarketRegimeService from '../services/market-regime.service';
import PaperTradingService from '../services/paper-trading.service';
import BuySignalEvaluatorService from '../services/buy-signal-evaluator.service';
import TradesService from '../services/trades.service';

const ok = (label: string, details = '') => console.log(`OK    ${label}${details ? ': ' + details : ''}`);
const warn = (label: string, details = '') => console.log(`WARN  ${label}${details ? ': ' + details : ''}`);
const fail = (label: string, details = '') => console.log(`FAIL  ${label}${details ? ': ' + details : ''}`);
const strictLive = process.argv.includes('--live');

const money = (value: number | undefined) => {
    if (value === undefined || !Number.isFinite(value)) return '-';
    return `${value.toFixed(2)} RUB`;
};

const main = async () => {
    const config = getRobotConfig();
    const failures: string[] = [];
    const warnings: string[] = [];

    console.log(strictLive ? 'Live Readiness' : 'Preflight');
    console.log(strictLive ? '==============' : '=========');

    try {
        await sequelize.authenticate();
        ok('DB connection');
    } catch (error) {
        failures.push('DB connection failed');
        fail('DB connection', error instanceof Error ? error.message : String(error));
    }

    const protectedAccountIds = new Set(config.protectedAccountIds);
    const protectedTradeAccounts = config.accountIds.filter(accountId => protectedAccountIds.has(accountId));
    if (protectedTradeAccounts.length > 0) {
        failures.push('Protected accounts are configured for trading');
        fail('Protected account overlap', protectedTradeAccounts.join(', '));
    } else {
        ok('Protected account overlap');
    }

    console.log('');
    console.log('Runtime');
    console.log('-------');
    console.log(`Dry run: ${config.dryRun}`);
    console.log(`Live enabled: ${!config.dryRun}`);
    console.log(`Live allowed actions: ${config.liveAllowedActions.join(', ')}`);
    console.log(`Trading paused: ${config.tradingPaused}`);
    console.log(`Max tick errors: ${config.maxConsecutiveTickErrors}`);
    console.log(`Strategies: ${config.enabledStrategies.join(', ')}`);
    console.log(`Trading accounts: ${config.accountIds.join(', ')}`);
    console.log(`Observe accounts: ${config.observeAccountIds.join(', ') || '<none>'}`);
    console.log(`Max order: ${money(config.maxOrderRub)}`);
    console.log(`Max daily orders: ${config.maxDailyOrders}`);
    console.log(`Buy score: min ${config.buyMinScore}, trend ${config.buyTrendDays}d, min trend ${config.buyMinTrendPercent}%, min momentum ${config.buyMinMomentumPercent}%`);
    console.log(`Market regime: ${config.marketRegimeEnabled ? 'enabled' : 'disabled'}`);
    console.log(`Paper trading: ${config.paperTradingEnabled ? 'enabled' : 'disabled'}`);

    if (config.dryRun) {
        const message = 'ROBOT_DRY_RUN=true';
        if (strictLive) {
            failures.push('Dry-run is enabled');
            fail('Live trading disabled', message);
        } else {
            warnings.push('Dry-run is enabled');
            warn('Live trading disabled', message);
        }
    } else {
        ok('Live trading enabled');
    }

    if (config.tradingPaused) {
        const message = 'ROBOT_TRADING_PAUSED=true';
        if (strictLive) {
            failures.push('Trading is paused');
            fail('Trading pause', message);
        } else {
            warnings.push('Trading is paused');
            warn('Trading pause', message);
        }
    } else {
        ok('Trading pause', 'not paused');
    }

    if (config.liveAllowedActions.length === 0) {
        failures.push('No live actions are enabled');
        fail('Live allowed actions', 'empty');
    }

    if (config.maxDailyOrders <= 0) {
        warnings.push('Daily order limit is zero');
        warn('Daily order limit', 'ROBOT_MAX_DAILY_ORDERS=0');
    }

    if (config.maxDailyRub <= 0) {
        warnings.push('Daily RUB limit is zero');
        warn('Daily RUB limit', 'ROBOT_MAX_DAILY_RUB=0');
    }

    console.log('');
    console.log('Database State');
    console.log('--------------');

    const decisionCount = await TradeDecisionModel.count();
    const tradeCount = await TradesModel.count();
    const snapshotCount = await PortfolioSnapshotModel.count();
    const latestDecision = await TradeDecisionModel.findOne({ order: [['createdAt', 'DESC']] });
    const latestSnapshot = await PortfolioSnapshotModel.findOne({ order: [['createdAt', 'DESC']] });
    const openTrades = await TradesModel.findAll({
        where: {
            orderId: {
                [Op.ne]: null
            }
        } as any,
        order: [['createdAt', 'DESC']],
        limit: 100
    });
    const openOrderCount = openTrades.filter(trade => {
        const data = trade.get({ plain: true }) as Record<string, unknown>;
        const status = data.status ? String(data.status) : undefined;
        return !isFinalOrderStatus(status);
    }).length;

    console.log(`Decisions: ${decisionCount}`);
    console.log(`Trades: ${tradeCount}`);
    console.log(`Portfolio snapshots: ${snapshotCount}`);
    console.log(`Open broker orders tracked: ${openOrderCount}`);
    console.log(`Latest decision: ${latestDecision?.getDataValue('createdAt')?.toISOString?.() ?? '-'}`);
    console.log(`Latest snapshot: ${latestSnapshot?.getDataValue('createdAt')?.toISOString?.() ?? '-'}`);

    if (decisionCount === 0) {
        warnings.push('No decisions have been recorded yet');
        warn('Decision history', 'empty');
    }

    if (snapshotCount === 0) {
        warnings.push('No portfolio snapshots have been recorded yet');
        warn('Portfolio history', 'empty');
    }

    if (openOrderCount > 0) {
        warnings.push(`${openOrderCount} open broker orders are tracked`);
        warn('Open broker orders', String(openOrderCount));
    }

    console.log('');
    console.log('Market Regime');
    console.log('-------------');

    const marketRegime = await MarketRegimeService.evaluate(config);
    console.log(`Enabled: ${marketRegime.enabled}`);
    console.log(`Passed: ${marketRegime.passed}`);
    console.log(`Reason: ${marketRegime.reason}`);

    for (const item of marketRegime.items) {
        const trend = item.trendPercent !== undefined ? `${item.trendPercent.toFixed(2)}%` : '-';
        console.log(`  ${item.ticker}: ${trend} ${item.passed ? 'OK' : 'BLOCKED'}`);
    }

    if (!marketRegime.passed) {
        const message = marketRegime.reason;
        if (strictLive && config.liveAllowedActions.includes('buy')) {
            failures.push(message);
            fail('Market regime', message);
        } else {
            warnings.push(message);
            warn('Market regime', message);
        }
    } else {
        ok('Market regime', marketRegime.reason);
    }

    console.log('');
    console.log('Paper Portfolio');
    console.log('---------------');

    const paper = await PaperTradingService.list(100);
    console.log(`Open: ${paper.summary.open}`);
    console.log(`Closed: ${paper.summary.closed}`);
    console.log(`Open P/L: ${money(paper.summary.openProfitRub)}`);
    console.log(`Closed P/L: ${money(paper.summary.closedProfitRub)}`);
    console.log(`Total P/L: ${money(paper.summary.totalProfitRub)}`);
    console.log(`Avg open P/L: ${paper.summary.averageOpenProfitPercent !== undefined ? paper.summary.averageOpenProfitPercent.toFixed(2) + '%' : '-'}`);
    console.log(`Closed win-rate: ${paper.summary.closedWinRatePercent !== undefined ? paper.summary.closedWinRatePercent.toFixed(0) + '%' : '-'}`);

    if (paper.summary.open === 0 && paper.summary.closed === 0) {
        warnings.push('Paper portfolio has no positions yet');
        warn('Paper portfolio', 'empty');
    }

    if (paper.summary.closed === 0) {
        warnings.push('Paper portfolio has no closed trades yet');
        warn('Paper closed trades', 'empty');
    }

    if (strictLive && paper.summary.closed < 3) {
        failures.push('Need at least 3 closed paper trades before live expansion');
        fail('Paper evidence', 'less than 3 closed trades');
    }

    const shares = await InstrumentsService.getShares();
    const instruments = shares?.instruments ?? [];
    const tradingAccountCash = new Map<string, number>();

    console.log('');
    console.log('Trading Accounts');
    console.log('----------------');

    for (const accountId of config.accountIds) {
        const alias = config.accountAliases[accountId] ?? accountId;
        const portfolio = await operationService.getPortfolio(accountId);
        const cashRub = quotationToNumber(portfolio?.totalAmountCurrencies) ?? 0;
        const totalRub = quotationToNumber(portfolio?.totalAmountPortfolio) ?? 0;
        const positionsCount = portfolio?.positions?.length ?? 0;
        tradingAccountCash.set(accountId, cashRub);

        console.log(`${alias} (${accountId})`);
        console.log(`  Cash: ${money(cashRub)}`);
        console.log(`  Total: ${money(totalRub)}`);
        console.log(`  Positions: ${positionsCount}`);

        if (cashRub <= 0) {
            const message = `${alias} has no RUB cash`;
            if (strictLive && config.liveAllowedActions.includes('buy')) {
                failures.push(message);
                fail('Cash', message);
            } else {
                warnings.push(message);
                warn('Cash', message);
            }
        }
    }

    console.log('');
    console.log('Buy Watchlist');
    console.log('-------------');

    const buyInstruments = config.buyTickers
        .map(ticker => instruments.find(instrument => instrument.ticker?.toUpperCase() === ticker))
        .filter(Boolean);
    const missingTickers = config.buyTickers.filter(ticker =>
        !buyInstruments.some(instrument => instrument?.ticker?.toUpperCase() === ticker)
    );

    if (config.liveAllowedActions.includes('buy') && config.buyTickers.length === 0) {
        const message = 'ROBOT_BUY_TICKERS is empty';
        if (strictLive) {
            failures.push(message);
            fail('Buy watchlist', message);
        } else {
            warnings.push(message);
            warn('Buy watchlist', message);
        }
    }

    for (const ticker of missingTickers) {
        const message = `Ticker not found: ${ticker}`;
        if (strictLive && config.liveAllowedActions.includes('buy')) {
            failures.push(message);
            fail('Ticker not found', ticker);
        } else {
            warnings.push(message);
            warn('Ticker not found', ticker);
        }
    }

    const lastPrices = await marketData.getLastPrices(
        buyInstruments
            .map(instrument => instrument?.uid)
            .filter((uid): uid is string => Boolean(uid))
    );

    for (const instrument of buyInstruments) {
        if (!instrument) continue;

        const lastPrice = lastPrices.get(instrument.uid);
        const estimatedOrderRub = lastPrice !== undefined
            ? lastPrice * Math.max(1, instrument.lot ?? 1)
            : undefined;
        const maxTradingCash = Math.max(...Array.from(tradingAccountCash.values()), 0);
        const blockedReason = lastPrice === undefined
            ? 'last price is empty'
            : estimatedOrderRub !== undefined && estimatedOrderRub > config.maxOrderRub
                ? 'above max order RUB'
                : estimatedOrderRub !== undefined && estimatedOrderRub > maxTradingCash
                    ? 'not enough trading account cash'
                : undefined;

        console.log(
            `${instrument.ticker}: price=${money(lastPrice)} lot=${instrument.lot ?? 1} estimated=${money(estimatedOrderRub)}${blockedReason ? ' blocked=' + blockedReason : ''}`
        );

        if (strictLive && blockedReason) {
            failures.push(`${instrument.ticker} is blocked: ${blockedReason}`);
            fail('Buy readiness', `${instrument.ticker}: ${blockedReason}`);
        }
    }

    console.log('');
    console.log('Buy Preview');
    console.log('-----------');

    for (const accountId of config.accountIds) {
        const alias = config.accountAliases[accountId] ?? accountId;
        const ordersUsed = await TradesService.countTodayTrades(accountId);
        const rubUsed = await TradesService.sumTodayBuyTradesRub(accountId);
        const previews = await BuySignalEvaluatorService.evaluateAccount(accountId, config, instruments as any);

        console.log(`${alias} (${accountId})`);
        console.log(`  Daily orders: ${ordersUsed}/${config.maxDailyOrders}`);
        console.log(`  Daily RUB: ${money(rubUsed)}/${money(config.maxDailyRub)}`);

        for (const preview of previews) {
            console.log(`  ${preview.ticker ?? preview.figi}: ${preview.status} ${preview.currentPrice ? money(preview.currentPrice) : '-'} ${preview.reason}`);
        }

        const allowed = previews.filter(preview => preview.status === 'allowed');
        if (allowed.length === 0 && config.liveAllowedActions.includes('buy')) {
            const message = `${alias}: no allowed buy previews`;
            if (strictLive) {
                failures.push(message);
                fail('Buy preview', message);
            } else {
                warnings.push(message);
                warn('Buy preview', message);
            }
        }
    }

    console.log('');
    console.log('Result');
    console.log('------');

    if (failures.length > 0) {
        fail('Preflight failed', failures.join('; '));
        process.exitCode = 1;
        return;
    }

    if (warnings.length > 0) {
        warn('Preflight passed with warnings', warnings.join('; '));
        return;
    }

    ok('Preflight passed');
};

void main()
    .catch(error => {
        console.error('Preflight failed:', error);
        process.exitCode = 1;
    })
    .finally(async () => {
        await sequelize.close().catch(() => undefined);
    });
