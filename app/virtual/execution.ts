import { normalizeRfc3339Timestamp } from './codecs';
import { FeeEvent, TradeCashEvent } from './types';

export interface VirtualOrderIntent {
    readonly id: string;
    readonly virtualAccountId: string;
    readonly instrumentId: string;
    readonly side: 'buy' | 'sell';
    readonly quantityLots: number;
    readonly submittedAt: string;
}

export interface VirtualMarketQuote {
    readonly instrumentId: string;
    readonly bidKopecks: bigint;
    readonly askKopecks: bigint;
    readonly lotSize: number;
    readonly observedAt: string;
}

export interface VirtualExecutionPolicy {
    readonly feeBasisPoints: number;
    readonly slippageBasisPoints: number;
    readonly maxQuoteAgeMs: number;
}

export interface VirtualExecutionContext {
    readonly now: string;
    readonly cashKopecks: bigint;
    readonly availableLots: number;
}

export type VirtualOrderRejectionReason =
    | 'invalid-order'
    | 'invalid-quote'
    | 'stale-quote'
    | 'insufficient-cash'
    | 'insufficient-position';

export interface VirtualOrderRejection {
    readonly status: 'rejected';
    readonly orderId: string;
    readonly reason: VirtualOrderRejectionReason;
    readonly rejectedAt: string;
}

export interface VirtualFill {
    readonly id: string;
    readonly orderId: string;
    readonly virtualAccountId: string;
    readonly instrumentId: string;
    readonly side: 'buy' | 'sell';
    readonly quantityLots: number;
    readonly lotSize: number;
    readonly referencePriceKopecks: bigint;
    readonly executionPriceKopecks: bigint;
    readonly grossAmountKopecks: bigint;
    readonly feeKopecks: bigint;
    readonly netCashDeltaKopecks: bigint;
    readonly filledAt: string;
}

export interface VirtualOrderFillResult {
    readonly status: 'filled';
    readonly orderId: string;
    readonly fill: VirtualFill;
    readonly ledgerEvents: readonly (TradeCashEvent | FeeEvent)[];
}

export type VirtualExecutionResult = VirtualOrderRejection | VirtualOrderFillResult;

const requireTrimmed = (value: string) => typeof value === 'string' && value.trim() === value && value.length > 0;
const validBps = (value: number) => Number.isInteger(value) && value >= 0 && value <= 10_000;
const ceilBasisPoints = (amount: bigint, basisPoints: number) =>
    amount === 0n || basisPoints === 0 ? 0n : (amount * BigInt(basisPoints) + 9_999n) / 10_000n;
const tryNormalizeTimestamp = (value: string) => {
    try {
        return normalizeRfc3339Timestamp(value);
    } catch {
        return undefined;
    }
};


const fingerprint = (order: VirtualOrderIntent, quote: VirtualMarketQuote, context: VirtualExecutionContext, policy: VirtualExecutionPolicy) =>
    JSON.stringify({
        order: { ...order },
        quote: { ...quote, bidKopecks: quote.bidKopecks.toString(), askKopecks: quote.askKopecks.toString() },
        context: { ...context, cashKopecks: context.cashKopecks.toString() },
        policy
    });

export class DeterministicVirtualExecutionSimulator {
    readonly #results = new Map<string, { fingerprint: string; result: VirtualExecutionResult }>();

    execute(order: VirtualOrderIntent, quote: VirtualMarketQuote, context: VirtualExecutionContext, policy: VirtualExecutionPolicy): VirtualExecutionResult {
        if (!requireTrimmed(order.id)) throw new TypeError('order.id must be a trimmed non-empty string');
        const key = `${order.virtualAccountId}\u0000${order.id}`;
        const inputFingerprint = fingerprint(order, quote, context, policy);
        const existing = this.#results.get(key);
        if (existing) {
            if (existing.fingerprint !== inputFingerprint) throw new Error(`virtual order ID conflict: ${order.id}`);
            return existing.result;
        }

        const now = normalizeRfc3339Timestamp(context.now);
        const reject = (reason: VirtualOrderRejectionReason): VirtualOrderRejection => Object.freeze({
            status: 'rejected', orderId: order.id, reason, rejectedAt: now
        });
        let result: VirtualExecutionResult;
        const submittedAt = tryNormalizeTimestamp(order.submittedAt);

        const validOrder = requireTrimmed(order.virtualAccountId) && requireTrimmed(order.instrumentId)
            && (order.side === 'buy' || order.side === 'sell')
            && Number.isSafeInteger(order.quantityLots) && order.quantityLots > 0
            && submittedAt !== undefined && submittedAt <= now
            && typeof context.cashKopecks === 'bigint' && context.cashKopecks >= 0n
            && Number.isSafeInteger(context.availableLots) && context.availableLots >= 0;
        if (!validOrder || !validBps(policy.feeBasisPoints) || !validBps(policy.slippageBasisPoints)
            || !Number.isSafeInteger(policy.maxQuoteAgeMs) || policy.maxQuoteAgeMs < 0) {
            result = reject('invalid-order');
        } else {
            const observedAt = tryNormalizeTimestamp(quote.observedAt);
            const validQuote = quote.instrumentId === order.instrumentId
                && typeof quote.bidKopecks === 'bigint' && quote.bidKopecks > 0n
                && typeof quote.askKopecks === 'bigint' && quote.askKopecks > 0n
                && quote.bidKopecks <= quote.askKopecks
                && Number.isSafeInteger(quote.lotSize) && quote.lotSize > 0
                && observedAt !== undefined && observedAt <= now;
            if (!validQuote) {
                result = reject('invalid-quote');
            } else if (Date.parse(now) - Date.parse(observedAt as string) > policy.maxQuoteAgeMs) {
                result = reject('stale-quote');
            } else if (order.side === 'sell' && context.availableLots < order.quantityLots) {
                result = reject('insufficient-position');
            } else {
                const referencePrice = order.side === 'buy' ? quote.askKopecks : quote.bidKopecks;
                const slippage = ceilBasisPoints(referencePrice, policy.slippageBasisPoints);
                const executionPrice = order.side === 'buy' ? referencePrice + slippage : referencePrice - slippage;
                if (executionPrice <= 0n) {
                    result = reject('invalid-quote');
                } else {
                    const gross = executionPrice * BigInt(quote.lotSize) * BigInt(order.quantityLots);
                    const fee = ceilBasisPoints(gross, policy.feeBasisPoints);
                    const requiredCash = gross + fee;
                    if (order.side === 'buy' && context.cashKopecks < requiredCash) {
                        result = reject('insufficient-cash');
                    } else {
                        const fill: VirtualFill = Object.freeze({
                            id: `fill:${order.id}`, orderId: order.id,
                            virtualAccountId: order.virtualAccountId, instrumentId: order.instrumentId,
                            side: order.side, quantityLots: order.quantityLots, lotSize: quote.lotSize,
                            referencePriceKopecks: referencePrice, executionPriceKopecks: executionPrice,
                            grossAmountKopecks: gross, feeKopecks: fee,
                            netCashDeltaKopecks: order.side === 'buy' ? -requiredCash : gross - fee,
                            filledAt: now
                        });
                        const cashEvent: TradeCashEvent = Object.freeze({
                            id: `${order.id}:cash`, virtualAccountId: order.virtualAccountId,
                            occurredAt: now, kind: 'trade-cash', amountKopecks: gross,
                            direction: order.side === 'buy' ? 'debit' : 'credit', tradeReference: fill.id
                        });
                        const ledgerEvents: (TradeCashEvent | FeeEvent)[] = [cashEvent];
                        if (fee > 0n) ledgerEvents.push(Object.freeze({
                            id: `${order.id}:fee`, virtualAccountId: order.virtualAccountId,
                            occurredAt: now, kind: 'fee', amountKopecks: fee,
                            reason: `execution fee for ${fill.id}`
                        }));
                        result = Object.freeze({ status: 'filled', orderId: order.id, fill, ledgerEvents: Object.freeze(ledgerEvents) });
                    }
                }
            }
        }
        this.#results.set(key, { fingerprint: inputFingerprint, result });
        return result;
    }
}
