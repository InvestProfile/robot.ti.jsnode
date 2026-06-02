import http, { IncomingMessage, ServerResponse } from 'http';
import { URL } from 'url';
import path from 'path';
import { chmod, chown, mkdir, readFile, rename, stat, writeFile } from 'fs/promises';
import { OrderIdType } from 'tinkoff-sdk-grpc-js/dist/generated/orders';
import { getEnv } from '../config/env.config';
import { getRobotConfig, RobotConfig } from '../config/robot.config';
import { ensureProtectiveStopsForOpenRobotPositions, getTradingRuntimeState } from '../modules/common.module';
import { TradeDecisionModel } from '../models/trade-decision.model';
import BuySignalEvaluatorService from '../services/buy-signal-evaluator.service';
import OperationsService from '../services/operations.service';
import InstrumentsService from '../services/instruments.service';
import { numberToQuotation, quotationToNumber } from '../utils/money';
import { dashboardPage } from './dashboard-page';
import { TradesModel } from '../models/trades.model';
import TradesService from '../services/trades.service';
import OrdersService from '../services/orders.service';
import { ORDER_SIDE } from '../services/orders.service';
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
import RuntimeConfigService from '../services/runtime-config.service';
import TechnicalAnalysisService from '../services/technical-analysis.service';
import BuyCandidateLabService from '../services/buy-candidate-lab.service';
import BuyRecommendationService from '../services/buy-recommendation.service';
import RobotPositionLedgerService from '../services/robot-position-ledger.service';
import MarketRegimeLabService from '../services/market-regime-lab.service';
import DailyBuyListService from '../services/daily-buy-list.service';
import TradePnlService from '../services/trade-pnl.service';
import TradeBudgetService from '../services/trade-budget.service';
import ProfileManagementService from '../services/profile-management.service';
import MarketDataService from '../services/marketData.service';
import ProtectiveStopService from '../services/protective-stop.service';
import AccountingAuditService from '../services/accounting-audit.service';
import { isOpenOrderStatus, isRejectedOrderStatus } from '../utils/order-status';
import StopLossStrategy from '../strategies/stop-loss.strategy';

type AccountMode = 'trade' | 'observe';

const PREVIEW_CACHE_TTL_MS = 30_000;
const PREVIEW_CACHE_MAX_STALE_MS = 30 * 60_000;
const PREVIEW_CACHE_PATH = process.env.ROBOT_PREVIEW_CACHE_PATH
    || path.resolve(process.cwd(), '.runtime', 'preview-cache.json');

interface PreviewPayload {
    mode: 'dry-run' | 'live';
    liveAllowedActions: RobotConfig['liveAllowedActions'];
    brokerQuoteMode: string;
    previews: unknown[];
}

interface PreviewCacheEntry {
    payload?: PreviewPayload;
    createdAt: number;
    refreshing?: Promise<PreviewPayload>;
}

const previewPayloadCache = new Map<string, PreviewCacheEntry>();
let previewDiskCacheLoaded = false;

const invalidatePreviewCache = () => {
    previewPayloadCache.clear();
};

const loadPreviewCacheFromDisk = async () => {
    if (previewDiskCacheLoaded) return;
    previewDiskCacheLoaded = true;

    try {
        const content = await readFile(PREVIEW_CACHE_PATH, 'utf8');
        const parsed = JSON.parse(content) as {
            entries?: Record<string, { payload?: PreviewPayload; createdAt?: number }>;
        };

        for (const [key, entry] of Object.entries(parsed.entries ?? {})) {
            if (!entry.payload || !Number.isFinite(entry.createdAt)) continue;

            previewPayloadCache.set(key, {
                payload: entry.payload,
                createdAt: Number(entry.createdAt)
            });
        }
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            console.error('Preview cache load failed:', error instanceof Error ? error.message : error);
        }
    }
};

const persistPreviewCacheToDisk = async () => {
    try {
        const entries = Object.fromEntries(
            [...previewPayloadCache.entries()]
                .filter(([, entry]) => entry.payload)
                .map(([key, entry]) => [key, {
                    payload: entry.payload,
                    createdAt: entry.createdAt
                }])
        );
        const tmpPath = `${PREVIEW_CACHE_PATH}.tmp-${process.pid}-${Date.now()}`;

        await mkdir(path.dirname(PREVIEW_CACHE_PATH), { recursive: true });
        await writeFile(tmpPath, JSON.stringify({
            updatedAt: new Date().toISOString(),
            entries
        }), { mode: 0o600 });
        await rename(tmpPath, PREVIEW_CACHE_PATH);
    } catch (error) {
        console.error('Preview cache persist failed:', error instanceof Error ? error.message : error);
    }
};

const parseBoolean = (value: string | undefined, defaultValue: boolean) => {
    if (value === undefined) return defaultValue;
    return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
};

const getHttpAuthConfigError = () => {
    const env = getEnv();
    const config = getRobotConfig();
    const localDev = parseBoolean(env.ROBOT_HTTP_LOCAL_DEV, false);

    if (env.ROBOT_WEB_PASSWORD) return undefined;
    if (localDev && config.dryRun) return undefined;

    return 'ROBOT_WEB_PASSWORD must be set. To run an unauthenticated local dry-run dashboard, set ROBOT_HTTP_LOCAL_DEV=true and keep ROBOT_DRY_RUN=true.';
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
    const currentStat = await stat(envPath).catch(() => undefined);
    let content = await readFile(envPath, 'utf8');
    if (sessionId) {
        content = updateEnvLine(content, 'ROBOT_SOCIAL_SESSION_ID', sessionId);
    }
    content = updateEnvLine(content, 'ROBOT_SOCIAL_AUTH_COOKIE', authCookie);
    const tmpPath = `${envPath}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(tmpPath, content, { mode: 0o600 });
    if (currentStat) {
        await chown(tmpPath, currentStat.uid, currentStat.gid).catch(() => undefined);
        await chmod(tmpPath, currentStat.mode & 0o777).catch(() => undefined);
    }
    await rename(tmpPath, envPath);
};

const handleSocialCookieUpdate = async (req: IncomingMessage, res: ServerResponse) => {
    try {
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
    } catch (error) {
        json(res, 400, {
            ok: false,
            error: error instanceof Error ? error.message : String(error)
        });
    }
};

const handleAccountModeUpdate = async (req: IncomingMessage, res: ServerResponse) => {
    if (!String(req.headers['content-type'] ?? '').includes('application/json')) {
        json(res, 415, { ok: false, error: 'content-type must be application/json' });
        return;
    }

    if (req.headers['x-robot-admin-action'] !== 'account-mode') {
        json(res, 403, { ok: false, error: 'missing x-robot-admin-action header' });
        return;
    }

    try {
        const payload = await readJsonBody(req);
        const accountId = String(payload.accountId ?? '').trim();
        const mode = String(payload.mode ?? '').trim();
        const allowProtectedTrade = payload.allowProtectedTrade === true;
        const confirmation = String(payload.confirmation ?? '').trim();

        if (!accountId) {
            json(res, 400, { ok: false, error: 'accountId is required' });
            return;
        }

        if (mode !== 'trade' && mode !== 'observe') {
            json(res, 400, { ok: false, error: 'mode must be trade or observe' });
            return;
        }

        if (mode === 'trade' && allowProtectedTrade && confirmation !== accountId) {
            json(res, 400, { ok: false, error: 'protected trade confirmation must match accountId' });
            return;
        }

        const result = await RuntimeConfigService.setAccountMode(
            accountId,
            mode,
            'web-dashboard',
            allowProtectedTrade ? 'web-dashboard protected override' : undefined,
            allowProtectedTrade
        );
        invalidatePreviewCache();

        json(res, 200, {
            ok: true,
            ...result
        });
    } catch (error) {
        json(res, 400, {
            ok: false,
            error: error instanceof Error ? error.message : String(error)
        });
    }
};

const handleLiveActionsUpdate = async (req: IncomingMessage, res: ServerResponse) => {
    if (!String(req.headers['content-type'] ?? '').includes('application/json')) {
        json(res, 415, { ok: false, error: 'content-type must be application/json' });
        return;
    }

    if (req.headers['x-robot-admin-action'] !== 'live-actions') {
        json(res, 403, { ok: false, error: 'missing x-robot-admin-action header' });
        return;
    }

    try {
        const payload = await readJsonBody(req);
        const actions = Array.isArray(payload.actions)
            ? payload.actions.map((action: unknown) => String(action))
            : [];
        const wantsSell = actions.includes('sell');
        const confirmation = String(payload.confirmation ?? '').trim();

        if (wantsSell && confirmation !== 'SELL') {
            json(res, 400, { ok: false, error: 'type SELL to arm live sells' });
            return;
        }

        const result = await RuntimeConfigService.setLiveAllowedActions(actions, 'web-dashboard');
        invalidatePreviewCache();

        json(res, 200, {
            ok: true,
            ...result
        });
    } catch (error) {
        json(res, 400, {
            ok: false,
            error: error instanceof Error ? error.message : String(error)
        });
    }
};

const handleOrderTypeUpdate = async (req: IncomingMessage, res: ServerResponse) => {
    if (!String(req.headers['content-type'] ?? '').includes('application/json')) {
        json(res, 415, { ok: false, error: 'content-type must be application/json' });
        return;
    }

    if (req.headers['x-robot-admin-action'] !== 'order-type') {
        json(res, 403, { ok: false, error: 'missing x-robot-admin-action header' });
        return;
    }

    try {
        const payload = await readJsonBody(req);
        const buyOrderType = String(payload.buyOrderType ?? '').trim().toLowerCase();
        const sellOrderType = String(payload.sellOrderType ?? '').trim().toLowerCase();
        const confirmation = String(payload.confirmation ?? '').trim();
        const allowedBuy = new Set(['market', 'limit', 'smart']);
        const allowedSell = new Set(['market', 'limit']);

        if (!allowedBuy.has(buyOrderType) || !allowedSell.has(sellOrderType)) {
            json(res, 400, { ok: false, error: 'buyOrderType must be market, limit or smart; sellOrderType must be market or limit' });
            return;
        }

        if (sellOrderType === 'limit' && confirmation !== 'LIMIT_SELL') {
            json(res, 400, { ok: false, error: 'type LIMIT_SELL to enable limit sells; stop-loss limit orders can remain unfilled' });
            return;
        }

        const settings = await RuntimeConfigService.setOrderTypeSettings({
            buyOrderType,
            sellOrderType
        }, 'web-dashboard');
        invalidatePreviewCache();

        json(res, 200, {
            ok: true,
            settings
        });
    } catch (error) {
        json(res, 400, {
            ok: false,
            error: error instanceof Error ? error.message : String(error)
        });
    }
};

const handleMarketRegimeUpdate = async (req: IncomingMessage, res: ServerResponse) => {
    if (!String(req.headers['content-type'] ?? '').includes('application/json')) {
        json(res, 415, { ok: false, error: 'content-type must be application/json' });
        return;
    }

    if (req.headers['x-robot-admin-action'] !== 'market-regime') {
        json(res, 403, { ok: false, error: 'missing x-robot-admin-action header' });
        return;
    }

    try {
        const payload = await readJsonBody(req);
        const minHealthPercent = Number(payload.minHealthPercent);
        const minAvgTrendPercent = Number(payload.minAvgTrendPercent);

        if (!Number.isFinite(minHealthPercent) || minHealthPercent < 0 || minHealthPercent > 100) {
            json(res, 400, { ok: false, error: 'minHealthPercent must be 0..100' });
            return;
        }

        if (!Number.isFinite(minAvgTrendPercent) || minAvgTrendPercent < -20 || minAvgTrendPercent > 20) {
            json(res, 400, { ok: false, error: 'minAvgTrendPercent must be -20..20' });
            return;
        }

        const settings = await RuntimeConfigService.setMarketRegimeSettings({
            minHealthPercent,
            minAvgTrendPercent
        }, 'web-dashboard');
        invalidatePreviewCache();
        const config = await RuntimeConfigService.getEffectiveConfig(getRobotConfig());

        json(res, 200, {
            ok: true,
            settings,
            market: await MarketRegimeService.evaluate(config)
        });
    } catch (error) {
        json(res, 400, {
            ok: false,
            error: error instanceof Error ? error.message : String(error)
        });
    }
};

const handleRiskSettingsUpdate = async (req: IncomingMessage, res: ServerResponse) => {
    if (!String(req.headers['content-type'] ?? '').includes('application/json')) {
        json(res, 415, { ok: false, error: 'content-type must be application/json' });
        return;
    }

    if (req.headers['x-robot-admin-action'] !== 'risk-settings') {
        json(res, 403, { ok: false, error: 'missing x-robot-admin-action header' });
        return;
    }

    try {
        const payload = await readJsonBody(req);
        const baseConfig = getRobotConfig();
        const currentConfig = await RuntimeConfigService.getEffectiveConfig(baseConfig);
        const maxOrderRub = Number(payload.maxOrderRub);
        const maxDailyOrders = Number(payload.maxDailyOrders);
        const maxDailyRub = Number(payload.maxDailyRub);
        const maxPositionSharePercent = payload.maxPositionSharePercent === undefined
            ? currentConfig.maxPositionSharePercent
            : Number(payload.maxPositionSharePercent);
        const minDiversificationPositions = payload.minDiversificationPositions === undefined
            ? currentConfig.minDiversificationPositions
            : Number(payload.minDiversificationPositions);
        const diversificationFirst = payload.diversificationFirst === undefined
            ? currentConfig.diversificationFirst
            : payload.diversificationFirst;

        if (!Number.isFinite(maxOrderRub) || maxOrderRub < 0 || maxOrderRub > baseConfig.maxRuntimeOrderRub) {
            json(res, 400, { ok: false, error: `maxOrderRub must be 0..${baseConfig.maxRuntimeOrderRub}` });
            return;
        }

        if (!Number.isFinite(maxDailyOrders) || maxDailyOrders < 0 || maxDailyOrders > baseConfig.maxRuntimeDailyOrders) {
            json(res, 400, { ok: false, error: `maxDailyOrders must be 0..${baseConfig.maxRuntimeDailyOrders}` });
            return;
        }

        if (!Number.isFinite(maxDailyRub) || maxDailyRub < 0 || maxDailyRub > baseConfig.maxRuntimeDailyRub) {
            json(res, 400, { ok: false, error: `maxDailyRub must be 0..${baseConfig.maxRuntimeDailyRub}` });
            return;
        }

        if (!Number.isFinite(maxPositionSharePercent) || maxPositionSharePercent < 0 || maxPositionSharePercent > 100) {
            json(res, 400, { ok: false, error: 'maxPositionSharePercent must be 0..100' });
            return;
        }

        if (!Number.isFinite(minDiversificationPositions) || minDiversificationPositions < 0 || minDiversificationPositions > 100) {
            json(res, 400, { ok: false, error: 'minDiversificationPositions must be 0..100' });
            return;
        }

        if (typeof diversificationFirst !== 'boolean') {
            json(res, 400, { ok: false, error: 'diversificationFirst must be boolean' });
            return;
        }

        const settings = await RuntimeConfigService.setRiskSettings({
            maxOrderRub,
            maxDailyOrders,
            maxDailyRub,
            maxPositionSharePercent,
            minDiversificationPositions,
            diversificationFirst
        }, 'web-dashboard');
        invalidatePreviewCache();
        const config = await RuntimeConfigService.getEffectiveConfig(getRobotConfig());

        json(res, 200, {
            ok: true,
            settings,
            limits: await getLimitsPayload(config)
        });
    } catch (error) {
        json(res, 400, {
            ok: false,
            error: error instanceof Error ? error.message : String(error)
        });
    }
};

const handleSellSettingsUpdate = async (req: IncomingMessage, res: ServerResponse) => {
    if (!String(req.headers['content-type'] ?? '').includes('application/json')) {
        json(res, 415, { ok: false, error: 'content-type must be application/json' });
        return;
    }

    if (req.headers['x-robot-admin-action'] !== 'sell-settings') {
        json(res, 403, { ok: false, error: 'missing x-robot-admin-action header' });
        return;
    }

    try {
        const payload = await readJsonBody(req);
        const currentConfig = await RuntimeConfigService.getEffectiveConfig(getRobotConfig());
        const settings = {
            stopLossPercent: payload.stopLossPercent === undefined
                ? currentConfig.stopLossPercent
                : Number(payload.stopLossPercent),
            trailingStopPercent: payload.trailingStopPercent === undefined
                ? currentConfig.trailingStopPercent
                : Number(payload.trailingStopPercent),
            trailingStopMinProfitPercent: payload.trailingStopMinProfitPercent === undefined
                ? currentConfig.trailingStopMinProfitPercent
                : Number(payload.trailingStopMinProfitPercent),
            sellHoldWinnerMinProfitPercent: payload.sellHoldWinnerMinProfitPercent === undefined
                ? currentConfig.sellHoldWinnerMinProfitPercent
                : Number(payload.sellHoldWinnerMinProfitPercent),
            sellHoldWinnerMaxDrawdownPercent: payload.sellHoldWinnerMaxDrawdownPercent === undefined
                ? currentConfig.sellHoldWinnerMaxDrawdownPercent
                : Number(payload.sellHoldWinnerMaxDrawdownPercent)
        };

        for (const [key, value] of Object.entries(settings)) {
            if (!Number.isFinite(value) || value < 0) {
                json(res, 400, { ok: false, error: `${key} must be a positive number` });
                return;
            }
        }

        json(res, 200, {
            ok: true,
            settings: await RuntimeConfigService.setSellSettings(settings, 'web-dashboard')
        });
    } catch (error) {
        json(res, 400, {
            ok: false,
            error: error instanceof Error ? error.message : String(error)
        });
    }
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
    orderType: config.orderType,
    buyOrderType: config.buyOrderType,
    sellOrderType: config.sellOrderType,
    protectiveStopsEnabled: config.protectiveStopsEnabled,
    staleLimitOrderMs: config.staleLimitOrderMs,
    staleLimitPriceDriftPercent: config.staleLimitPriceDriftPercent,
    tradingPaused: config.tradingPaused,
    maxConsecutiveTickErrors: config.maxConsecutiveTickErrors,
    intervalMs: config.intervalMs,
    positionDelayMs: config.positionDelayMs,
    enabledStrategies: config.enabledStrategies,
    minProfitPercent: config.minProfitPercent,
    stopLossPercent: config.stopLossPercent,
    stopLossVolatilityDays: config.stopLossVolatilityDays,
    stopLossVolatilityMultiplier: config.stopLossVolatilityMultiplier,
    stopLossMaxPercent: config.stopLossMaxPercent,
    trailingStopPercent: config.trailingStopPercent,
    trailingStopMinProfitPercent: config.trailingStopMinProfitPercent,
    trailingStopVolatilityDays: config.trailingStopVolatilityDays,
    trailingStopVolatilityMultiplier: config.trailingStopVolatilityMultiplier,
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
    maxRuntimeOrderRub: config.maxRuntimeOrderRub,
    maxRuntimeDailyOrders: config.maxRuntimeDailyOrders,
    maxRuntimeDailyRub: config.maxRuntimeDailyRub,
    maxPositionSharePercent: config.maxPositionSharePercent,
    minDiversificationPositions: config.minDiversificationPositions,
    diversificationFirst: config.diversificationFirst,
    liquidityRiskEnabled: config.liquidityRiskEnabled,
    liquidityRiskEnforced: config.liquidityRiskEnforced,
    maxSpreadPercent: config.maxSpreadPercent,
    minOrderbookAskRub: config.minOrderbookAskRub,
    minDailyTurnoverRub: config.minDailyTurnoverRub,
    sectorRiskEnabled: config.sectorRiskEnabled,
    sectorRiskEnforced: config.sectorRiskEnforced,
    maxSectorSharePercent: config.maxSectorSharePercent,
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
    analystConsensusEnabled: config.analystConsensusEnabled,
    analystConsensusMaxScoreAdjustment: config.analystConsensusMaxScoreAdjustment,
    technicalScoreEnabled: config.technicalScoreEnabled,
    technicalMaxScoreAdjustment: config.technicalMaxScoreAdjustment,
    snapshotIntervalMs: config.snapshotIntervalMs
});

const getAllAccounts = (config: RobotConfig) => [
    ...config.accountIds.map(accountId => ({ accountId, mode: 'trade' as AccountMode })),
    ...config.observeAccountIds.map(accountId => ({ accountId, mode: 'observe' as AccountMode }))
];

const getAccountsPayload = async (config: RobotConfig) => {
    const modeByAccount = new Map(
        (await RuntimeConfigService.getAccountModes()).map(account => [account.accountId, account])
    );
    const accounts = [];

    for (const account of getAllAccounts(config)) {
        const portfolio = await OperationsService.getPortfolio(account.accountId);
        const mode = modeByAccount.get(account.accountId);

        accounts.push({
            ...account,
            alias: config.accountAliases[account.accountId],
            baseMode: mode?.baseMode,
            overrideMode: mode?.overrideMode,
            protected: mode?.protected ?? config.protectedAccountIds.includes(account.accountId),
            protectedTradeEnabled: mode?.protectedTradeEnabled ?? false,
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

const getTradePnlPayload = async (url: URL, config: RobotConfig) => {
    const requestedLimit = Number(url.searchParams.get('limit') ?? 500);
    return await TradePnlService.getRoundTripPnl(config, requestedLimit);
};

const orderPriceFromRow = (row: Record<string, unknown>) => {
    const executed = quotationToNumber({
        units: Number(row.executedPriceUnits ?? 0),
        nano: Number(row.executedPriceNano ?? 0)
    });
    if (executed !== undefined && executed > 0) return executed;

    return quotationToNumber({
        units: Number(row.price_units ?? 0),
        nano: Number(row.price_nano ?? 0)
    });
};

const getOrderSafetyPayload = async (url: URL, config: RobotConfig) => {
    const requestedLimit = Number(url.searchParams.get('limit') ?? 80);
    const limit = Math.min(Math.max(Number.isFinite(requestedLimit) ? requestedLimit : 80, 1), 300);
    const trades = await TradesModel.findAll({
        order: [['createdAt', 'DESC']],
        limit
    });
    const rows = trades.map(trade => trade.toJSON() as Record<string, unknown>);
    const finalFill = rows.filter(row => row.status === 'EXECUTION_REPORT_STATUS_FILL').length;
    const rejected = rows.filter(row => isRejectedOrderStatus(row.status ? String(row.status) : undefined)).length;
    const unknown = rows.filter(row => row.status === 'LOCAL_SUBMIT_UNKNOWN').length;
    const pending = rows.filter(row => row.status === 'LOCAL_PENDING_SUBMIT' || row.status === 'EXECUTION_REPORT_STATUS_NEW').length;
    const partial = rows.filter(row => row.status === 'EXECUTION_REPORT_STATUS_PARTIALLYFILL').length;
    const openRows = rows.filter(row => isOpenOrderStatus(row.status ? String(row.status) : undefined));
    const open = openRows.length;
    const market = rows.filter(row => row.orderType === 'ORDER_TYPE_MARKET').length;
    const limitOrders = rows.filter(row => row.orderType === 'ORDER_TYPE_LIMIT').length;
    const bestPrice = rows.filter(row => row.orderType === 'ORDER_TYPE_BESTPRICE').length;
    const pendingLimit = openRows.filter(row => row.orderType === 'ORDER_TYPE_LIMIT').length;
    const lastPrices = await MarketDataService.getLastPrices(
        openRows
            .map(row => String(row.instrumentId || row.instrumentUid || row.uid || ''))
            .filter(Boolean)
    );
    const now = Date.now();
    const enrichedRows = rows.map(row => {
        const openedAt = new Date(String(row.tradeDateTime || row.createdAt || '')).getTime();
        const ageMs = Number.isFinite(openedAt) ? Math.max(0, now - openedAt) : 0;
        const instrumentId = String(row.instrumentId || row.instrumentUid || row.uid || '');
        const lastPrice = instrumentId ? lastPrices.get(instrumentId) : undefined;
        const orderPrice = orderPriceFromRow(row);
        const priceDriftPercent = orderPrice && lastPrice
            ? Math.abs(lastPrice - orderPrice) / orderPrice * 100
            : undefined;
        const isOpen = isOpenOrderStatus(row.status ? String(row.status) : undefined);
        const isLimit = row.orderType === 'ORDER_TYPE_LIMIT';
        const staleByAge = isOpen && isLimit && config.staleLimitOrderMs > 0 && ageMs >= config.staleLimitOrderMs;
        const staleByPrice = isOpen
            && isLimit
            && config.staleLimitPriceDriftPercent > 0
            && priceDriftPercent !== undefined
            && priceDriftPercent >= config.staleLimitPriceDriftPercent;

        return {
            ...row,
            orderAgeMs: ageMs,
            orderPrice,
            lastPrice,
            priceDriftPercent,
            staleLimitReason: staleByAge && staleByPrice
                ? 'age-and-price-drift'
                : staleByAge
                    ? 'age'
                    : staleByPrice
                        ? 'price-drift'
                        : undefined
        };
    });
    const staleLimit = enrichedRows.filter(row => row.staleLimitReason).length;
    const oldestOpenAt = openRows
        .map(row => new Date(String(row.tradeDateTime || row.createdAt || '')).getTime())
        .filter(timestamp => Number.isFinite(timestamp))
        .sort((a, b) => a - b)[0];

    return {
        summary: {
            open,
            pending,
            unknown,
            partial,
            filled: finalFill,
            rejected,
            market,
            limit: limitOrders,
            bestPrice,
            pendingLimit,
            staleLimit,
            oldestOpenAt: oldestOpenAt ? new Date(oldestOpenAt).toISOString() : undefined,
            oldestOpenAgeMs: oldestOpenAt ? Math.max(0, Date.now() - oldestOpenAt) : 0,
            checked: rows.length,
            stalePolicy: {
                maxAgeMs: config.staleLimitOrderMs,
                maxPriceDriftPercent: config.staleLimitPriceDriftPercent
            }
        },
        orders: enrichedRows
    };
};

const getProtectiveStopsPayload = async (config: RobotConfig) => {
    const stops = [];
    const errors = [];
    const ledger = await RobotPositionLedgerService.getLedger(config);
    const ledgerItems = (ledger.items || []).filter(item => Number(item.lots ?? 0) > 0);
    const ledgerByAccountAndInstrument = new Map(
        ledgerItems.flatMap(item => {
            const accountId = String(item.accountId || '');
            const entries: Array<[string, Record<string, unknown>]> = [];
            if (accountId && item.instrumentUid) entries.push([`${accountId}:${item.instrumentUid}`, item]);
            if (accountId && item.figi) entries.push([`${accountId}:${item.figi}`, item]);
            return entries;
        })
    );
    const activeLotsByAccountAndInstrument = new Map<string, number>();

    for (const account of getAllAccounts(config)) {
        try {
            const accountStops = await ProtectiveStopService.getActiveStops(account.accountId);
            for (const stop of accountStops) {
                const instrumentUid = String(stop.instrumentUid || '');
                const figi = String(stop.figi || '');
                const ledgerItem = ledgerByAccountAndInstrument.get(`${account.accountId}:${instrumentUid}`)
                    ?? ledgerByAccountAndInstrument.get(`${account.accountId}:${figi}`);
                const lotsRequested = Number(stop.lotsRequested ?? 0);
                if (instrumentUid) {
                    const key = `${account.accountId}:${instrumentUid}`;
                    activeLotsByAccountAndInstrument.set(key, (activeLotsByAccountAndInstrument.get(key) ?? 0) + lotsRequested);
                }
                if (figi) {
                    const key = `${account.accountId}:${figi}`;
                    activeLotsByAccountAndInstrument.set(key, (activeLotsByAccountAndInstrument.get(key) ?? 0) + lotsRequested);
                }

                const averagePrice = Number(ledgerItem?.averagePrice);
                const stopPrice = quotationToNumber(stop.stopPrice);
                let stopPlan;
                let expectedStopPrice;
                let driftPercent;
                let driftStatus = ledgerItem ? 'unknown' : 'no-ledger';

                if (ledgerItem && Number.isFinite(averagePrice) && averagePrice > 0 && instrumentUid) {
                    stopPlan = await StopLossStrategy.calculateEffectiveStop({
                        accountId: account.accountId,
                        ticker: String(ledgerItem.ticker || stop.ticker || ''),
                        instrumentUid
                    }, config);
                    expectedStopPrice = averagePrice * (1 - stopPlan.effectiveStopPercent / 100);

                    const numericStopPrice = Number(stopPrice);
                    if (Number.isFinite(numericStopPrice) && numericStopPrice > 0 && expectedStopPrice > 0) {
                        driftPercent = (numericStopPrice / expectedStopPrice - 1) * 100;
                        if (Math.abs(driftPercent) <= 0.5) {
                            driftStatus = 'ok';
                        } else {
                            driftStatus = driftPercent > 0 ? 'too-tight' : 'too-wide';
                        }
                    }
                }

                stops.push({
                    accountId: account.accountId,
                    accountAlias: config.accountAliases[account.accountId],
                    accountMode: account.mode,
                    stopOrderId: stop.stopOrderId,
                    figi: stop.figi,
                    instrumentUid: stop.instrumentUid,
                    ticker: stop.ticker || ledgerItem?.ticker,
                    name: ledgerItem?.name,
                    direction: stop.direction,
                    orderType: stop.orderType,
                    status: stop.status,
                    exchangeOrderType: stop.exchangeOrderType,
                    lotsRequested: stop.lotsRequested,
                    ledgerLots: ledgerItem?.lots,
                    price: quotationToNumber(stop.price),
                    stopPrice,
                    expectedStopPrice,
                    stopPlan,
                    driftPercent,
                    driftStatus,
                    createDate: stop.createDate,
                    activationDateTime: stop.activationDateTime,
                    expirationTime: stop.expirationTime
                });
            }
        } catch (error) {
            errors.push({
                accountId: account.accountId,
                accountAlias: config.accountAliases[account.accountId],
                error: error instanceof Error ? error.message : String(error)
            });
        }
    }

    const uncoveredPositions = ledgerItems
        .filter(item => {
            const accountId = String(item.accountId || '');
            const instrumentUid = String(item.instrumentUid || '');
            const figi = String(item.figi || '');
            const activeLots = Math.max(
                activeLotsByAccountAndInstrument.get(`${accountId}:${instrumentUid}`) ?? 0,
                activeLotsByAccountAndInstrument.get(`${accountId}:${figi}`) ?? 0
            );
            return activeLots < Number(item.lots ?? 0);
        })
        .map(item => {
        const accountId = String(item.accountId || '');
        const instrumentUid = String(item.instrumentUid || '');
        const figi = String(item.figi || '');
        const activeLots = Math.max(
            activeLotsByAccountAndInstrument.get(`${accountId}:${instrumentUid}`) ?? 0,
            activeLotsByAccountAndInstrument.get(`${accountId}:${figi}`) ?? 0
        );
            const lastFailure = ProtectiveStopService.getLastFailure(accountId, instrumentUid);

            return {
                ...item,
                activeStopLots: activeLots,
                uncoveredLots: Math.max(0, Number(item.lots ?? 0) - activeLots),
                protectiveStopFailure: lastFailure,
                protectiveStopStatus: lastFailure ? 'broker-rejected' : 'uncovered'
            };
        });

    return {
        summary: {
            enabled: config.protectiveStopsEnabled,
            active: stops.length,
            ok: stops.filter(stop => stop.driftStatus === 'ok').length,
            tooTight: stops.filter(stop => stop.driftStatus === 'too-tight').length,
            tooWide: stops.filter(stop => stop.driftStatus === 'too-wide').length,
            noLedger: stops.filter(stop => stop.driftStatus === 'no-ledger').length,
            uncoveredPositions: uncoveredPositions.length,
            brokerRejected: uncoveredPositions.filter(item => item.protectiveStopStatus === 'broker-rejected').length,
            errors: errors.length
        },
        stops,
        uncoveredPositions,
        errors
    };
};

const getStaleLimitCancelCandidates = async (config: RobotConfig, limit = 300) => {
    const payload = await getOrderSafetyPayload(
        new URL(`http://localhost/api/order-safety?limit=${Math.min(Math.max(limit, 1), 300)}`),
        config
    );

    return {
        payload,
        candidates: payload.orders.filter(row => row.staleLimitReason) as Array<Record<string, unknown>>
    };
};

const cancelStaleLimitCandidate = async (row: Record<string, unknown>) => {
    const accountId = String(row.accountId || '');
    const brokerOrderId = String(row.orderId || '');
    const clientOrderId = String(row.clientOrderId || '');
    const attempts: Array<{ orderId: string; orderIdType?: OrderIdType; source: string }> = [];

    if (brokerOrderId && brokerOrderId !== clientOrderId) {
        attempts.push({
            orderId: brokerOrderId,
            orderIdType: OrderIdType.ORDER_ID_TYPE_EXCHANGE,
            source: 'broker-order-id'
        });
    }

    if (clientOrderId) {
        attempts.push({
            orderId: clientOrderId,
            orderIdType: OrderIdType.ORDER_ID_TYPE_REQUEST,
            source: 'client-order-id'
        });
    }

    if (!attempts.length && brokerOrderId) {
        attempts.push({
            orderId: brokerOrderId,
            source: 'stored-order-id'
        });
    }

    if (!accountId || !attempts.length) {
        throw new Error('stale limit order has no cancellable account/order id');
    }

    const errors = [];
    for (const attempt of attempts) {
        try {
            const response = await OrdersService.cancelOrder(accountId, attempt.orderId, attempt.orderIdType);
            return {
                ok: true,
                accountId,
                orderId: attempt.orderId,
                source: attempt.source,
                response
            };
        } catch (error) {
            errors.push({
                source: attempt.source,
                orderId: attempt.orderId,
                error: error instanceof Error ? error.message : String(error)
            });
        }
    }

    throw new Error(errors.map(error => `${error.source}: ${error.error}`).join('; '));
};

const handleCancelStaleLimitOrders = async (req: IncomingMessage, res: ServerResponse) => {
    if (req.headers['x-robot-admin-action'] !== 'cancel-stale-limit-orders') {
        json(res, 403, { ok: false, error: 'missing x-robot-admin-action header' });
        return;
    }

    try {
        const body = await readJsonBody(req, 4096);
        const baseConfig = getRobotConfig();
        const config = await RuntimeConfigService.getEffectiveConfig(baseConfig);
        const limit = Number(body.limit ?? 300);
        const dryRun = body.dryRun !== false;
        const { candidates } = await getStaleLimitCancelCandidates(config, Number.isFinite(limit) ? limit : 300);

        if (dryRun) {
            json(res, 200, {
                ok: true,
                dryRun: true,
                candidates: candidates.map(row => ({
                    id: row.id,
                    accountId: row.accountId,
                    ticker: row.ticker,
                    orderId: row.orderId,
                    clientOrderId: row.clientOrderId,
                    staleLimitReason: row.staleLimitReason,
                    orderAgeMs: row.orderAgeMs,
                    priceDriftPercent: row.priceDriftPercent
                }))
            });
            return;
        }

        if (body.confirm !== 'CANCEL_STALE_LIMITS') {
            json(res, 400, { ok: false, error: 'confirmation CANCEL_STALE_LIMITS is required' });
            return;
        }

        if (config.dryRun) {
            json(res, 400, { ok: false, error: 'real broker cancel is disabled in dry-run mode' });
            return;
        }

        const results = [];
        for (const candidate of candidates) {
            try {
                results.push({
                    id: candidate.id,
                    ticker: candidate.ticker,
                    ...(await cancelStaleLimitCandidate(candidate))
                });
            } catch (error) {
                results.push({
                    ok: false,
                    id: candidate.id,
                    ticker: candidate.ticker,
                    accountId: candidate.accountId,
                    error: error instanceof Error ? error.message : String(error)
                });
            }
        }

        json(res, 200, {
            ok: true,
            dryRun: false,
            attempted: candidates.length,
            cancelled: results.filter(result => result.ok).length,
            failed: results.filter(result => !result.ok).length,
            results
        });
    } catch (error) {
        json(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
};

const handleProtectiveStopResync = async (req: IncomingMessage, res: ServerResponse) => {
    if (req.headers['x-robot-admin-action'] !== 'protective-stops-resync') {
        json(res, 403, { ok: false, error: 'missing x-robot-admin-action header' });
        return;
    }

    try {
        const body = await readJsonBody(req, 4096);
        if (body.confirm !== 'RESYNC_PROTECTIVE_STOPS') {
            json(res, 400, { ok: false, error: 'confirmation RESYNC_PROTECTIVE_STOPS is required' });
            return;
        }

        const baseConfig = getRobotConfig();
        const config = await RuntimeConfigService.getEffectiveConfig(baseConfig);
        const result = await ensureProtectiveStopsForOpenRobotPositions(config, 'manual');

        json(res, 200, {
            ok: !result.error,
            result
        });
    } catch (error) {
        json(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
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
        const [ordersUsed, rubUsed, portfolio] = await Promise.all([
            TradesService.countTodayTrades(accountId),
            TradesService.sumTodayBuyTradesRub(accountId),
            OperationsService.getPortfolio(accountId)
        ]);
        const totalRub = quotationToNumber(portfolio?.totalAmountPortfolio);
        const cashRub = quotationToNumber(portfolio?.totalAmountCurrencies);

        limits.push({
            accountId,
            accountAlias: config.accountAliases[accountId],
            mode: 'trade',
            ordersUsed,
            ordersLimit: config.maxDailyOrders,
            ordersLeft: Math.max(0, config.maxDailyOrders - ordersUsed),
            rubUsed,
            rubLimit: config.maxDailyRub,
            rubLeft: Math.max(0, config.maxDailyRub - rubUsed),
            cashRub,
            totalRub,
            budget: TradeBudgetService.buildAccountBudget(config, { totalRub, cashRub })
        });
    }

    return { limits };
};

const enrichBrokerQuote = async (accountId: string, preview: Awaited<ReturnType<typeof BuySignalEvaluatorService.evaluateAccount>>[number]) => {
    if (!preview.instrumentUid || !preview.currentPrice) return preview;

    try {
        const quantity = Math.max(1, Math.trunc(preview.quantityLots ?? 1));
        const price = numberToQuotation(preview.currentPrice);
        const [maxLots, orderPrice] = await Promise.all([
            OrdersService.getMaxLots(accountId, preview.instrumentUid, price),
            OrdersService.getOrderPrice(accountId, ORDER_SIDE.BUY, quantity, price, preview.instrumentUid)
        ]);

        return {
            ...preview,
            brokerQuote: {
                quantity,
                buyMaxLots: maxLots?.buyLimits?.buyMaxLots,
                buyMaxMarketLots: maxLots?.buyLimits?.buyMaxMarketLots,
                totalOrderAmount: quotationToNumber(orderPrice?.totalOrderAmount),
                initialOrderAmount: quotationToNumber(orderPrice?.initialOrderAmount),
                executedCommission: quotationToNumber(orderPrice?.executedCommission),
                executedCommissionRub: quotationToNumber(orderPrice?.executedCommissionRub)
            }
        };
    } catch (error) {
        return {
            ...preview,
            brokerQuoteError: error instanceof Error ? error.message : String(error)
        };
    }
};

const getPreviewCacheKey = (config: RobotConfig, brokerMode: string) => JSON.stringify({
    brokerMode,
    config: safeConfig(config)
});

const withPreviewCacheMeta = (
    payload: PreviewPayload,
    source: 'miss' | 'hit' | 'stale',
    createdAt: number,
    error?: unknown
) => ({
    ...payload,
    cache: {
        source,
        generatedAt: new Date(createdAt).toISOString(),
        ageMs: Math.max(0, Date.now() - createdAt),
        error: error instanceof Error ? error.message : error ? String(error) : undefined
    }
});

const refreshPreviewCache = (key: string, config: RobotConfig, brokerMode: string) => {
    const entry = previewPayloadCache.get(key) ?? { createdAt: 0 };
    if (entry.refreshing) return entry.refreshing;

    const refreshing = buildPreviewPayload(config, brokerMode)
        .then(payload => {
            previewPayloadCache.set(key, {
                payload,
                createdAt: Date.now()
            });
            void persistPreviewCacheToDisk();
            return payload;
        })
        .catch(error => {
            const current = previewPayloadCache.get(key);
            if (current) {
                previewPayloadCache.set(key, {
                    payload: current.payload,
                    createdAt: current.createdAt
                });
            }
            throw error;
        });

    previewPayloadCache.set(key, {
        ...entry,
        refreshing
    });

    return refreshing;
};

const buildPreviewPayload = async (config: RobotConfig, brokerMode: string): Promise<PreviewPayload> => {
    const previews = [];

    for (const accountId of config.accountIds) {
        const accountPreviews = await BuySignalEvaluatorService.evaluateAccount(accountId, config);
        const accountRows = await Promise.all(accountPreviews.map(preview => {
            const shouldQuote = brokerMode === 'all' || (brokerMode !== 'none' && preview.status === 'allowed');
            return shouldQuote ? enrichBrokerQuote(accountId, preview) : Promise.resolve(preview);
        }));
        previews.push(...accountRows);
    }

    return {
        mode: config.dryRun ? 'dry-run' : 'live',
        liveAllowedActions: config.liveAllowedActions,
        brokerQuoteMode: brokerMode,
        previews
    };
};

const getPreviewPayload = async (config: RobotConfig, url?: URL) => {
    await loadPreviewCacheFromDisk();

    const brokerMode = url?.searchParams.get('broker') ?? 'allowed';
    const forceRefresh = ['1', 'true', 'yes'].includes((url?.searchParams.get('refresh') ?? '').toLowerCase());
    const key = getPreviewCacheKey(config, brokerMode);
    const entry = previewPayloadCache.get(key);
    const now = Date.now();

    if (!forceRefresh && entry?.payload) {
        const ageMs = now - entry.createdAt;

        if (ageMs <= PREVIEW_CACHE_TTL_MS) {
            return withPreviewCacheMeta(entry.payload, 'hit', entry.createdAt);
        }

        if (ageMs <= PREVIEW_CACHE_MAX_STALE_MS) {
            void refreshPreviewCache(key, config, brokerMode).catch(error => {
                console.error('Preview cache refresh failed:', error);
            });
            return withPreviewCacheMeta(entry.payload, 'stale', entry.createdAt);
        }
    }

    try {
        const payload = await refreshPreviewCache(key, config, brokerMode);
        return withPreviewCacheMeta(payload, 'miss', Date.now());
    } catch (error) {
        if (entry?.payload) {
            return withPreviewCacheMeta(entry.payload, 'stale', entry.createdAt, error);
        }

        throw error;
    }
};

const warmPreviewCache = async () => {
    try {
        await loadPreviewCacheFromDisk();
        const config = await RuntimeConfigService.getEffectiveConfig(getRobotConfig());
        const brokerMode = 'allowed';
        const key = getPreviewCacheKey(config, brokerMode);
        await refreshPreviewCache(key, config, brokerMode);
        console.log('Preview cache warmed.');
    } catch (error) {
        console.error('Preview cache warmup failed:', error instanceof Error ? error.message : error);
    }
};

const handleGetSocialProfiles = async (req: IncomingMessage, res: ServerResponse) => {
    try {
        const profiles = await ProfileManagementService.listProfiles();
        
        // Calculate summary statistics
        const total = profiles.length;
        const active = profiles.filter(p => p.status !== 'disabled').length;
        const disabled = profiles.filter(p => p.status === 'disabled').length;
        const error = profiles.filter(p => p.status === 'error').length;
        
        json(res, 200, {
            ok: true,
            profiles: profiles.map(p => p.toJSON()),
            summary: {
                total,
                active,
                disabled,
                error
            }
        });
    } catch (error) {
        console.error('Get social profiles error:', error);
        json(res, 503, {
            ok: false,
            error: 'Database temporarily unavailable, please try again'
        });
    }
};

const handleCreateSocialProfile = async (req: IncomingMessage, res: ServerResponse) => {
    if (!String(req.headers['content-type'] ?? '').includes('application/json')) {
        json(res, 415, { ok: false, error: 'content-type must be application/json' });
        return;
    }

    try {
        const payload = await readJsonBody(req);
        
        // Validate required fields
        if (!payload.profileUrl || typeof payload.profileUrl !== 'string') {
            json(res, 400, {
                ok: false,
                error: 'Validation failed: Profile URL is required'
            });
            return;
        }

        // Create profile
        const profile = await ProfileManagementService.createProfile({
            profileUrl: payload.profileUrl,
            profileUid: payload.profileUid,
            displayName: payload.displayName,
            confidence: payload.confidence,
            activity: payload.activity,
            description: payload.description
        });

        json(res, 200, {
            ok: true,
            profile: profile.toJSON()
        });
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        
        // Handle duplicate profile error
        if (errorMessage.includes('already exists')) {
            json(res, 409, {
                ok: false,
                error: errorMessage
            });
            return;
        }
        
        // Handle validation errors
        if (errorMessage.includes('Validation failed')) {
            json(res, 400, {
                ok: false,
                error: errorMessage
            });
            return;
        }
        
        // Handle database errors
        console.error('Create social profile error:', error);
        json(res, 503, {
            ok: false,
            error: 'Database temporarily unavailable, please try again'
        });
    }
};

const handleUpdateSocialProfile = async (req: IncomingMessage, res: ServerResponse, profileKey: string) => {
    if (!String(req.headers['content-type'] ?? '').includes('application/json')) {
        json(res, 415, { ok: false, error: 'content-type must be application/json' });
        return;
    }

    try {
        const payload = await readJsonBody(req);
        
        // Update profile
        const profile = await ProfileManagementService.updateProfile(profileKey, {
            displayName: payload.displayName,
            confidence: payload.confidence,
            activity: payload.activity,
            description: payload.description,
            status: payload.status
        });

        json(res, 200, {
            ok: true,
            profile: profile.toJSON()
        });
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        
        // Handle not found error
        if (errorMessage.includes('not found')) {
            json(res, 404, {
                ok: false,
                error: errorMessage
            });
            return;
        }
        
        // Handle validation errors
        if (errorMessage.includes('Validation failed')) {
            json(res, 400, {
                ok: false,
                error: errorMessage
            });
            return;
        }
        
        // Handle database errors
        console.error('Update social profile error:', error);
        json(res, 503, {
            ok: false,
            error: 'Database temporarily unavailable, please try again'
        });
    }
};

const handleToggleSocialProfile = async (req: IncomingMessage, res: ServerResponse, profileKey: string) => {
    try {
        const result = await ProfileManagementService.toggleProfile(profileKey);

        json(res, 200, {
            ok: true,
            profile: result.profile.toJSON(),
            previousStatus: result.previousStatus,
            newStatus: result.newStatus
        });
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        
        // Handle not found error
        if (errorMessage.includes('not found')) {
            json(res, 404, {
                ok: false,
                error: errorMessage
            });
            return;
        }
        
        // Handle database errors
        console.error('Toggle social profile error:', error);
        json(res, 503, {
            ok: false,
            error: 'Database temporarily unavailable, please try again'
        });
    }
};

const handleDeleteSocialProfile = async (req: IncomingMessage, res: ServerResponse, profileKey: string) => {
    try {
        const deleted = await ProfileManagementService.deleteProfile(profileKey);

        json(res, 200, {
            ok: true,
            deleted
        });
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        
        // Handle not found error
        if (errorMessage.includes('not found')) {
            json(res, 404, {
                ok: false,
                error: errorMessage
            });
            return;
        }
        
        // Handle database errors
        console.error('Delete social profile error:', error);
        json(res, 503, {
            ok: false,
            error: 'Database temporarily unavailable, please try again'
        });
    }
};

const handleRequest = async (req: IncomingMessage, res: ServerResponse, startedAt: string) => {
    const url = new URL(req.url ?? '/', 'http://localhost');

    if (url.pathname === '/api/health') {
        json(res, 200, { ok: true, startedAt, uptimeSeconds: Math.round(process.uptime()) });
        return;
    }

    if (!requireAuth(req, res)) return;

    if (req.method === 'POST' && url.pathname === '/api/social-cookies') {
        await handleSocialCookieUpdate(req, res);
        return;
    }

    if (req.method === 'POST' && url.pathname === '/api/admin/account-mode') {
        await handleAccountModeUpdate(req, res);
        return;
    }

    if (req.method === 'POST' && url.pathname === '/api/admin/live-actions') {
        await handleLiveActionsUpdate(req, res);
        return;
    }

    if (req.method === 'POST' && url.pathname === '/api/admin/order-type') {
        await handleOrderTypeUpdate(req, res);
        return;
    }

    if (req.method === 'POST' && url.pathname === '/api/admin/market-regime') {
        await handleMarketRegimeUpdate(req, res);
        return;
    }

    if (req.method === 'POST' && url.pathname === '/api/admin/risk-settings') {
        await handleRiskSettingsUpdate(req, res);
        return;
    }

    if (req.method === 'POST' && url.pathname === '/api/admin/sell-settings') {
        await handleSellSettingsUpdate(req, res);
        return;
    }

    if (req.method === 'POST' && url.pathname === '/api/admin/cancel-stale-limit-orders') {
        await handleCancelStaleLimitOrders(req, res);
        return;
    }

    if (req.method === 'POST' && url.pathname === '/api/admin/protective-stops-resync') {
        await handleProtectiveStopResync(req, res);
        return;
    }

    // Social profile management endpoints
    if (url.pathname === '/api/social-profiles') {
        if (req.method === 'GET') {
            await handleGetSocialProfiles(req, res);
            return;
        }
        if (req.method === 'POST') {
            await handleCreateSocialProfile(req, res);
            return;
        }
    }

    // Social profile management endpoints with profileKey parameter
    const socialProfileMatch = url.pathname.match(/^\/api\/social-profiles\/([^/]+)(\/toggle)?$/);
    if (socialProfileMatch) {
        const profileKey = decodeURIComponent(socialProfileMatch[1]);
        const isToggle = socialProfileMatch[2] === '/toggle';

        if (isToggle && req.method === 'POST') {
            await handleToggleSocialProfile(req, res, profileKey);
            return;
        }

        if (!isToggle && req.method === 'PUT') {
            await handleUpdateSocialProfile(req, res, profileKey);
            return;
        }

        if (!isToggle && req.method === 'DELETE') {
            await handleDeleteSocialProfile(req, res, profileKey);
            return;
        }
    }

    if (req.method !== 'GET') {
        json(res, 405, { error: 'Read-only API supports GET requests only except explicit admin endpoints.' });
        return;
    }

    const config = await RuntimeConfigService.getEffectiveConfig(getRobotConfig());

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
            config: safeConfig(config),
            accountModes: await RuntimeConfigService.getAccountModes()
        });
        return;
    }

    if (url.pathname === '/api/config') {
        json(res, 200, { config: safeConfig(config), accountModes: await RuntimeConfigService.getAccountModes() });
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

    if (url.pathname === '/api/trade-pnl') {
        json(res, 200, await getTradePnlPayload(url, config));
        return;
    }

    if (url.pathname === '/api/accounting-audit') {
        json(res, 200, await AccountingAuditService.getLedgerBrokerAudit(config));
        return;
    }

    if (url.pathname === '/api/order-safety') {
        json(res, 200, await getOrderSafetyPayload(url, config));
        return;
    }

    if (url.pathname === '/api/protective-stops') {
        json(res, 200, await getProtectiveStopsPayload(config));
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
        json(res, 200, await getPreviewPayload(config, url));
        return;
    }

    if (url.pathname === '/api/daily-buy-list') {
        json(res, 200, await DailyBuyListService.build(config));
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

    if (url.pathname === '/api/tech-analysis') {
        const tickers = url.searchParams.get('tickers')
            ?.split(',')
            .map(ticker => ticker.trim().toUpperCase())
            .filter(Boolean);
        json(res, 200, await TechnicalAnalysisService.getSummary(config, tickers?.length ? tickers : config.buyTickers));
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

    if (url.pathname === '/api/market-lab') {
        const limit = Number(url.searchParams.get('limit') ?? 8);
        json(res, 200, await MarketRegimeLabService.compare(
            config,
            Number.isFinite(limit) ? limit : 8
        ));
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

    if (url.pathname === '/api/buy-lab') {
        const hours = Number(url.searchParams.get('hours') ?? 24);
        const limit = Number(url.searchParams.get('limit') ?? 30);
        json(res, 200, await BuyCandidateLabService.getSummary(
            Number.isFinite(hours) ? hours : 24,
            Number.isFinite(limit) ? limit : 30
        ));
        return;
    }

    if (url.pathname === '/api/buy-recommendations') {
        const limit = Number(url.searchParams.get('limit') ?? 30);
        json(res, 200, await BuyRecommendationService.getRecommendations(
            config,
            Number.isFinite(limit) ? limit : 30
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

    if (url.pathname === '/api/robot-positions') {
        json(res, 200, await RobotPositionLedgerService.getLedger(config));
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

    const authConfigError = getHttpAuthConfigError();
    if (authConfigError) {
        console.error(`Read-only HTTP server disabled: ${authConfigError}`);
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
        const authStatus = env.ROBOT_WEB_PASSWORD ? 'enabled' : 'disabled-local-dev';
        console.log(`Read-only HTTP server listening on ${port}. Auth: ${authStatus}.`);
        setTimeout(() => {
            void warmPreviewCache();
        }, 5_000);
    });

    return server;
};
