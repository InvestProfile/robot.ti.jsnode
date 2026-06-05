import { RobotConfig } from '../config/robot.config';
import InstrumentsService from './instruments.service';
import TradePnlService from './trade-pnl.service';

export interface LossGuardStats {
    type: 'ticker' | 'sector';
    key: string;
    closed: number;
    wins: number;
    losses: number;
    pnlRub: number;
    averagePnlRub?: number;
    winRatePercent?: number;
    stale?: boolean;
}

export interface LossGuardSnapshot {
    byTicker: Map<string, LossGuardStats>;
    bySector: Map<string, LossGuardStats>;
}

interface CacheEntry {
    createdAt: number;
    snapshot: LossGuardSnapshot;
}

const cache = new Map<string, CacheEntry>();

const normalizeTicker = (ticker?: unknown) => String(ticker || '').trim().toUpperCase();
const normalizeSector = (sector?: unknown) => String(sector || '').trim() || 'unknown';

const cacheKey = (config: RobotConfig) => [
    config.accountIds.join(','),
    config.buyLossGuardMinClosed,
    config.buyLossGuardMinLosses,
    config.buyLossGuardMinPnlRub,
    config.buyLossGuardMinWinRatePercent
].join('|');

const createGroup = (type: 'ticker' | 'sector', key: string): LossGuardStats => ({
    type,
    key,
    closed: 0,
    wins: 0,
    losses: 0,
    pnlRub: 0
});

const addPnl = (groups: Map<string, LossGuardStats>, type: 'ticker' | 'sector', key: string, pnlRub: number) => {
    if (!key) return;

    const group = groups.get(key) ?? createGroup(type, key);
    group.closed += 1;
    group.pnlRub += pnlRub;
    if (pnlRub > 0) group.wins += 1;
    if (pnlRub < 0) group.losses += 1;
    groups.set(key, group);
};

const finalizeGroups = (groups: Map<string, LossGuardStats>) => {
    for (const group of groups.values()) {
        group.averagePnlRub = group.closed > 0 ? group.pnlRub / group.closed : undefined;
        group.winRatePercent = group.closed > 0 ? group.wins / group.closed * 100 : undefined;
    }
};

const staleSnapshot = (snapshot: LossGuardSnapshot): LossGuardSnapshot => ({
    byTicker: new Map([...snapshot.byTicker.entries()].map(([key, value]) => [key, { ...value, stale: true }])),
    bySector: new Map([...snapshot.bySector.entries()].map(([key, value]) => [key, { ...value, stale: true }]))
});

export default class LossGuardService {
    static async getSnapshot(config: RobotConfig): Promise<LossGuardSnapshot> {
        const key = cacheKey(config);
        const ttlMs = Number(config.buyLossGuardCacheTtlMs ?? 0);
        const cached = cache.get(key);

        if (cached && (ttlMs <= 0 || Date.now() - cached.createdAt <= ttlMs)) {
            return cached.snapshot;
        }

        try {
            const [report, shares] = await Promise.all([
                TradePnlService.getRoundTripPnl(config, 1_000, { includeCommissions: false }),
                InstrumentsService.getShares()
            ]);
            const instruments = shares?.instruments ?? [];
            const byUid = new Map(instruments.map(instrument => [String(instrument.uid || ''), instrument]));
            const byFigi = new Map(instruments.map(instrument => [String(instrument.figi || ''), instrument]));
            const byTicker = new Map(instruments.map(instrument => [normalizeTicker(instrument.ticker), instrument]));
            const tickerGroups = new Map<string, LossGuardStats>();
            const sectorGroups = new Map<string, LossGuardStats>();

            for (const row of report.closedRoundTrips ?? []) {
                const data = row as Record<string, unknown>;
                const pnlRub = Number(data.netPnlRub ?? data.pnlRub);
                if (!Number.isFinite(pnlRub)) continue;

                const ticker = normalizeTicker(data.ticker);
                const instrument = byUid.get(String(data.instrumentId || ''))
                    ?? byUid.get(String(data.instrumentUid || ''))
                    ?? byFigi.get(String(data.figi || ''))
                    ?? byTicker.get(ticker);
                const sector = normalizeSector(instrument?.sector);

                addPnl(tickerGroups, 'ticker', ticker, pnlRub);
                addPnl(sectorGroups, 'sector', sector, pnlRub);
            }

            finalizeGroups(tickerGroups);
            finalizeGroups(sectorGroups);

            const snapshot = {
                byTicker: tickerGroups,
                bySector: sectorGroups
            };
            cache.set(key, { createdAt: Date.now(), snapshot });
            return snapshot;
        } catch (error) {
            if (cached) return staleSnapshot(cached.snapshot);

            console.warn('Loss guard snapshot unavailable:', error instanceof Error ? error.message : String(error));
            return {
                byTicker: new Map(),
                bySector: new Map()
            };
        }
    }
}
