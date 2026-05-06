import { RobotConfig } from '../config/robot.config';
import BuyScannerService from './buy-scanner.service';

const DEFAULT_SCENARIOS = [
    { label: 'strict', minHealthPercent: 40 },
    { label: 'soft', minHealthPercent: 20 },
    { label: 'off', minHealthPercent: 0 }
];

export default class MarketRegimeLabService {
    static async compare(config: RobotConfig, limit = 8) {
        const scenarios = [];

        for (const scenario of DEFAULT_SCENARIOS) {
            const scenarioConfig = {
                ...config,
                marketRegimeMinHealthPercent: scenario.minHealthPercent
            };
            const scan = await BuyScannerService.scan(scenarioConfig);
            const items = scan.items
                .filter(item => (item.score ?? 0) >= scenarioConfig.buyMinScore - 15)
                .slice(0, Math.min(Math.max(Math.trunc(limit), 1), 30))
                .map(item => ({
                    ticker: item.ticker,
                    name: item.name,
                    score: item.score,
                    passed: item.passed,
                    lastPrice: item.lastPrice,
                    reason: item.reason,
                    analysis: item.analysis
                }));

            scenarios.push({
                ...scenario,
                marketPassed: scan.marketRegime.passed,
                marketReason: scan.marketRegime.reason,
                passCount: items.filter(item => item.passed).length,
                waitCount: items.filter(item => !item.passed && (item.score ?? 0) >= scenarioConfig.buyMinScore).length,
                items
            });
        }

        return {
            generatedAt: new Date().toISOString(),
            current: {
                minHealthPercent: config.marketRegimeMinHealthPercent,
                minAvgTrendPercent: config.marketRegimeMinAvgTrendPercent,
                minScore: config.buyMinScore
            },
            scenarios
        };
    }
}
