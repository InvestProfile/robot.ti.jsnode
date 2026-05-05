import { RobotConfig } from '../config/robot.config';
import StrategyEngine from '../strategies/strategy-engine';
import RiskManagerService from './risk-manager.service';
import OperationsService from './operations.service';
import InstrumentsService from './instruments.service';
import marketData from './marketData.service';
import { quotationToNumber } from '../utils/money';

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

                const tradingStatus = await marketData.getStatus(position.figi, position.instrumentUid);
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
                    status: risk.allowed
                        ? 'allowed'
                        : signal?.action === 'hold' && risk.reason.startsWith('hold-winner:')
                            ? 'hold'
                            : 'blocked',
                    reason: account.mode === 'observe' && risk.allowed
                        ? 'observe-only: ' + risk.reason
                        : risk.reason,
                    averagePrice,
                    currentPrice,
                    profitPercent: risk.profitPercent,
                    quantityLots,
                    signalLots: signal?.quantityLots,
                    orderLots: risk.quantity,
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
