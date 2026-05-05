import http, { IncomingMessage, ServerResponse } from 'http';
import { URL } from 'url';
import path from 'path';
import { readFile, stat, writeFile } from 'fs/promises';
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
import BuySignalJournalService from '../services/buy-signal-journal.service';
import ScanUniverseService from '../services/scan-universe.service';
import ScanTargetsService from '../services/scan-targets.service';
import PaperTradingService from '../services/paper-trading.service';
import MarketRegimeService from '../services/market-regime.service';
import StrategyEvidenceService from '../services/strategy-evidence.service';
import SocialSignalService from '../services/social-signal.service';
import SellBrainService from '../services/sell-brain.service';
import SocialCollectorService from '../services/social-collector.service';
import SocialConsensusService from '../services/social-consensus.service';
import SocialSignalEvidenceService from '../services/social-signal-evidence.service';
import AnalystForecastService from '../services/analyst-forecast.service';

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

const staticRoot = path.resolve(process.cwd(), 'public');
const mimeTypes: Record<string, string> = {
    '.css': 'text/css; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.txt': 'text/plain; charset=utf-8',
    '.webp': 'image/webp'
};

const serveStatic = async (res: ServerResponse, pathname: string) => {
    try {
        const normalizedPath = pathname === '/' ? '/index.html' : pathname;
        const decodedPath = decodeURIComponent(normalizedPath);
        const filePath = path.resolve(staticRoot, `.${decodedPath}`);

        if (filePath !== staticRoot && !filePath.startsWith(staticRoot + path.sep)) return false;

        const fileStat = await stat(filePath);
        if (!fileStat.isFile()) return false;

        const body = await readFile(filePath);
        res.writeHead(200, {
            'content-type': mimeTypes[path.extname(filePath)] ?? 'application/octet-stream',
            'cache-control': filePath.endsWith('index.html') ? 'no-store' : 'public, max-age=31536000, immutable'
        });
        res.end(body);
        return true;
    } catch {
        return false;
    }
};

const SOCIAL_COOKIE_ALLOWLIST = ['investpublicPsid', 'navi_token', 'psid', 'sso_api_session'];

const readJsonBody = async (req: IncomingMessage, maxBytes = 16_384) => new Promise<any>((resolve, reject) => {
    let body = '';

    req.on('data', chunk => {
        body += chunk;
        if (Buffer.byteLength(body) > maxBytes) {
            reject(new Error('request body is too large'));
            req.destroy();
        }
    });
    req.on('end', () => {
        try {
            resolve(body ? JSON.parse(body) : {});
        } catch {
            reject(new Error('invalid JSON body'));
        }
    });
    req.on('error', reject);
});

const updateEnvLine = (content: string, key: string, value: string) => {
    const line = `${key}=${value}`;
    if (new RegExp(`^${key}=`, 'm').test(content)) {
        return content.replace(new RegExp(`^${key}=.*`, 'm'), line);
    }

    return `${content.trimEnd()}\n${line}\n`;
};

const persistSocialCookies = async (sessionId: string | undefined, authCookie: string) => {
    if (sessionId) process.env.ROBOT_SOCIAL_SESSION_ID = sessionId;
    process.env.ROBOT_SOCIAL_AUTH_COOKIE = authCookie;

    const envPath = process.env.ROBOT_ENV_PATH || '.env';
    let content = await readFile(envPath, 'utf8');
    if (sessionId) {
        content = updateEnvLine(content, 'ROBOT_SOCIAL_SESSION_ID', sessionId);
    }
    content = updateEnvLine(content, 'ROBOT_SOCIAL_AUTH_COOKIE', authCookie);
    await writeFile(envPath, content);
};

const handleSocialCookieUpdate = async (req: IncomingMessage, res: ServerResponse) => {
    const env = getEnv();
    const secret = env.ROBOT_SOCIAL_COOKIE_UPDATE_SECRET;

    if (!secret) {
        json(res, 403, { ok: false, error: 'ROBOT_SOCIAL_COOKIE_UPDATE_SECRET is not configured' });
        return;
    }

    const payload = await readJsonBody(req);
    const requestSecret = String(payload.secret ?? req.headers['x-robot-cookie-secret'] ?? '');
    if (requestSecret !== secret) {
        json(res, 401, { ok: false, error: 'invalid secret' });
        return;
    }

    const cookies = payload.cookies && typeof payload.cookies === 'object' ? payload.cookies : {};
    const parts = SOCIAL_COOKIE_ALLOWLIST
        .filter(name => name !== 'psid')
        .map(name => {
            const value = cookies[name];
            return typeof value === 'string' && value.trim() ? `${name}=${value.trim()}` : undefined;
        })
        .filter((value): value is string => Boolean(value));
    const psid = typeof cookies.psid === 'string' && cookies.psid.trim()
        ? cookies.psid.trim()
        : undefined;

    if (!psid && parts.length === 0) {
        json(res, 400, { ok: false, error: 'no allowed cookies found' });
        return;
    }

    await persistSocialCookies(psid, parts.join('; '));

    json(res, 200, {
        ok: true,
        updated: {
            sessionId: Boolean(psid),
            authCookieNames: parts.map(part => part.split('=')[0])
        }
    });
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
    sellHoldWinnerMinProfitPercent: config.sellHoldWinnerMinProfitPercent,
    sellHoldWinnerMaxDrawdownPercent: config.sellHoldWinnerMaxDrawdownPercent,
    maxLotsPerOrder: config.maxLotsPerOrder,
    buyTickers: config.buyTickers,
    scanTickers: config.scanTickers,
    scanUniverse: config.scanUniverse,
    scanUniverseLimit: config.scanUniverseLimit,
    scanMaxLotRub: config.scanMaxLotRub,
    buyTrendDays: config.buyTrendDays,
    buyMinTrendPercent: config.buyMinTrendPercent,
    buyMinMomentumPercent: config.buyMinMomentumPercent,
    buyMinScore: config.buyMinScore,
    buyScoreProfiles: config.buyScoreProfiles,
    maxOrderRub: config.maxOrderRub,
    maxDailyOrders: config.maxDailyOrders,
    maxDailyRub: config.maxDailyRub,
    signalCooldownMs: config.signalCooldownMs,
    signalPriceChangePercent: config.signalPriceChangePercent,
    buySignalJournalIntervalMs: config.buySignalJournalIntervalMs,
    marketRegimeEnabled: config.marketRegimeEnabled,
    marketRegimeTickers: config.marketRegimeTickers,
    marketRegimeDays: config.marketRegimeDays,
    marketRegimeMinHealthPercent: config.marketRegimeMinHealthPercent,
    marketRegimeMinAvgTrendPercent: config.marketRegimeMinAvgTrendPercent,
    paperTradingEnabled: config.paperTradingEnabled,
    paperTradingIntervalMs: config.paperTradingIntervalMs,
    paperMaxPositions: config.paperMaxPositions,
    paperMaxPositionRub: config.paperMaxPositionRub,
    paperCommissionPercent: config.paperCommissionPercent,
    paperReentryCooldownMs: config.paperReentryCooldownMs,
    socialConsensusEnabled: config.socialConsensusEnabled,
    socialConsensusDays: config.socialConsensusDays,
    socialConsensusMaxScoreAdjustment: config.socialConsensusMaxScoreAdjustment,
    socialConsensusMinActors: config.socialConsensusMinActors,
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

    if (req.method === 'POST' && url.pathname === '/api/social-cookies') {
        await handleSocialCookieUpdate(req, res);
        return;
    }

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
        if (await serveStatic(res, url.pathname)) return;
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
        const targets = await ScanTargetsService.resolve(config, tickers);
        json(res, 200, {
            targets,
            ...await BuyScannerService.scan(config, targets.tickers)
        });
        return;
    }

    if (url.pathname === '/api/analyst-forecasts') {
        const tickers = url.searchParams.get('tickers')
            ?.split(',')
            .map(ticker => ticker.trim().toUpperCase())
            .filter(Boolean);
        json(res, 200, await AnalystForecastService.getForecasts(config, tickers?.length ? tickers : config.buyTickers));
        return;
    }

    if (url.pathname === '/api/scan-universe') {
        json(res, 200, await ScanUniverseService.build(config));
        return;
    }

    if (url.pathname === '/api/market-regime') {
        json(res, 200, await MarketRegimeService.evaluate(config));
        return;
    }

    if (url.pathname === '/api/buy-backtest') {
        const tickers = url.searchParams.get('tickers')
            ?.split(',')
            .map(ticker => ticker.trim().toUpperCase())
            .filter(Boolean);
        const days = Number(url.searchParams.get('days') ?? 180);
        const targets = await ScanTargetsService.resolve(config, tickers);
        json(res, 200, await BuyBacktestService.run(
            config,
            targets.tickers,
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
        const targets = await ScanTargetsService.resolve(config, tickers);

        json(res, 200, await BuyOptimizerService.optimize(
            config,
            targets.tickers,
            Number.isFinite(days) && days > 0 ? Math.trunc(days) : 180,
            windows,
            thresholds,
            horizons
        ));
        return;
    }

    if (url.pathname === '/api/buy-signals') {
        const requestedLimit = Number(url.searchParams.get('limit') ?? 100);
        json(res, 200, await BuySignalJournalService.list(
            Number.isFinite(requestedLimit) ? requestedLimit : 100
        ));
        return;
    }

    if (url.pathname === '/api/paper-positions') {
        const requestedLimit = Number(url.searchParams.get('limit') ?? 100);
        json(res, 200, await PaperTradingService.list(
            Number.isFinite(requestedLimit) ? requestedLimit : 100
        ));
        return;
    }

    if (url.pathname === '/api/strategy-evidence') {
        json(res, 200, await StrategyEvidenceService.getEvidence());
        return;
    }

    if (url.pathname === '/api/sell-brain') {
        json(res, 200, await SellBrainService.evaluate(config));
        return;
    }

    if (url.pathname === '/api/social-signals') {
        const requestedLimit = Number(url.searchParams.get('limit') ?? 100);
        json(res, 200, await SocialSignalService.list(
            Number.isFinite(requestedLimit) ? requestedLimit : 100
        ));
        return;
    }

    if (url.pathname === '/api/social-collector') {
        json(res, 200, await SocialCollectorService.status());
        return;
    }

    if (url.pathname === '/api/social-consensus') {
        json(res, 200, await SocialConsensusService.getConsensus({
            days: config.socialConsensusDays,
            maxScoreAdjustment: config.socialConsensusMaxScoreAdjustment,
            minActors: config.socialConsensusMinActors
        }));
        return;
    }

    if (url.pathname === '/api/social-evidence') {
        const requestedLimit = Number(url.searchParams.get('limit') ?? 200);
        json(res, 200, await SocialSignalEvidenceService.getEvidence(
            Number.isFinite(requestedLimit) ? requestedLimit : 200
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

    if (!url.pathname.startsWith('/api/') && await serveStatic(res, url.pathname)) {
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
