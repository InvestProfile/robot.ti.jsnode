import { getRobotConfig } from '../config/robot.config';
import { SignalStateModel } from '../models/signal-state.model';
import { TradeDecisionModel } from '../models/trade-decision.model';
import InstrumentsService from './instruments.service';

export type TradeDecisionStatus =
    | 'skip'
    | 'dry-run'
    | 'order-posted'
    | 'order-rejected'
    | 'order-failed-before-submit'
    | 'order-unknown'
    | 'order-failed';

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
    private static normalizeSignalSource(decision: TradeDecisionLog) {
        const explicit = decision.signalSource?.trim();
        if (explicit) return explicit;

        const reason = decision.reason.toLowerCase();
        if (reason.includes('portfolio has no positions')) return 'portfolio-check';
        if (reason.includes('average') || reason.includes('current price') || reason.includes('order price')) return 'position-data';
        if (reason.includes('normal trading status')) return 'trading-status';
        if (reason.includes('no strategy signal')) return 'strategy-engine';
        if (reason.includes('sell policy')) return 'sell-policy';
        if (reason.includes('postorder') || reason.includes('open buy order')) return 'orders';
        if (reason.includes('score-buy') || decision.estimatedOrderRub !== undefined) return 'score-buy';
        if (decision.status.startsWith('order-')) return 'orders';
        return 'risk-check';
    }

    private static async getInstrumentMetadata(decision: TradeDecisionLog) {
        try {
            if (decision.instrumentUid) {
                const response = await InstrumentsService.getInstrumentByUid(decision.instrumentUid);
                if (response?.instrument) return response.instrument;
            }

            if (decision.figi) {
                const response = await InstrumentsService.getInstrumentByFigi(decision.figi);
                if (response?.instrument) return response.instrument;
            }
        } catch (error) {
            console.warn('Failed to enrich trade decision instrument metadata:', error);
        }

        return undefined;
    }

    private static async normalizeDecision(decision: TradeDecisionLog): Promise<TradeDecisionLog> {
        const normalized: TradeDecisionLog = {
            ...decision,
            signalSource: this.normalizeSignalSource(decision)
        };

        if (normalized.ticker && normalized.name && normalized.figi && normalized.instrumentUid) {
            return normalized;
        }

        const metadata = await this.getInstrumentMetadata(normalized);
        if (!metadata) return normalized;

        return {
            ...normalized,
            figi: normalized.figi ?? metadata.figi,
            instrumentUid: normalized.instrumentUid ?? metadata.uid,
            ticker: normalized.ticker ?? metadata.ticker,
            name: normalized.name ?? metadata.name
        };
    }

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
            decision.quantityLots ?? ''
        ].join('|');
    }

    private static normalizeReason(reason: string) {
        return reason
            .replace(/[+-]?\d+(?:[.,]\d+)?%/g, '<percent>')
            .replace(/[+-]?\d+(?:[.,]\d+)?\s*RUB/g, '<money>')
            .replace(/[+-]?\d+(?:[.,]\d+)?/g, '<number>');
    }

    private static getDecisionPrice(decision: TradeDecisionLog) {
        const price = decision.currentPrice ?? decision.estimatedOrderRub;
        return price && Number.isFinite(price) && price > 0 ? price : undefined;
    }

    private static getPriceChangePercent(previousPrice: number | undefined, currentPrice: number | undefined) {
        if (!previousPrice || !currentPrice || previousPrice <= 0) return 0;
        return Math.abs(currentPrice / previousPrice - 1) * 100;
    }

    private static async shouldWriteDecision(decision: TradeDecisionLog) {
        if (decision.status.startsWith('order-')) {
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
        const normalizedDecision = await this.normalizeDecision(decision);
        const shouldWrite = await this.shouldWriteDecision(normalizedDecision);

        if (!shouldWrite) return;

        const payload = {
            at: new Date().toISOString(),
            ...normalizedDecision
        };

        console.log('TRADE_DECISION ' + JSON.stringify(payload));

        await TradeDecisionModel.create({
            accountId: normalizedDecision.accountId,
            accountAlias: normalizedDecision.accountAlias,
            accountMode: normalizedDecision.accountMode ?? 'trade',
            figi: normalizedDecision.figi,
            instrumentUid: normalizedDecision.instrumentUid,
            ticker: normalizedDecision.ticker,
            name: normalizedDecision.name,
            status: normalizedDecision.status,
            signalSource: normalizedDecision.signalSource,
            reason: normalizedDecision.reason,
            averagePrice: normalizedDecision.averagePrice,
            currentPrice: normalizedDecision.currentPrice,
            profitPercent: normalizedDecision.profitPercent,
            quantityLots: normalizedDecision.quantityLots,
            estimatedOrderRub: normalizedDecision.estimatedOrderRub
        });
    }

    static async backfillMissingMetadata(limit = 500) {
        const rows = await TradeDecisionModel.findAll({
            order: [['createdAt', 'DESC']],
            limit
        });
        let checked = 0;
        let updated = 0;

        for (const row of rows) {
            const plain = row.get({ plain: true }) as TradeDecisionLog & { id: number };
            if (plain.ticker && plain.name && plain.signalSource) continue;

            checked += 1;
            const normalized = await this.normalizeDecision(plain);
            const patch = {
                figi: normalized.figi,
                instrumentUid: normalized.instrumentUid,
                ticker: normalized.ticker,
                name: normalized.name,
                signalSource: normalized.signalSource
            };

            if (
                patch.figi !== plain.figi
                || patch.instrumentUid !== plain.instrumentUid
                || patch.ticker !== plain.ticker
                || patch.name !== plain.name
                || patch.signalSource !== plain.signalSource
            ) {
                await row.update(patch);
                updated += 1;
            }
        }

        return { checked, updated, limit };
    }
}
