import { RobotConfig } from '../config/robot.config';
import StrategyEngine from '../strategies/strategy-engine';
import RiskManagerService from './risk-manager.service';
import OperationsService from './operations.service';
import InstrumentsService from './instruments.service';
import marketData from './marketData.service';
import { quotationToNumber } from '../utils/money';
import SellPolicyService from './sell-policy.service';
import ProtectiveStopService from './protective-stop.service';

type AccountMode = 'trade' | 'observe';

const getAllAccounts = (config: RobotConfig) => [
    ...config.accountIds.map(accountId => ({ accountId, mode: 'trade' as AccountMode })),
    ...config.observeAccountIds.map(accountId => ({ accountId, mode: 'observe' as AccountMode }))
];

export default class SellBrainService {
    static async evaluate(config: RobotConfig) {
        const shares = await InstrumentsService.getShares();
        const instruments = shares?.instruments ?? [];
        const items = [];

        for (const account of getAllAccounts(config)) {
            const portfolio = await OperationsService.getPortfolio(account.accountId);
            const tradingStatuses = await marketData.getStatuses(
                portfolio?.positions?.map(position => position.instrumentUid).filter(Boolean) ?? []
            );

            for (const position of portfolio?.positions ?? []) {
                const averagePrice = quotationToNumber(position.averagePositionPrice);
                const currentPrice = quotationToNumber(position.currentPrice);
                const instrument = instruments.find(item => item.figi === position.figi && item.uid === position.instrumentUid)
                    ?? instruments.find(item => item.figi === position.figi);
                const quantityLots = Number(position.quantityLots?.units ?? 0);

                if (!averagePrice || !currentPrice || quantityLots <= 0) {
                    items.push({
                        accountId: account.accountId,
                        accountAlias: config.accountAliases[account.accountId],
                        accountMode: account.mode,
                        figi: position.figi,
                        instrumentUid: position.instrumentUid,
                        ticker: instrument?.ticker,
                        name: instrument?.name,
                        action: 'skip',
                        status: 'blocked',
                        reason: 'average/current price or quantity is empty',
                        averagePrice,
                        currentPrice,
                        quantityLots
                    });
                    continue;
                }

                const tradingStatus = tradingStatuses.get(position.instrumentUid);
                const signal = await StrategyEngine.evaluate({
                    accountId: account.accountId,
                    figi: position.figi,
                    instrumentUid: position.instrumentUid,
                    ticker: instrument?.ticker,
                    name: instrument?.name,
                    averagePrice,
                    currentPrice,
                    quantityLots
                }, config);
                const risk = RiskManagerService.evaluateSignal({
                    averagePrice,
                    currentPrice,
                    quantityLots,
                    tradingStatus: tradingStatus?.tradingStatus,
                    signal
                }, config);
                const protectiveFailure = signal?.source === 'stop-loss'
                    ? ProtectiveStopService.getLastFailure(account.accountId, position.instrumentUid)
                    : undefined;
                const riskReason = protectiveFailure
                    ? `${risk.reason}; software protective stop fallback active because broker rejected protective stop: ${protectiveFailure.reason}`
                    : risk.reason;
                const sellPolicy = risk.allowed
                    ? await SellPolicyService.evaluateSellPermission({
                        accountId: account.accountId,
                        figi: position.figi,
                        instrumentUid: position.instrumentUid,
                        requestedLots: risk.quantity,
                        signalSource: signal?.source,
                        profitPercent: risk.profitPercent,
                        minProfitPercent: config.minProfitPercent,
                        currentPrice,
                        lotSize: instrument?.lot
                    })
                    : undefined;
                const policyBlocked = account.mode === 'trade' && risk.allowed && sellPolicy && !sellPolicy.allowed;

                items.push({
                    accountId: account.accountId,
                    accountAlias: config.accountAliases[account.accountId],
                    accountMode: account.mode,
                    figi: position.figi,
                    instrumentUid: position.instrumentUid,
                    ticker: instrument?.ticker,
                    name: instrument?.name,
                    action: signal?.action ?? 'skip',
                    source: signal?.source,
                    status: policyBlocked
                        ? 'blocked'
                        : risk.allowed
                        ? 'allowed'
                        : signal?.action === 'hold' && risk.reason.startsWith('hold-winner:')
                            ? 'hold'
                            : 'blocked',
                    reason: policyBlocked
                        ? sellPolicy.reason
                        : account.mode === 'observe' && risk.allowed
                        ? 'observe-only: ' + riskReason
                        : riskReason,
                    averagePrice,
                    currentPrice,
                    profitPercent: risk.profitPercent,
                    quantityLots,
                    signalLots: signal?.quantityLots,
                    orderLots: sellPolicy?.allowedLots ?? risk.quantity,
                    robotOwnedLots: sellPolicy?.robotOwnedLots,
                    latestRobotAction: sellPolicy?.latestDirection === '1' ? 'buy' : sellPolicy?.latestDirection === '2' ? 'sell' : undefined,
                    latestRobotTradeAt: sellPolicy?.latestTradeAt,
                    robotAverageLotCostRub: sellPolicy?.robotAverageLotCostRub,
                    robotProfitPercent: sellPolicy?.robotProfitPercent,
                    sellPolicy: sellPolicy?.reason,
                    confidence: signal?.confidence,
                    factors: signal?.factors
                });
            }
        }

        const sell = items.filter(item => item.action === 'sell' && item.status === 'allowed').length;
        const hold = items.filter(item => item.action === 'hold').length;
        const blocked = items.filter(item => item.status === 'blocked').length;

        return {
            generatedAt: new Date().toISOString(),
            summary: {
                positions: items.length,
                sell,
                hold,
                blocked
            },
            items
        };
    }
}
