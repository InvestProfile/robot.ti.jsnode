import type { VirtualFill } from './execution';
import {
    VirtualPositionState,
    applyVirtualFillToPosition,
    canonicalVirtualFill,
    emptyVirtualPosition
} from './positions';

export interface VirtualPositionPortfolio {
    readonly virtualAccountId: string;
    readonly fills: readonly VirtualFill[];
    readonly positions: readonly VirtualPositionState[];
}

export interface VirtualPositionRepository {
    load(virtualAccountId: string): Promise<VirtualPositionPortfolio>;
}

export const replayVirtualPositions = (
    virtualAccountId: string,
    fills: readonly VirtualFill[]
): VirtualPositionPortfolio => {
    if (typeof virtualAccountId !== 'string' || virtualAccountId.length === 0
        || virtualAccountId.trim() !== virtualAccountId) {
        throw new TypeError('virtualAccountId must be a trimmed non-empty string');
    }
    if (!Array.isArray(fills)) throw new TypeError('fills must be an array');
    const positions = new Map<string, VirtualPositionState>();
    const canonicalFills: VirtualFill[] = [];
    for (const source of fills) {
        const fill = canonicalVirtualFill(source);
        if (fill.virtualAccountId !== virtualAccountId) throw new Error('fills contain multiple virtual accounts');
        const before = positions.get(fill.instrumentId)
            ?? emptyVirtualPosition(virtualAccountId, fill.instrumentId, fill.lotSize);
        const after = applyVirtualFillToPosition(before, fill);
        positions.set(fill.instrumentId, after);
        if (after !== before) canonicalFills.push(fill);
    }
    return Object.freeze({
        virtualAccountId,
        fills: Object.freeze(canonicalFills),
        positions: Object.freeze(Array.from(positions.values()))
    });
};

export class InMemoryVirtualPositionRepository implements VirtualPositionRepository {
    constructor(private readonly fills: readonly VirtualFill[]) {}

    async load(virtualAccountId: string) {
        return replayVirtualPositions(virtualAccountId,
            this.fills.filter(fill => fill.virtualAccountId === virtualAccountId));
    }
}
