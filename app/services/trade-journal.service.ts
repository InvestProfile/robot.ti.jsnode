import { getRobotConfig } from '../config/robot.config';
import { SignalStateModel } from '../models/signal-state.model';
import { TradeDecisionModel } from '../models/trade-decision.model';

export type TradeDecisionStatus = 'skip' | 'dry-run' | 'order-posted' | 'order-failed';

interface TradeDecisionLog {
    accountId: string;
    accountAlias?: string;
    accountMode?: string;
    figi?: string;
    instrumentUid?: string;
    ticker?: string;
    name?: string;
    status: TradeDecisionStatus;
    signalSource?: string;
    reason: string;
    averagePrice?: number;
    currentPrice?: number;
    profitPercent?: number;
    quantityLots?: number;
    estimatedOrderRub?: number;
}

export default class TradeJournalService {
    private static getSignalKey(decision: TradeDecisionLog) {
        return [
            decision.accountId,
            decision.accountMode ?? 'trade',
            decision.instrumentUid ?? decision.figi ?? decision.ticker ?? 'portfolio',
            decision.signalSource ?? 'none'
        ].join(':');
    }

    private static getFingerprint(decision: TradeDecisionLog) {
        return [
            decision.status,
            decision.signalSource ?? '',
            this.normalizeReason(decision.reason),
            decision.quantityLots ?? '',
            decision.estimatedOrderRub ? Math.round(decision.estimatedOrderRub) : ''
        ].join('|');
    }

    private static normalizeReason(reason: string) {
        return reason
            .replace(/[+-]?\d+(?:[.,]\d+)?%/g, '<percent>')
            .replace(/[+-]?\d+(?:[.,]\d+)?\s*RUB/g, '<money>')
            .replace(/[+-]?\d+(?:[.,]\d+)?/g, '<number>');
    }

    private static getDecisionPrice(decision: TradeDecisionLog) {
        return decision.currentPrice ?? decision.estimatedOrderRub;
    }

    private static getPriceChangePercent(previousPrice: number | undefined, currentPrice: number | undefined) {
        if (!previousPrice || !currentPrice || previousPrice <= 0) return Number.POSITIVE_INFINITY;
        return Math.abs(currentPrice / previousPrice - 1) * 100;
    }

    private static async shouldWriteDecision(decision: TradeDecisionLog) {
        if (decision.status === 'order-posted' || decision.status === 'order-failed') {
            return true;
        }

        const config = getRobotConfig();
        const signalKey = this.getSignalKey(decision);
        const fingerprint = this.getFingerprint(decision);
        const currentPrice = this.getDecisionPrice(decision);
        const now = new Date();
        const state = await SignalStateModel.findOne({ where: { signalKey } });

        if (!state) {
            await SignalStateModel.create({
                signalKey,
                accountId: decision.accountId,
                accountMode: decision.accountMode ?? 'trade',
                instrumentUid: decision.instrumentUid,
                ticker: decision.ticker,
                signalSource: decision.signalSource,
                status: decision.status,
                reason: decision.reason,
                fingerprint,
                lastPrice: currentPrice,
                lastLoggedAt: now
            });
            return true;
        }

        const elapsedMs = now.getTime() - new Date(state.lastLoggedAt).getTime();
        const priceChangePercent = this.getPriceChangePercent(state.lastPrice, currentPrice);
        const changed = state.fingerprint !== fingerprint;
        const cooldownExpired = elapsedMs >= config.signalCooldownMs;
        const priceChanged = priceChangePercent >= config.signalPriceChangePercent;
        const shouldWrite = changed || cooldownExpired || priceChanged;

        await state.update({
            accountId: decision.accountId,
            accountMode: decision.accountMode ?? 'trade',
            instrumentUid: decision.instrumentUid,
            ticker: decision.ticker,
            signalSource: decision.signalSource,
            status: decision.status,
            reason: decision.reason,
            fingerprint,
            lastPrice: currentPrice,
            lastLoggedAt: shouldWrite ? now : state.lastLoggedAt
        });

        return shouldWrite;
    }

    static async logDecision(decision: TradeDecisionLog) {
        const shouldWrite = await this.shouldWriteDecision(decision);

        if (!shouldWrite) return;

        const payload = {
            at: new Date().toISOString(),
            ...decision
        };

        console.log('TRADE_DECISION ' + JSON.stringify(payload));

        await TradeDecisionModel.create({
            accountId: decision.accountId,
            accountAlias: decision.accountAlias,
            accountMode: decision.accountMode ?? 'trade',
            figi: decision.figi,
            instrumentUid: decision.instrumentUid,
            ticker: decision.ticker,
            name: decision.name,
            status: decision.status,
            signalSource: decision.signalSource,
            reason: decision.reason,
            averagePrice: decision.averagePrice,
            currentPrice: decision.currentPrice,
            profitPercent: decision.profitPercent,
            quantityLots: decision.quantityLots,
            estimatedOrderRub: decision.estimatedOrderRub
        });
    }
}
