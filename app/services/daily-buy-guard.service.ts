import { RobotConfig } from '../config/robot.config';
import TradePnlService from './trade-pnl.service';

type ClosedRoundTrip = {
    accountId?: unknown;
    exitAt?: unknown;
    exitSignalSource?: unknown;
    netPnlRub?: unknown;
    pnlRub?: unknown;
};

export interface DailyBuyGuardSnapshot {
    date: string;
    stopExits: number;
    realizedNetPnlRub: number;
    maxStopExits: number;
    maxNetLossRub: number;
    blockedByStopCascade: boolean;
    blockedByDailyLoss: boolean;
    blocked: boolean;
    reason: string;
}

type CacheEntry = { expiresAt: number; snapshot: DailyBuyGuardSnapshot };
const cache = new Map<string, CacheEntry>();

export const moscowTradingDate = (value: Date | string | number) => {
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime())) return '';
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Europe/Moscow',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    }).formatToParts(date);
    const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
    return `${values.year}-${values.month}-${values.day}`;
};

export const summarizeDailyBuyGuard = (input: {
    accountId: string;
    roundTrips: ClosedRoundTrip[];
    now?: Date;
    maxStopExits: number;
    maxNetLossRub: number;
}): DailyBuyGuardSnapshot => {
    const date = moscowTradingDate(input.now ?? new Date());
    const today = input.roundTrips.filter(row =>
        String(row.accountId ?? '') === input.accountId
        && moscowTradingDate(String(row.exitAt ?? '')) === date
    );
    const stopExits = today.filter(row => {
        const source = String(row.exitSignalSource ?? '').toLowerCase();
        return source === 'stop-loss' || source === 'broker-stop-loss';
    }).length;
    const realizedNetPnlRub = today.reduce((sum, row) => {
        const value = Number(row.netPnlRub ?? row.pnlRub ?? 0);
        return sum + (Number.isFinite(value) ? value : 0);
    }, 0);
    const blockedByStopCascade = stopExits >= input.maxStopExits;
    const blockedByDailyLoss = realizedNetPnlRub <= -input.maxNetLossRub;
    const reasons: string[] = [];
    if (blockedByStopCascade) reasons.push(`stop exits ${stopExits}/${input.maxStopExits}`);
    if (blockedByDailyLoss) reasons.push(`daily net P/L ${realizedNetPnlRub.toFixed(2)} RUB <= -${input.maxNetLossRub.toFixed(2)} RUB`);
    return {
        date,
        stopExits,
        realizedNetPnlRub,
        maxStopExits: input.maxStopExits,
        maxNetLossRub: input.maxNetLossRub,
        blockedByStopCascade,
        blockedByDailyLoss,
        blocked: blockedByStopCascade || blockedByDailyLoss,
        reason: reasons.length
            ? `daily buy guard blocked: ${reasons.join('; ')}`
            : `daily buy guard passed: stop exits ${stopExits}/${input.maxStopExits}, net P/L ${realizedNetPnlRub.toFixed(2)} RUB`
    };
};

export default class DailyBuyGuardService {
    static async getSnapshot(config: RobotConfig, accountId: string, now = new Date()) {
        if (!config.buyDailyGuardEnabled) return undefined;
        const date = moscowTradingDate(now);
        const key = `${accountId}:${date}`;
        const cached = cache.get(key);
        if (cached && cached.expiresAt > Date.now()) return cached.snapshot;
        const pnl = await TradePnlService.getRoundTripPnl(config, 500);
        const snapshot = summarizeDailyBuyGuard({
            accountId,
            roundTrips: pnl.closedRoundTrips,
            now,
            maxStopExits: config.buyDailyGuardMaxStopExits,
            maxNetLossRub: config.buyDailyGuardMaxNetLossRub
        });
        cache.set(key, { expiresAt: Date.now() + config.buyDailyGuardCacheTtlMs, snapshot });
        return snapshot;
    }

    static clearCache() {
        cache.clear();
    }
}
