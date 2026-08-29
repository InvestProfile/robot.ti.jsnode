import type { VirtualFill } from './execution';
import { normalizeRfc3339Timestamp } from './codecs';

export interface VirtualPositionLot {
    readonly fillId: string;
    readonly acquiredAt: string;
    readonly quantityLots: number;
    readonly costKopecks: bigint;
}

export interface VirtualPositionState {
    readonly virtualAccountId: string;
    readonly instrumentId: string;
    readonly lotSize: number;
    readonly openLots: readonly VirtualPositionLot[];
    readonly realizedPnlKopecks: bigint;
    readonly appliedFills: VirtualFillFingerprintIndex;
}

export interface VirtualFillFingerprintIndex {
    readonly size: number;
    get(fillId: string): string | undefined;
}

export interface VirtualPositionMarkToMarket {
    readonly quantityLots: number;
    readonly costBasisKopecks: bigint;
    readonly marketValueKopecks: bigint;
    readonly realizedPnlKopecks: bigint;
    readonly unrealizedPnlKopecks: bigint;
}

const requireTrimmed = (value: string, field: string) => {
    if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
        throw new TypeError(`${field} must be a trimmed non-empty string`);
    }
};

const canonicalFill = (fill: VirtualFill): VirtualFill => {
    requireTrimmed(fill.id, 'fill.id');
    requireTrimmed(fill.virtualAccountId, 'fill.virtualAccountId');
    requireTrimmed(fill.instrumentId, 'fill.instrumentId');
    if (fill.side !== 'buy' && fill.side !== 'sell') throw new TypeError('fill.side is invalid');
    if (!Number.isSafeInteger(fill.quantityLots) || fill.quantityLots <= 0) {
        throw new TypeError('fill.quantityLots must be a positive safe integer');
    }
    if (!Number.isSafeInteger(fill.lotSize) || fill.lotSize <= 0) {
        throw new TypeError('fill.lotSize must be a positive safe integer');
    }
    for (const field of [
        'referencePriceKopecks', 'executionPriceKopecks', 'grossAmountKopecks', 'feeKopecks'
    ] as const) {
        if (typeof fill[field] !== 'bigint' || fill[field] < 0n) {
            throw new TypeError(`fill.${field} must be a non-negative bigint`);
        }
    }
    const expectedGross = fill.executionPriceKopecks * BigInt(fill.lotSize) * BigInt(fill.quantityLots);
    if (fill.executionPriceKopecks <= 0n || fill.grossAmountKopecks !== expectedGross) {
        throw new Error('fill gross amount does not reconcile');
    }
    const expectedCash = fill.side === 'buy'
        ? -(fill.grossAmountKopecks + fill.feeKopecks)
        : fill.grossAmountKopecks - fill.feeKopecks;
    if (fill.netCashDeltaKopecks !== expectedCash) throw new Error('fill cash delta does not reconcile');
    return Object.freeze({ ...fill, filledAt: normalizeRfc3339Timestamp(fill.filledAt) });
};

const fillFingerprint = (fill: VirtualFill) => JSON.stringify({
    ...fill,
    referencePriceKopecks: fill.referencePriceKopecks.toString(),
    executionPriceKopecks: fill.executionPriceKopecks.toString(),
    grossAmountKopecks: fill.grossAmountKopecks.toString(),
    feeKopecks: fill.feeKopecks.toString(),
    netCashDeltaKopecks: fill.netCashDeltaKopecks.toString()
});

class FrozenFillFingerprintIndex implements VirtualFillFingerprintIndex {
    readonly #values: Map<string, string>;
    readonly size: number;

    constructor(values: Iterable<readonly [string, string]> = []) {
        this.#values = new Map(values);
        this.size = this.#values.size;
        Object.freeze(this);
    }

    get(fillId: string) {
        return this.#values.get(fillId);
    }

    entries() {
        return this.#values.entries();
    }
}

export const emptyVirtualPosition = (
    virtualAccountId: string,
    instrumentId: string,
    lotSize: number
): VirtualPositionState => {
    requireTrimmed(virtualAccountId, 'virtualAccountId');
    requireTrimmed(instrumentId, 'instrumentId');
    if (!Number.isSafeInteger(lotSize) || lotSize <= 0) throw new TypeError('lotSize must be positive');
    return Object.freeze({
        virtualAccountId,
        instrumentId,
        lotSize,
        openLots: Object.freeze([]),
        realizedPnlKopecks: 0n,
        appliedFills: new FrozenFillFingerprintIndex()
    });
};

export const applyVirtualFillToPosition = (
    state: VirtualPositionState,
    source: VirtualFill
): VirtualPositionState => {
    const fill = canonicalFill(source);
    if (fill.virtualAccountId !== state.virtualAccountId || fill.instrumentId !== state.instrumentId) {
        throw new Error('fill position identity mismatch');
    }
    if (fill.lotSize !== state.lotSize) throw new Error('fill lot size mismatch');
    const fingerprint = fillFingerprint(fill);
    const existing = state.appliedFills.get(fill.id);
    if (existing) {
        if (existing !== fingerprint) throw new Error(`virtual fill ID conflict: ${fill.id}`);
        return state;
    }

    const currentEntries = state.appliedFills instanceof FrozenFillFingerprintIndex
        ? state.appliedFills.entries()
        : [];
    const appliedFills = new FrozenFillFingerprintIndex([
        ...currentEntries,
        [fill.id, fingerprint]
    ]);
    if (fill.side === 'buy') {
        const lot = Object.freeze({
            fillId: fill.id,
            acquiredAt: fill.filledAt,
            quantityLots: fill.quantityLots,
            costKopecks: fill.grossAmountKopecks + fill.feeKopecks
        });
        return Object.freeze({
            ...state,
            openLots: Object.freeze([...state.openLots, lot]),
            appliedFills
        });
    }

    const ownedLots = state.openLots.reduce((sum, lot) => sum + lot.quantityLots, 0);
    if (ownedLots < fill.quantityLots) throw new Error('sell fill exceeds long-only position');
    let remainingToSell = fill.quantityLots;
    let removedCost = 0n;
    const openLots: VirtualPositionLot[] = [];
    for (const lot of state.openLots) {
        if (remainingToSell === 0) {
            openLots.push(lot);
            continue;
        }
        const sold = Math.min(remainingToSell, lot.quantityLots);
        const allocatedCost = sold === lot.quantityLots
            ? lot.costKopecks
            : lot.costKopecks * BigInt(sold) / BigInt(lot.quantityLots);
        removedCost += allocatedCost;
        remainingToSell -= sold;
        if (sold < lot.quantityLots) {
            openLots.push(Object.freeze({
                ...lot,
                quantityLots: lot.quantityLots - sold,
                costKopecks: lot.costKopecks - allocatedCost
            }));
        }
    }
    const netProceeds = fill.grossAmountKopecks - fill.feeKopecks;
    return Object.freeze({
        ...state,
        openLots: Object.freeze(openLots),
        realizedPnlKopecks: state.realizedPnlKopecks + netProceeds - removedCost,
        appliedFills
    });
};

export const markVirtualPosition = (
    state: VirtualPositionState,
    markPriceKopecks: bigint
): VirtualPositionMarkToMarket => {
    if (typeof markPriceKopecks !== 'bigint' || markPriceKopecks < 0n) {
        throw new TypeError('markPriceKopecks must be a non-negative bigint');
    }
    const quantityLots = state.openLots.reduce((sum, lot) => sum + lot.quantityLots, 0);
    const costBasisKopecks = state.openLots.reduce((sum, lot) => sum + lot.costKopecks, 0n);
    const marketValueKopecks = markPriceKopecks * BigInt(state.lotSize) * BigInt(quantityLots);
    return Object.freeze({
        quantityLots,
        costBasisKopecks,
        marketValueKopecks,
        realizedPnlKopecks: state.realizedPnlKopecks,
        unrealizedPnlKopecks: marketValueKopecks - costBasisKopecks
    });
};
