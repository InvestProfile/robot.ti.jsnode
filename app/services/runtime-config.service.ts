import { getRobotConfig, LiveAction, RobotConfig, RobotOrderType } from '../config/robot.config';
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
const BUY_ORDER_TYPE_KEY = 'buyOrderType';
const SELL_ORDER_TYPE_KEY = 'sellOrderType';
const MARKET_HEALTH_KEY = 'marketRegimeMinHealthPercent';
const MARKET_AVG_TREND_KEY = 'marketRegimeMinAvgTrendPercent';
const MAX_ORDER_RUB_KEY = 'maxOrderRub';
const MAX_DAILY_ORDERS_KEY = 'maxDailyOrders';
const MAX_DAILY_RUB_KEY = 'maxDailyRub';
const MAX_POSITION_SHARE_KEY = 'maxPositionSharePercent';
const MIN_DIVERSIFICATION_POSITIONS_KEY = 'minDiversificationPositions';
const DIVERSIFICATION_FIRST_KEY = 'diversificationFirst';
const STOP_LOSS_PERCENT_KEY = 'stopLossPercent';
const TRAILING_STOP_PERCENT_KEY = 'trailingStopPercent';
const TRAILING_STOP_MIN_PROFIT_PERCENT_KEY = 'trailingStopMinProfitPercent';
const SELL_HOLD_WINNER_MIN_PROFIT_PERCENT_KEY = 'sellHoldWinnerMinProfitPercent';
const SELL_HOLD_WINNER_MAX_DRAWDOWN_PERCENT_KEY = 'sellHoldWinnerMaxDrawdownPercent';
const ALLOWED_LIVE_ACTIONS = new Set<LiveAction>(['buy', 'sell']);
const ALLOWED_ORDER_TYPES = new Set<RobotOrderType>(['market', 'limit']);

const isProtectedTradeEnabled = (reason: string | undefined | null) =>
    String(reason ?? '').startsWith(PROTECTED_TRADE_REASON);

const normalizeLiveActions = (actions: string[] | undefined, fallback: LiveAction[]): LiveAction[] => {
    const normalized = (actions ?? [])
        .map(action => action.trim())
        .filter((action): action is LiveAction => ALLOWED_LIVE_ACTIONS.has(action as LiveAction));

    return normalized.length > 0 ? [...new Set(normalized)] : fallback;
};

const normalizeOrderTypeSetting = (value: string | undefined | null, fallback: RobotOrderType): RobotOrderType => {
    const normalized = String(value ?? '').trim().toLowerCase();
    return ALLOWED_ORDER_TYPES.has(normalized as RobotOrderType) ? normalized as RobotOrderType : fallback;
};

const capRuntimeNumber = (value: unknown, fallback: number, absoluteMax: number, options: { integer?: boolean } = {}) => {
    const parsed = Number(value);
    const normalized = Number.isFinite(parsed) ? Math.max(0, parsed) : fallback;
    const ceiling = Math.max(0, absoluteMax);
    const capped = ceiling <= 0 ? 0 : Math.min(normalized, ceiling);

    return options.integer ? Math.trunc(capped) : capped;
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
        const orderTypes = await this.getOrderTypeSettings(baseConfig);
        const marketRegime = await this.getMarketRegimeSettings(baseConfig);
        const riskSettings = await this.getRiskSettings(baseConfig);
        const sellSettings = await this.getSellSettings(baseConfig);
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
            ...orderTypes,
            ...marketRegime,
            ...riskSettings,
            ...sellSettings
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

    static async getOrderTypeSettings(baseConfig: RobotConfig = getRobotConfig()) {
        const rows = await RuntimeSettingModel.findAll({
            where: {
                key: {
                    [Op.in]: [BUY_ORDER_TYPE_KEY, SELL_ORDER_TYPE_KEY]
                }
            } as any
        });
        const byKey = new Map(rows.map(row => [row.key, row.value]));
        const buyOrderType = normalizeOrderTypeSetting(byKey.get(BUY_ORDER_TYPE_KEY), baseConfig.buyOrderType);
        const sellOrderType = normalizeOrderTypeSetting(byKey.get(SELL_ORDER_TYPE_KEY), baseConfig.sellOrderType);

        return {
            orderType: buyOrderType === sellOrderType ? buyOrderType : baseConfig.orderType,
            buyOrderType,
            sellOrderType
        };
    }

    static async setOrderTypeSettings(input: {
        buyOrderType?: string;
        sellOrderType?: string;
    }, updatedBy = 'web') {
        const baseConfig = getRobotConfig();
        const buyOrderType = normalizeOrderTypeSetting(input.buyOrderType, baseConfig.buyOrderType);
        const sellOrderType = normalizeOrderTypeSetting(input.sellOrderType, baseConfig.sellOrderType);

        await RuntimeSettingModel.upsert({
            key: BUY_ORDER_TYPE_KEY,
            value: buyOrderType,
            updatedBy
        });
        await RuntimeSettingModel.upsert({
            key: SELL_ORDER_TYPE_KEY,
            value: sellOrderType,
            updatedBy
        });

        return {
            orderType: buyOrderType === sellOrderType ? buyOrderType : baseConfig.orderType,
            buyOrderType,
            sellOrderType
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
                    [Op.in]: [
                        MAX_ORDER_RUB_KEY,
                        MAX_DAILY_ORDERS_KEY,
                        MAX_DAILY_RUB_KEY,
                        MAX_POSITION_SHARE_KEY,
                        MIN_DIVERSIFICATION_POSITIONS_KEY,
                        DIVERSIFICATION_FIRST_KEY
                    ]
                }
            } as any
        });
        const byKey = new Map(rows.map(row => [row.key, row.value]));
        const maxOrderRub = byKey.get(MAX_ORDER_RUB_KEY);
        const maxDailyOrders = byKey.get(MAX_DAILY_ORDERS_KEY);
        const maxDailyRub = byKey.get(MAX_DAILY_RUB_KEY);
        const maxPositionSharePercent = byKey.get(MAX_POSITION_SHARE_KEY);
        const minDiversificationPositions = byKey.get(MIN_DIVERSIFICATION_POSITIONS_KEY);
        const diversificationFirst = byKey.get(DIVERSIFICATION_FIRST_KEY);

        return {
            maxOrderRub: capRuntimeNumber(maxOrderRub, baseConfig.maxOrderRub, baseConfig.maxRuntimeOrderRub),
            maxDailyOrders: capRuntimeNumber(maxDailyOrders, baseConfig.maxDailyOrders, baseConfig.maxRuntimeDailyOrders, { integer: true }),
            maxDailyRub: capRuntimeNumber(maxDailyRub, baseConfig.maxDailyRub, baseConfig.maxRuntimeDailyRub),
            maxPositionSharePercent: capRuntimeNumber(maxPositionSharePercent, baseConfig.maxPositionSharePercent, 100),
            minDiversificationPositions: capRuntimeNumber(minDiversificationPositions, baseConfig.minDiversificationPositions, 100, { integer: true }),
            diversificationFirst: diversificationFirst === undefined
                ? baseConfig.diversificationFirst
                : ['1', 'true', 'yes', 'on'].includes(String(diversificationFirst).trim().toLowerCase())
        };
    }

    static async setRiskSettings(input: {
        maxOrderRub?: number;
        maxDailyOrders?: number;
        maxDailyRub?: number;
        maxPositionSharePercent?: number;
        minDiversificationPositions?: number;
        diversificationFirst?: boolean;
    }, updatedBy = 'web') {
        const baseConfig = getRobotConfig();
        const maxOrderRub = capRuntimeNumber(input.maxOrderRub, baseConfig.maxOrderRub, baseConfig.maxRuntimeOrderRub);
        const maxDailyOrders = capRuntimeNumber(input.maxDailyOrders, baseConfig.maxDailyOrders, baseConfig.maxRuntimeDailyOrders, { integer: true });
        const maxDailyRub = capRuntimeNumber(input.maxDailyRub, baseConfig.maxDailyRub, baseConfig.maxRuntimeDailyRub);
        const maxPositionSharePercent = capRuntimeNumber(input.maxPositionSharePercent, baseConfig.maxPositionSharePercent, 100);
        const minDiversificationPositions = capRuntimeNumber(input.minDiversificationPositions, baseConfig.minDiversificationPositions, 100, { integer: true });
        const diversificationFirst = typeof input.diversificationFirst === 'boolean'
            ? input.diversificationFirst
            : baseConfig.diversificationFirst;

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
        await RuntimeSettingModel.upsert({
            key: MAX_POSITION_SHARE_KEY,
            value: String(maxPositionSharePercent),
            updatedBy
        });
        await RuntimeSettingModel.upsert({
            key: MIN_DIVERSIFICATION_POSITIONS_KEY,
            value: String(minDiversificationPositions),
            updatedBy
        });
        await RuntimeSettingModel.upsert({
            key: DIVERSIFICATION_FIRST_KEY,
            value: String(diversificationFirst),
            updatedBy
        });

        return {
            maxOrderRub,
            maxDailyOrders,
            maxDailyRub,
            maxPositionSharePercent,
            minDiversificationPositions,
            diversificationFirst
        };
    }

    static async getSellSettings(baseConfig: RobotConfig = getRobotConfig()) {
        const rows = await RuntimeSettingModel.findAll({
            where: {
                key: {
                    [Op.in]: [
                        STOP_LOSS_PERCENT_KEY,
                        TRAILING_STOP_PERCENT_KEY,
                        TRAILING_STOP_MIN_PROFIT_PERCENT_KEY,
                        SELL_HOLD_WINNER_MIN_PROFIT_PERCENT_KEY,
                        SELL_HOLD_WINNER_MAX_DRAWDOWN_PERCENT_KEY
                    ]
                }
            } as any
        });
        const byKey = new Map(rows.map(row => [row.key, row.value]));

        return {
            stopLossPercent: capRuntimeNumber(byKey.get(STOP_LOSS_PERCENT_KEY), baseConfig.stopLossPercent, 20),
            trailingStopPercent: capRuntimeNumber(byKey.get(TRAILING_STOP_PERCENT_KEY), baseConfig.trailingStopPercent, 20),
            trailingStopMinProfitPercent: capRuntimeNumber(
                byKey.get(TRAILING_STOP_MIN_PROFIT_PERCENT_KEY),
                baseConfig.trailingStopMinProfitPercent,
                20
            ),
            sellHoldWinnerMinProfitPercent: capRuntimeNumber(
                byKey.get(SELL_HOLD_WINNER_MIN_PROFIT_PERCENT_KEY),
                baseConfig.sellHoldWinnerMinProfitPercent,
                50
            ),
            sellHoldWinnerMaxDrawdownPercent: capRuntimeNumber(
                byKey.get(SELL_HOLD_WINNER_MAX_DRAWDOWN_PERCENT_KEY),
                baseConfig.sellHoldWinnerMaxDrawdownPercent,
                20
            )
        };
    }

    static async setSellSettings(input: {
        stopLossPercent?: number;
        trailingStopPercent?: number;
        trailingStopMinProfitPercent?: number;
        sellHoldWinnerMinProfitPercent?: number;
        sellHoldWinnerMaxDrawdownPercent?: number;
    }, updatedBy = 'web') {
        const baseConfig = getRobotConfig();
        const settings = {
            stopLossPercent: capRuntimeNumber(input.stopLossPercent, baseConfig.stopLossPercent, 20),
            trailingStopPercent: capRuntimeNumber(input.trailingStopPercent, baseConfig.trailingStopPercent, 20),
            trailingStopMinProfitPercent: capRuntimeNumber(
                input.trailingStopMinProfitPercent,
                baseConfig.trailingStopMinProfitPercent,
                20
            ),
            sellHoldWinnerMinProfitPercent: capRuntimeNumber(
                input.sellHoldWinnerMinProfitPercent,
                baseConfig.sellHoldWinnerMinProfitPercent,
                50
            ),
            sellHoldWinnerMaxDrawdownPercent: capRuntimeNumber(
                input.sellHoldWinnerMaxDrawdownPercent,
                baseConfig.sellHoldWinnerMaxDrawdownPercent,
                20
            )
        };

        await RuntimeSettingModel.upsert({ key: STOP_LOSS_PERCENT_KEY, value: String(settings.stopLossPercent), updatedBy });
        await RuntimeSettingModel.upsert({ key: TRAILING_STOP_PERCENT_KEY, value: String(settings.trailingStopPercent), updatedBy });
        await RuntimeSettingModel.upsert({
            key: TRAILING_STOP_MIN_PROFIT_PERCENT_KEY,
            value: String(settings.trailingStopMinProfitPercent),
            updatedBy
        });
        await RuntimeSettingModel.upsert({
            key: SELL_HOLD_WINNER_MIN_PROFIT_PERCENT_KEY,
            value: String(settings.sellHoldWinnerMinProfitPercent),
            updatedBy
        });
        await RuntimeSettingModel.upsert({
            key: SELL_HOLD_WINNER_MAX_DRAWDOWN_PERCENT_KEY,
            value: String(settings.sellHoldWinnerMaxDrawdownPercent),
            updatedBy
        });

        return settings;
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
