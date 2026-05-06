import { RobotConfig } from '../config/robot.config';
import BuyScannerService from './buy-scanner.service';
import ScanUniverseService from './scan-universe.service';

const CACHE_TTL_MS = 15 * 60 * 1000;
const MAX_DAILY_TICKERS = 5;
const MIN_SCORE_GAP = 15;

type DailyBuyListResult = {
    generatedAt: string;
    expiresAt: string;
    source: 'market-scan' | 'fallback';
    tickers: string[];
    universe: {
        totalShares?: number;
        eligibleBeforePriceFilter?: number;
        scanned: number;
        maxLotRub: number;
    };
    items: Array<{
        ticker: string;
        name?: string;
        score?: number;
        gap?: number;
        lastPrice?: number;
        estimatedOrderRub?: number;
        passed?: boolean;
        reason: string;
    }>;
};

let cache: { expiresAt: number; value: DailyBuyListResult } | undefined;

export default class DailyBuyListService {
    static async build(config: RobotConfig): Promise<DailyBuyListResult> {
        const now = Date.now();
        if (cache && cache.expiresAt > now) return cache.value;

        const universe = await ScanUniverseService.resolveTickers({
            ...config,
            scanUniverse: 'auto'
        });
        const scan = await BuyScannerService.scan(config, universe.tickers);
        const minScore = scan.minScore ?? config.buyMinScore;
        const items = scan.items
            .filter(item => item.lastPrice && item.estimatedOrderRub)
            .filter(item => config.maxOrderRub <= 0 || (item.estimatedOrderRub ?? Number.POSITIVE_INFINITY) <= config.maxOrderRub)
            .map(item => ({
                ticker: item.ticker,
                name: item.name,
                score: item.score,
                gap: item.score === undefined ? undefined : minScore - item.score,
                lastPrice: item.lastPrice,
                estimatedOrderRub: item.estimatedOrderRub,
                passed: item.passed,
                reason: item.reason
            }))
            .filter(item => item.score !== undefined && item.score >= minScore - MIN_SCORE_GAP)
            .sort((a, b) => {
                const aPass = a.passed ? 1 : 0;
                const bPass = b.passed ? 1 : 0;
                if (aPass !== bPass) return bPass - aPass;
                return (b.score ?? -1) - (a.score ?? -1);
            })
            .slice(0, MAX_DAILY_TICKERS);
        const tickers = items.map(item => item.ticker);
        const value = {
            generatedAt: new Date(now).toISOString(),
            expiresAt: new Date(now + CACHE_TTL_MS).toISOString(),
            source: tickers.length > 0 ? 'market-scan' as const : 'fallback' as const,
            tickers: tickers.length > 0 ? tickers : config.buyTickers,
            universe: {
                totalShares: universe.totalShares,
                eligibleBeforePriceFilter: universe.eligibleBeforePriceFilter,
                scanned: universe.tickers.length,
                maxLotRub: config.scanMaxLotRub
            },
            items
        };

        cache = {
            expiresAt: now + CACHE_TTL_MS,
            value
        };

        return value;
    }

    static async getEffectiveBuyTickers(config: RobotConfig) {
        return (await this.build(config)).tickers;
    }
}
