import http, { IncomingMessage, ServerResponse } from 'http';
import { URL } from 'url';
import { getEnv } from '../config/env.config';
import { getRobotConfig, RobotConfig } from '../config/robot.config';
import { getTradingRuntimeState } from '../modules/common.module';
import { TradeDecisionModel } from '../models/trade-decision.model';
import BuySignalEvaluatorService from '../services/buy-signal-evaluator.service';
import OperationsService from '../services/operations.service';
import InstrumentsService from '../services/instruments.service';
import { quotationToNumber } from '../utils/money';
import { dashboardPage } from './dashboard-page';
import { TradesModel } from '../models/trades.model';
import TradesService from '../services/trades.service';
import { PortfolioSnapshotModel } from '../models/portfolio-snapshot.model';
import PerformanceService from '../services/performance.service';
import BuyScannerService from '../services/buy-scanner.service';
import BuyBacktestService from '../services/buy-backtest.service';
import BuyOptimizerService from '../services/buy-optimizer.service';

type AccountMode = 'trade' | 'observe';

const parseBoolean = (value: string | undefined, defaultValue: boolean) => {
    if (value === undefined) return defaultValue;
    return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
};

const parsePort = (value: string | undefined) => {
    const port = Number(value ?? 3000);
    return Number.isFinite(port) ? port : 3000;
};

const json = (res: ServerResponse, statusCode: number, payload: unknown) => {
    const body = JSON.stringify(payload, null, 2);
    res.writeHead(statusCode, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store'
    });
    res.end(body);
};

const text = (res: ServerResponse, statusCode: number, body: string, contentType = 'text/plain; charset=utf-8') => {
    res.writeHead(statusCode, {
        'content-type': contentType,
        'cache-control': 'no-store'
    });
    res.end(body);
};

const getAuthCredentials = () => {
    const env = getEnv();
    return {
        username: env.ROBOT_WEB_USERNAME || 'robot',
        password: env.ROBOT_WEB_PASSWORD
    };
};

const isAuthorized = (req: IncomingMessage) => {
    const { username, password } = getAuthCredentials();
    if (!password) return true;

    const header = req.headers.authorization;
    if (!header?.startsWith('Basic ')) return false;

    const decoded = Buffer.from(header.slice('Basic '.length), 'base64').toString('utf8');
    const separatorIndex = decoded.indexOf(':');
    if (separatorIndex === -1) return false;

    const requestUsername = decoded.slice(0, separatorIndex);
    const requestPassword = decoded.slice(separatorIndex + 1);

    return requestUsername === username && requestPassword === password;
};

const requireAuth = (req: IncomingMessage, res: ServerResponse) => {
    if (isAuthorized(req)) return true;

    res.writeHead(401, {
        'www-authenticate': 'Basic realm="T-Invest Robot"',
        'content-type': 'text/plain; charset=utf-8'
    });
    res.end('Authentication required');
    return false;
};

const safeConfig = (config: RobotConfig) => ({
    accountIds: config.accountIds,
    observeAccountIds: config.observeAccountIds,
    accountAliases: config.accountAliases,
    protectedAccountIds: config.protectedAccountIds,
    dryRun: config.dryRun,
    liveConfirmationRequired: config.liveConfirmationRequired,
    liveAllowedActions: config.liveAllowedActions,
    tradingPaused: config.tradingPaused,
    maxConsecutiveTickErrors: config.maxConsecutiveTickErrors,
    intervalMs: config.intervalMs,
    positionDelayMs: config.positionDelayMs,
    enabledStrategies: config.enabledStrategies,
    minProfitPercent: config.minProfitPercent,
    stopLossPercent: config.stopLossPercent,
    trailingStopPercent: config.trailingStopPercent,
    trailingBaseline: config.trailingBaseline,
    maxLotsPerOrder: config.maxLotsPerOrder,
    buyTickers: config.buyTickers,
    scanTickers: config.scanTickers,
    buyTrendDays: config.buyTrendDays,
    buyMinTrendPercent: config.buyMinTrendPercent,
    buyMinMomentumPercent: config.buyMinMomentumPercent,
    buyMinScore: config.buyMinScore,
    maxOrderRub: config.maxOrderRub,
    maxDailyOrders: config.maxDailyOrders,
    maxDailyRub: config.maxDailyRub,
    signalCooldownMs: config.signalCooldownMs,
    signalPriceChangePercent: config.signalPriceChangePercent,
    snapshotIntervalMs: config.snapshotIntervalMs
});

const getAllAccounts = (config: RobotConfig) => [
    ...config.accountIds.map(accountId => ({ accountId, mode: 'trade' as AccountMode })),
    ...config.observeAccountIds.map(accountId => ({ accountId, mode: 'observe' as AccountMode }))
];

const getAccountsPayload = async (config: RobotConfig) => {
    const accounts = [];

    for (const account of getAllAccounts(config)) {
        const portfolio = await OperationsService.getPortfolio(account.accountId);

        accounts.push({
            ...account,
            alias: config.accountAliases[account.accountId],
            cashRub: quotationToNumber(portfolio?.totalAmountCurrencies),
            totalRub: quotationToNumber(portfolio?.totalAmountPortfolio),
            positionsCount: portfolio?.positions?.length ?? 0
        });
    }

    return { accounts };
};

const getPositionsPayload = async (config: RobotConfig, accountIdFilter: string | null) => {
    const shares = await InstrumentsService.getShares();
    const instruments = shares?.instruments ?? [];
    const positions = [];

    for (const account of getAllAccounts(config)) {
        if (accountIdFilter && account.accountId !== accountIdFilter) continue;

        const portfolio = await OperationsService.getPortfolio(account.accountId);

        for (const position of portfolio?.positions ?? []) {
            const averagePrice = quotationToNumber(position.averagePositionPrice);
            const currentPrice = quotationToNumber(position.currentPrice);
            const instrument = instruments.find(item => item.figi === position.figi && item.uid === position.instrumentUid)
                ?? instruments.find(item => item.figi === position.figi);

            positions.push({
                accountId: account.accountId,
                accountAlias: config.accountAliases[account.accountId],
                accountMode: account.mode,
                figi: position.figi,
                instrumentUid: position.instrumentUid,
                ticker: instrument?.ticker,
                name: instrument?.name,
                quantityLots: position.quantityLots?.units,
                averagePrice,
                currentPrice,
                profitPercent: averagePrice && currentPrice ? (currentPrice / averagePrice - 1) * 100 : undefined
            });
        }
    }

    return { positions };
};

const getDecisionsPayload = async (url: URL) => {
    const requestedLimit = Number(url.searchParams.get('limit') ?? 50);
    const limit = Math.min(Math.max(Number.isFinite(requestedLimit) ? requestedLimit : 50, 1), 500);
    const decisions = await TradeDecisionModel.findAll({
        order: [['createdAt', 'DESC']],
        limit
    });

    return {
        decisions: decisions.map(decision => decision.toJSON())
    };
};

const getTradesPayload = async (url: URL) => {
    const requestedLimit = Number(url.searchParams.get('limit') ?? 50);
    const limit = Math.min(Math.max(Number.isFinite(requestedLimit) ? requestedLimit : 50, 1), 500);
    const trades = await TradesModel.findAll({
        order: [['createdAt', 'DESC']],
        limit
    });

    return {
        trades: trades.map(trade => trade.toJSON())
    };
};

const getSnapshotsPayload = async (url: URL) => {
    const requestedLimit = Number(url.searchParams.get('limit') ?? 50);
    const limit = Math.min(Math.max(Number.isFinite(requestedLimit) ? requestedLimit : 50, 1), 500);
    const accountId = url.searchParams.get('accountId');
    const snapshots = await PortfolioSnapshotModel.findAll({
        where: accountId ? { accountId } : undefined,
        order: [['createdAt', 'DESC']],
        limit
    });

    return {
        snapshots: snapshots.map(snapshot => snapshot.toJSON())
    };
};

const getLimitsPayload = async (config: RobotConfig) => {
    const limits = [];

    for (const accountId of config.accountIds) {
        const ordersUsed = await TradesService.countTodayTrades(accountId);
        const rubUsed = await TradesService.sumTodayBuyTradesRub(accountId);

        limits.push({
            accountId,
            accountAlias: config.accountAliases[accountId],
            ordersUsed,
            ordersLimit: config.maxDailyOrders,
            ordersLeft: Math.max(0, config.maxDailyOrders - ordersUsed),
            rubUsed,
            rubLimit: config.maxDailyRub,
            rubLeft: Math.max(0, config.maxDailyRub - rubUsed)
        });
    }

    return { limits };
};

const getPreviewPayload = async (config: RobotConfig) => {
    const previews = [];

    for (const accountId of config.accountIds) {
        previews.push(...await BuySignalEvaluatorService.evaluateAccount(accountId, config));
    }

    return {
        mode: config.dryRun ? 'dry-run' : 'live',
        liveAllowedActions: config.liveAllowedActions,
        previews
    };
};

const handleRequest = async (req: IncomingMessage, res: ServerResponse, startedAt: string) => {
    const url = new URL(req.url ?? '/', 'http://localhost');

    if (req.method !== 'GET') {
        json(res, 405, { error: 'Read-only API supports GET requests only.' });
        return;
    }

    if (url.pathname === '/api/health') {
        json(res, 200, { ok: true, startedAt, uptimeSeconds: Math.round(process.uptime()) });
        return;
    }

    if (!requireAuth(req, res)) return;

    const config = getRobotConfig();

    if (url.pathname === '/') {
        text(res, 200, dashboardPage, 'text/html; charset=utf-8');
        return;
    }

    if (url.pathname === '/api/status') {
        json(res, 200, {
            ok: true,
            startedAt,
            uptimeSeconds: Math.round(process.uptime()),
            runtime: getTradingRuntimeState(),
            config: safeConfig(config)
        });
        return;
    }

    if (url.pathname === '/api/config') {
        json(res, 200, { config: safeConfig(config) });
        return;
    }

    if (url.pathname === '/api/decisions') {
        json(res, 200, await getDecisionsPayload(url));
        return;
    }

    if (url.pathname === '/api/trades') {
        json(res, 200, await getTradesPayload(url));
        return;
    }

    if (url.pathname === '/api/snapshots') {
        json(res, 200, await getSnapshotsPayload(url));
        return;
    }

    if (url.pathname === '/api/performance') {
        json(res, 200, await PerformanceService.getPerformance(url.searchParams.get('accountId')));
        return;
    }

    if (url.pathname === '/api/limits') {
        json(res, 200, await getLimitsPayload(config));
        return;
    }

    if (url.pathname === '/api/preview') {
        json(res, 200, await getPreviewPayload(config));
        return;
    }

    if (url.pathname === '/api/buy-scan') {
        const tickers = url.searchParams.get('tickers')
            ?.split(',')
            .map(ticker => ticker.trim().toUpperCase())
            .filter(Boolean);
        json(res, 200, await BuyScannerService.scan(config, tickers?.length ? tickers : config.scanTickers));
        return;
    }

    if (url.pathname === '/api/buy-backtest') {
        const tickers = url.searchParams.get('tickers')
            ?.split(',')
            .map(ticker => ticker.trim().toUpperCase())
            .filter(Boolean);
        const days = Number(url.searchParams.get('days') ?? 180);
        json(res, 200, await BuyBacktestService.run(
            config,
            tickers?.length ? tickers : config.scanTickers,
            Number.isFinite(days) && days > 0 ? Math.trunc(days) : 180
        ));
        return;
    }

    if (url.pathname === '/api/buy-optimize') {
        const tickers = url.searchParams.get('tickers')
            ?.split(',')
            .map(ticker => ticker.trim().toUpperCase())
            .filter(Boolean);
        const days = Number(url.searchParams.get('days') ?? 180);
        const windows = BuyOptimizerService.parseWindows(url.searchParams.get('windows') ?? undefined);
        const thresholds = BuyOptimizerService.parseThresholds(url.searchParams.get('thresholds') ?? undefined);
        const horizons = BuyOptimizerService.parseHorizons(url.searchParams.get('horizons') ?? undefined);

        json(res, 200, await BuyOptimizerService.optimize(
            config,
            tickers?.length ? tickers : config.scanTickers,
            Number.isFinite(days) && days > 0 ? Math.trunc(days) : 180,
            windows,
            thresholds,
            horizons
        ));
        return;
    }

    if (url.pathname === '/api/accounts') {
        json(res, 200, await getAccountsPayload(config));
        return;
    }

    if (url.pathname === '/api/positions') {
        json(res, 200, await getPositionsPayload(config, url.searchParams.get('accountId')));
        return;
    }

    json(res, 404, { error: 'Not found' });
};

export const startReadOnlyHttpServer = () => {
    const env = getEnv();
    if (!parseBoolean(env.ROBOT_HTTP_ENABLED, true)) {
        console.log('Read-only HTTP server disabled.');
        return undefined;
    }

    const port = parsePort(env.ROBOT_HTTP_PORT);
    const startedAt = new Date().toISOString();
    const server = http.createServer((req, res) => {
        void handleRequest(req, res, startedAt).catch(error => {
            console.error('HTTP API error:', error);
            json(res, 500, { error: error instanceof Error ? error.message : String(error) });
        });
    });

    server.listen(port, '0.0.0.0', () => {
        const authStatus = env.ROBOT_WEB_PASSWORD ? 'enabled' : 'disabled';
        console.log(`Read-only HTTP server listening on ${port}. Auth: ${authStatus}.`);
    });

    return server;
};
