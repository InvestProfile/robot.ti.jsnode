import { RobotConfig } from '../config/robot.config';
import OperationsService from './operations.service';
import RobotPositionLedgerService from './robot-position-ledger.service';
import { quotationToNumber } from '../utils/money';

type BrokerPosition = {
    accountId: string;
    figi?: string;
    instrumentUid?: string;
    quantityLots: number;
    currentPrice?: number;
};

const toNumber = (value: unknown) => {
    const number = Number(value ?? 0);
    return Number.isFinite(number) ? number : 0;
};

const brokerPositionKeys = (position: BrokerPosition) => [
    position.instrumentUid ? `${position.accountId}:uid:${position.instrumentUid}` : undefined,
    position.figi ? `${position.accountId}:figi:${position.figi}` : undefined
].filter((key): key is string => Boolean(key));

const ledgerPositionKeys = (position: Record<string, unknown>) => [
    position.instrumentUid ? `${position.accountId}:uid:${position.instrumentUid}` : undefined,
    position.figi ? `${position.accountId}:figi:${position.figi}` : undefined
].filter((key): key is string => Boolean(key));

export default class AccountingAuditService {
    static async getLedgerBrokerAudit(config: RobotConfig) {
        const ledger = await RobotPositionLedgerService.getLedger(config);
        const brokerByKey = new Map<string, BrokerPosition>();
        const brokerPositions: BrokerPosition[] = [];

        for (const accountId of config.accountIds) {
            const portfolio = await OperationsService.getPortfolio(accountId);

            for (const position of portfolio?.positions ?? []) {
                const quantityLots = toNumber(position.quantityLots?.units);
                if (quantityLots <= 0) continue;

                const item: BrokerPosition = {
                    accountId,
                    figi: position.figi,
                    instrumentUid: position.instrumentUid,
                    quantityLots,
                    currentPrice: quotationToNumber(position.currentPrice)
                };

                brokerPositions.push(item);
                for (const key of brokerPositionKeys(item)) {
                    brokerByKey.set(key, item);
                }
            }
        }

        const issues = [];
        const ledgerOpenItems = (ledger.items || []).filter(item => toNumber(item.lots) > 0);

        for (const item of ledgerOpenItems) {
            const broker = ledgerPositionKeys(item).map(key => brokerByKey.get(key)).find(Boolean);
            const ledgerLots = toNumber(item.lots);

            if (!broker) {
                issues.push({
                    type: 'ledger-ghost',
                    severity: 'high',
                    accountId: item.accountId,
                    accountAlias: item.accountAlias,
                    ticker: item.ticker,
                    name: item.name,
                    figi: item.figi,
                    instrumentUid: item.instrumentUid,
                    ledgerLots,
                    brokerLots: 0,
                    averagePrice: item.averagePrice,
                    currentPrice: item.currentPrice,
                    marketValue: item.marketValue,
                    lastTradeAt: item.lastTradeAt,
                    reason: 'robot ledger has open lots, but broker portfolio has no matching position'
                });
                continue;
            }

            if (broker.quantityLots < ledgerLots) {
                issues.push({
                    type: 'ledger-overstates-broker',
                    severity: 'medium',
                    accountId: item.accountId,
                    accountAlias: item.accountAlias,
                    ticker: item.ticker,
                    name: item.name,
                    figi: item.figi,
                    instrumentUid: item.instrumentUid,
                    ledgerLots,
                    brokerLots: broker.quantityLots,
                    averagePrice: item.averagePrice,
                    currentPrice: broker.currentPrice ?? item.currentPrice,
                    marketValue: item.marketValue,
                    lastTradeAt: item.lastTradeAt,
                    reason: 'robot ledger lots are greater than broker portfolio lots'
                });
            }
        }

        return {
            generatedAt: new Date().toISOString(),
            summary: {
                checkedLedgerPositions: ledgerOpenItems.length,
                brokerPositions: brokerPositions.length,
                issues: issues.length,
                ghosts: issues.filter(issue => issue.type === 'ledger-ghost').length,
                quantityMismatches: issues.filter(issue => issue.type === 'ledger-overstates-broker').length
            },
            issues
        };
    }
}
