import { getRobotConfig, LiveAction, RobotConfig } from '../config/robot.config';
import RuntimeAccountModeModel, { RuntimeAccountMode } from '../models/runtime-account-mode.model';
import RuntimeSettingModel from '../models/runtime-setting.model';
import { Op } from 'sequelize';

type AccountMode = RuntimeAccountMode;

export interface AccountModeView {
    accountId: string;
    alias?: string;
    baseMode: AccountMode;
    overrideMode?: AccountMode;
    effectiveMode: AccountMode;
    protected: boolean;
    protectedTradeEnabled: boolean;
    updatedAt?: Date;
    updatedBy?: string;
}

const unique = (items: string[]) => [...new Set(items.filter(Boolean))];

const getKnownAccountIds = (config: RobotConfig) => unique([
    ...config.accountIds,
    ...config.observeAccountIds
]);

const getBaseMode = (config: RobotConfig, accountId: string): AccountMode =>
    config.accountIds.includes(accountId) ? 'trade' : 'observe';

const normalizeMode = (mode: string | undefined): AccountMode | undefined => {
    if (mode === 'trade' || mode === 'observe') return mode;
    return undefined;
};

const PROTECTED_TRADE_REASON = 'protected-trade-confirmed';
const LIVE_ALLOWED_ACTIONS_KEY = 'liveAllowedActions';
const MARKET_HEALTH_KEY = 'marketRegimeMinHealthPercent';
const MARKET_AVG_TREND_KEY = 'marketRegimeMinAvgTrendPercent';
const MAX_ORDER_RUB_KEY = 'maxOrderRub';
const MAX_DAILY_ORDERS_KEY = 'maxDailyOrders';
const MAX_DAILY_RUB_KEY = 'maxDailyRub';
const ALLOWED_LIVE_ACTIONS = new Set<LiveAction>(['buy', 'sell']);

const isProtectedTradeEnabled = (reason: string | undefined | null) =>
    String(reason ?? '').startsWith(PROTECTED_TRADE_REASON);

const normalizeLiveActions = (actions: string[] | undefined, fallback: LiveAction[]): LiveAction[] => {
    const normalized = (actions ?? [])
        .map(action => action.trim())
        .filter((action): action is LiveAction => ALLOWED_LIVE_ACTIONS.has(action as LiveAction));

    return normalized.length > 0 ? [...new Set(normalized)] : fallback;
};

export default class RuntimeConfigService {
    static async getAccountModes(baseConfig: RobotConfig = getRobotConfig()): Promise<AccountModeView[]> {
        const knownAccountIds = getKnownAccountIds(baseConfig);
        const protectedAccountIds = new Set(baseConfig.protectedAccountIds);
        const overrides = await RuntimeAccountModeModel.findAll({
            where: { accountId: { [Op.in]: knownAccountIds } } as any
        });
        const overrideByAccount = new Map(overrides.map(row => [row.accountId, row]));

        return knownAccountIds.map(accountId => {
            const override = overrideByAccount.get(accountId);
            const overrideMode = normalizeMode(override?.mode);
            const protectedAccount = protectedAccountIds.has(accountId);
            const protectedTradeEnabled = protectedAccount
                && overrideMode === 'trade'
                && isProtectedTradeEnabled(override?.reason);
            const effectiveMode = protectedAccount && overrideMode === 'trade' && !protectedTradeEnabled
                ? 'observe'
                : overrideMode ?? getBaseMode(baseConfig, accountId);

            return {
                accountId,
                alias: baseConfig.accountAliases[accountId],
                baseMode: getBaseMode(baseConfig, accountId),
                overrideMode,
                effectiveMode,
                protected: protectedAccount,
                protectedTradeEnabled,
                updatedAt: override?.updatedAt,
                updatedBy: override?.updatedBy
            };
        });
    }

    static async getEffectiveConfig(baseConfig: RobotConfig = getRobotConfig()): Promise<RobotConfig> {
        const modes = await this.getAccountModes(baseConfig);
        const liveAllowedActions = await this.getLiveAllowedActions(baseConfig.liveAllowedActions);
        const marketRegime = await this.getMarketRegimeSettings(baseConfig);
        const riskSettings = await this.getRiskSettings(baseConfig);
        const accountIds = modes
            .filter(account => account.effectiveMode === 'trade' && (!account.protected || account.protectedTradeEnabled))
            .map(account => account.accountId);
        const observeAccountIds = modes
            .filter(account => account.effectiveMode === 'observe' || (account.protected && !account.protectedTradeEnabled))
            .map(account => account.accountId);

        return {
            ...baseConfig,
            accountIds,
            observeAccountIds,
            liveAllowedActions,
            ...marketRegime,
            ...riskSettings
        };
    }

    static async getLiveAllowedActions(fallback: LiveAction[] = getRobotConfig().liveAllowedActions): Promise<LiveAction[]> {
        const row = await RuntimeSettingModel.findOne({ where: { key: LIVE_ALLOWED_ACTIONS_KEY } });
        if (!row?.value) return fallback;
        return normalizeLiveActions(row.value.split(','), fallback);
    }

    static async setLiveAllowedActions(actions: string[], updatedBy = 'web') {
        const baseConfig = getRobotConfig();
        const liveAllowedActions = normalizeLiveActions(actions, baseConfig.liveAllowedActions);

        await RuntimeSettingModel.upsert({
            key: LIVE_ALLOWED_ACTIONS_KEY,
            value: liveAllowedActions.join(','),
            updatedBy
        });

        return {
            liveAllowedActions
        };
    }

    static async getMarketRegimeSettings(baseConfig: RobotConfig = getRobotConfig()) {
        const rows = await RuntimeSettingModel.findAll({
            where: {
                key: {
                    [Op.in]: [MARKET_HEALTH_KEY, MARKET_AVG_TREND_KEY]
                }
            } as any
        });
        const byKey = new Map(rows.map(row => [row.key, Number(row.value)]));
        const health = byKey.get(MARKET_HEALTH_KEY);
        const avgTrend = byKey.get(MARKET_AVG_TREND_KEY);

        return {
            marketRegimeMinHealthPercent: Number.isFinite(health)
                ? Math.max(0, Math.min(100, health as number))
                : baseConfig.marketRegimeMinHealthPercent,
            marketRegimeMinAvgTrendPercent: Number.isFinite(avgTrend)
                ? avgTrend as number
                : baseConfig.marketRegimeMinAvgTrendPercent
        };
    }

    static async setMarketRegimeSettings(input: {
        minHealthPercent?: number;
        minAvgTrendPercent?: number;
    }, updatedBy = 'web') {
        const baseConfig = getRobotConfig();
        const minHealthPercent = Number.isFinite(input.minHealthPercent)
            ? Math.max(0, Math.min(100, Number(input.minHealthPercent)))
            : baseConfig.marketRegimeMinHealthPercent;
        const minAvgTrendPercent = Number.isFinite(input.minAvgTrendPercent)
            ? Number(input.minAvgTrendPercent)
            : baseConfig.marketRegimeMinAvgTrendPercent;

        await RuntimeSettingModel.upsert({
            key: MARKET_HEALTH_KEY,
            value: String(minHealthPercent),
            updatedBy
        });
        await RuntimeSettingModel.upsert({
            key: MARKET_AVG_TREND_KEY,
            value: String(minAvgTrendPercent),
            updatedBy
        });

        return {
            marketRegimeMinHealthPercent: minHealthPercent,
            marketRegimeMinAvgTrendPercent: minAvgTrendPercent
        };
    }

    static async getRiskSettings(baseConfig: RobotConfig = getRobotConfig()) {
        const rows = await RuntimeSettingModel.findAll({
            where: {
                key: {
                    [Op.in]: [MAX_ORDER_RUB_KEY, MAX_DAILY_ORDERS_KEY, MAX_DAILY_RUB_KEY]
                }
            } as any
        });
        const byKey = new Map(rows.map(row => [row.key, Number(row.value)]));
        const maxOrderRub = byKey.get(MAX_ORDER_RUB_KEY);
        const maxDailyOrders = byKey.get(MAX_DAILY_ORDERS_KEY);
        const maxDailyRub = byKey.get(MAX_DAILY_RUB_KEY);

        return {
            maxOrderRub: Number.isFinite(maxOrderRub)
                ? Math.max(0, maxOrderRub as number)
                : baseConfig.maxOrderRub,
            maxDailyOrders: Number.isFinite(maxDailyOrders)
                ? Math.max(0, Math.trunc(maxDailyOrders as number))
                : baseConfig.maxDailyOrders,
            maxDailyRub: Number.isFinite(maxDailyRub)
                ? Math.max(0, maxDailyRub as number)
                : baseConfig.maxDailyRub
        };
    }

    static async setRiskSettings(input: {
        maxOrderRub?: number;
        maxDailyOrders?: number;
        maxDailyRub?: number;
    }, updatedBy = 'web') {
        const baseConfig = getRobotConfig();
        const maxOrderRub = Number.isFinite(input.maxOrderRub)
            ? Math.max(0, Number(input.maxOrderRub))
            : baseConfig.maxOrderRub;
        const maxDailyOrders = Number.isFinite(input.maxDailyOrders)
            ? Math.max(0, Math.trunc(Number(input.maxDailyOrders)))
            : baseConfig.maxDailyOrders;
        const maxDailyRub = Number.isFinite(input.maxDailyRub)
            ? Math.max(0, Number(input.maxDailyRub))
            : baseConfig.maxDailyRub;

        await RuntimeSettingModel.upsert({
            key: MAX_ORDER_RUB_KEY,
            value: String(maxOrderRub),
            updatedBy
        });
        await RuntimeSettingModel.upsert({
            key: MAX_DAILY_ORDERS_KEY,
            value: String(maxDailyOrders),
            updatedBy
        });
        await RuntimeSettingModel.upsert({
            key: MAX_DAILY_RUB_KEY,
            value: String(maxDailyRub),
            updatedBy
        });

        return {
            maxOrderRub,
            maxDailyOrders,
            maxDailyRub
        };
    }

    static async setAccountMode(
        accountId: string,
        mode: AccountMode,
        updatedBy = 'web',
        reason?: string,
        allowProtectedTrade = false
    ) {
        const baseConfig = getRobotConfig();
        const knownAccountIds = getKnownAccountIds(baseConfig);

        if (!knownAccountIds.includes(accountId)) {
            throw new Error('account is not configured for this robot');
        }

        if (!normalizeMode(mode)) {
            throw new Error('unsupported account mode');
        }

        if (mode === 'trade' && baseConfig.protectedAccountIds.includes(accountId) && !allowProtectedTrade) {
            throw new Error('protected account needs explicit protected-trade confirmation');
        }

        const effectiveReason = mode === 'trade' && baseConfig.protectedAccountIds.includes(accountId)
            ? `${PROTECTED_TRADE_REASON}:${reason || updatedBy}`
            : reason;

        if (mode === getBaseMode(baseConfig, accountId)) {
            await RuntimeAccountModeModel.destroy({ where: { accountId } });
        } else {
            await RuntimeAccountModeModel.upsert({
                accountId,
                mode,
                updatedBy,
                reason: effectiveReason
            });
        }

        return {
            accountId,
            mode,
            accounts: await this.getAccountModes(baseConfig)
        };
    }
}
