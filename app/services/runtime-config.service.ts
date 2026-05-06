import { getRobotConfig, RobotConfig } from '../config/robot.config';
import RuntimeAccountModeModel, { RuntimeAccountMode } from '../models/runtime-account-mode.model';
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

const isProtectedTradeEnabled = (reason: string | undefined | null) =>
    String(reason ?? '').startsWith(PROTECTED_TRADE_REASON);

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
        const accountIds = modes
            .filter(account => account.effectiveMode === 'trade' && (!account.protected || account.protectedTradeEnabled))
            .map(account => account.accountId);
        const observeAccountIds = modes
            .filter(account => account.effectiveMode === 'observe' || (account.protected && !account.protectedTradeEnabled))
            .map(account => account.accountId);

        return {
            ...baseConfig,
            accountIds,
            observeAccountIds
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
