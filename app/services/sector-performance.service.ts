import { RobotConfig } from '../config/robot.config';
import InstrumentsService from './instruments.service';
import TradePnlService from './trade-pnl.service';

export interface SectorPerformance {
    sector: string;
    closed: number;
    wins: number;
    losses: number;
    pnlRub: number;
    averagePnlRub?: number;
    winRatePercent?: number;
    stale?: boolean;
}

interface CacheEntry {
    createdAt: number;
    items: Map<string, SectorPerformance>;
}

const cache = new Map<string, CacheEntry>();

const normalizeSector = (sector?: string) => sector?.trim() || 'unknown';

const cacheKey = (config: RobotConfig) => [
    config.accountIds.join(','),
    config.sectorPerformanceMinClosed,
    config.sectorPerformanceMinWinRatePercent,
    config.sectorPerformanceMinPnlRub
].join('|');

export default class SectorPerformanceService {
    static async getSectorPerformance(config: RobotConfig): Promise<Map<string, SectorPerformance>> {
        const key = cacheKey(config);
        const ttlMs = Number(config.sectorPerformanceCacheTtlMs ?? 0);
        const cached = cache.get(key);

        if (cached && (ttlMs <= 0 || Date.now() - cached.createdAt <= ttlMs)) {
            return cached.items;
        }

        try {
            const [report, shares] = await Promise.all([
                TradePnlService.getRoundTripPnl(config, 1_000, { includeCommissions: false }),
                InstrumentsService.getShares()
            ]);
            const instruments = shares?.instruments ?? [];
            const byUid = new Map(instruments.map(instrument => [String(instrument.uid || ''), instrument]));
            const byFigi = new Map(instruments.map(instrument => [String(instrument.figi || ''), instrument]));
            const byTicker = new Map(instruments.map(instrument => [String(instrument.ticker || '').toUpperCase(), instrument]));
            const groups = new Map<string, SectorPerformance>();

            for (const row of report.closedRoundTrips ?? []) {
                const data = row as Record<string, unknown>;
                const instrument = byUid.get(String(data.instrumentId || ''))
                    ?? byUid.get(String(data.instrumentUid || ''))
                    ?? byFigi.get(String(data.figi || ''))
                    ?? byTicker.get(String(data.ticker || '').toUpperCase());
                const sector = normalizeSector(instrument?.sector);
                const pnlRub = Number(data.netPnlRub ?? data.pnlRub);
                if (!Number.isFinite(pnlRub)) continue;

                const group = groups.get(sector) ?? {
                    sector,
                    closed: 0,
                    wins: 0,
                    losses: 0,
                    pnlRub: 0
                };
                group.closed += 1;
                group.pnlRub += pnlRub;
                if (pnlRub > 0) group.wins += 1;
                if (pnlRub < 0) group.losses += 1;
                groups.set(sector, group);
            }

            for (const group of groups.values()) {
                group.averagePnlRub = group.closed > 0 ? group.pnlRub / group.closed : undefined;
                group.winRatePercent = group.closed > 0 ? group.wins / group.closed * 100 : undefined;
            }

            cache.set(key, { createdAt: Date.now(), items: groups });
            return groups;
        } catch (error) {
            if (cached) {
                const stale = new Map<string, SectorPerformance>();
                for (const [sector, item] of cached.items.entries()) {
                    stale.set(sector, { ...item, stale: true });
                }
                return stale;
            }

            console.warn('Sector performance unavailable:', error instanceof Error ? error.message : String(error));
            return new Map();
        }
    }
}
