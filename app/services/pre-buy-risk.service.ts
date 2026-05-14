import { RobotConfig } from '../config/robot.config';
import { DailyCandle } from '../strategies/trade-signal';
import MarketDataService from './marketData.service';

type OrderBookMetrics = NonNullable<Awaited<ReturnType<typeof MarketDataService.getOrderBookMetrics>>>;

interface PreBuyRiskInput {
    instrumentUid: string;
    ticker?: string;
    lot: number;
    estimatedOrderRub: number;
    sector?: string;
    portfolioValueRub: number;
    sectorValueRub: number;
    dailyCandles?: DailyCandle[];
    orderBookMetrics?: OrderBookMetrics;
    orderBookError?: unknown;
}

export interface PreBuyRiskCheck {
    key: string;
    status: 'pass' | 'warn' | 'block' | 'unknown';
    reason: string;
    enforced: boolean;
    value?: number;
    limit?: number;
}

export interface PreBuyRiskResult {
    passed: boolean;
    mode: 'enforced' | 'observe';
    warnings: string[];
    blockingReasons: string[];
    checks: PreBuyRiskCheck[];
    spreadPercent?: number;
    askLiquidityRub?: number;
    avgDailyTurnoverRub?: number;
    sector?: string;
    projectedSectorSharePercent?: number;
}

const average = (values: number[]) => values.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : undefined;

const formatPercent = (value: number | undefined) =>
    value === undefined || !Number.isFinite(value) ? '-' : `${value.toFixed(2)}%`;

const formatRub = (value: number | undefined) =>
    value === undefined || !Number.isFinite(value) ? '-' : `${Math.round(value)} RUB`;

const getAvgDailyTurnoverRub = (candles: DailyCandle[] | undefined, lot: number) => {
    const values = candles
        ?.slice(-20)
        .map(candle => candle.close * candle.volume * Math.max(1, lot))
        .filter(value => Number.isFinite(value) && value > 0) ?? [];

    return average(values);
};

export default class PreBuyRiskService {
    static async evaluate(input: PreBuyRiskInput, config: RobotConfig): Promise<PreBuyRiskResult> {
        const checks: PreBuyRiskCheck[] = [];
        const warnings: string[] = [];
        const blockingReasons: string[] = [];

        const addCheck = (check: PreBuyRiskCheck) => {
            checks.push(check);

            if (check.status === 'block') {
                if (check.enforced) {
                    blockingReasons.push(check.reason);
                } else {
                    warnings.push(`observe-only: ${check.reason}`);
                }
            }

            if (check.status === 'warn' || check.status === 'unknown') {
                warnings.push(check.reason);
            }
        };

        let spreadPercent: number | undefined;
        let askLiquidityRub: number | undefined;

        if (config.liquidityRiskEnabled) {
            try {
                if (input.orderBookError) throw input.orderBookError;
                const orderBook = input.orderBookMetrics ?? await MarketDataService.getOrderBookMetrics(input.instrumentUid, input.lot);
                spreadPercent = orderBook?.spreadPercent;
                askLiquidityRub = orderBook?.askLiquidityRub;

                if (spreadPercent === undefined) {
                    addCheck({
                        key: 'spread',
                        status: 'unknown',
                        reason: 'spread is unavailable',
                        enforced: config.liquidityRiskEnforced
                    });
                } else {
                    addCheck({
                        key: 'spread',
                        status: spreadPercent > config.maxSpreadPercent ? 'block' : 'pass',
                        reason: `spread ${formatPercent(spreadPercent)} > ${formatPercent(config.maxSpreadPercent)}`,
                        enforced: config.liquidityRiskEnforced,
                        value: spreadPercent,
                        limit: config.maxSpreadPercent
                    });
                }

                if (askLiquidityRub === undefined || askLiquidityRub <= 0) {
                    addCheck({
                        key: 'orderbook-ask',
                        status: 'unknown',
                        reason: 'ask liquidity is unavailable',
                        enforced: config.liquidityRiskEnforced
                    });
                } else {
                    addCheck({
                        key: 'orderbook-ask',
                        status: askLiquidityRub < config.minOrderbookAskRub ? 'block' : 'pass',
                        reason: `ask liquidity ${formatRub(askLiquidityRub)} < ${formatRub(config.minOrderbookAskRub)}`,
                        enforced: config.liquidityRiskEnforced,
                        value: askLiquidityRub,
                        limit: config.minOrderbookAskRub
                    });
                }
            } catch (error) {
                addCheck({
                    key: 'orderbook',
                    status: 'unknown',
                    reason: `orderbook unavailable: ${error instanceof Error ? error.message : String(error)}`,
                    enforced: config.liquidityRiskEnforced
                });
            }

            const avgDailyTurnoverRub = getAvgDailyTurnoverRub(input.dailyCandles, input.lot);
            if (avgDailyTurnoverRub === undefined) {
                addCheck({
                    key: 'daily-turnover',
                    status: 'unknown',
                    reason: 'daily turnover is unavailable',
                    enforced: config.liquidityRiskEnforced
                });
            } else {
                addCheck({
                    key: 'daily-turnover',
                    status: avgDailyTurnoverRub < config.minDailyTurnoverRub ? 'block' : 'pass',
                    reason: `avg daily turnover ${formatRub(avgDailyTurnoverRub)} < ${formatRub(config.minDailyTurnoverRub)}`,
                    enforced: config.liquidityRiskEnforced,
                    value: avgDailyTurnoverRub,
                    limit: config.minDailyTurnoverRub
                });
            }
        }

        const avgDailyTurnoverRub = checks.find(check => check.key === 'daily-turnover')?.value;
        let projectedSectorSharePercent: number | undefined;
        const sector = input.sector?.trim() || undefined;

        if (config.sectorRiskEnabled) {
            if (!sector) {
                addCheck({
                    key: 'sector',
                    status: 'unknown',
                    reason: 'sector is unavailable',
                    enforced: config.sectorRiskEnforced
                });
            } else if (input.portfolioValueRub > 0) {
                projectedSectorSharePercent = (input.sectorValueRub + input.estimatedOrderRub) / input.portfolioValueRub * 100;
                addCheck({
                    key: 'sector-share',
                    status: projectedSectorSharePercent > config.maxSectorSharePercent ? 'block' : 'pass',
                    reason: `sector ${sector} share ${formatPercent(projectedSectorSharePercent)} > ${formatPercent(config.maxSectorSharePercent)}`,
                    enforced: config.sectorRiskEnforced,
                    value: projectedSectorSharePercent,
                    limit: config.maxSectorSharePercent
                });
            }
        }

        return {
            passed: blockingReasons.length === 0,
            mode: config.liquidityRiskEnforced || config.sectorRiskEnforced ? 'enforced' : 'observe',
            warnings,
            blockingReasons,
            checks,
            spreadPercent,
            askLiquidityRub,
            avgDailyTurnoverRub,
            sector,
            projectedSectorSharePercent
        };
    }
}
