import {
    ImmutablePositionMark,
    VirtualAccountValuation,
    VirtualCashAccountState
} from './types';
import { validateVirtualCashAccountState } from './ledger';

export const valueVirtualAccount = (
    account: VirtualCashAccountState,
    marks: readonly ImmutablePositionMark[]
): VirtualAccountValuation => {
    validateVirtualCashAccountState(account);
    if (!Array.isArray(marks)) throw new TypeError('position marks must be an array');

    const instrumentIds = new Set<string>();
    let positionsValueKopecks = 0n;
    for (const mark of marks) {
        if (!mark || typeof mark !== 'object') throw new TypeError('position mark must be an object');
        if (typeof mark.instrumentId !== 'string' || mark.instrumentId.trim().length === 0) {
            throw new TypeError('position mark instrumentId must be a non-empty string');
        }
        if (instrumentIds.has(mark.instrumentId)) throw new Error(`duplicate position mark: ${mark.instrumentId}`);
        if (typeof mark.marketValueKopecks !== 'bigint' || mark.marketValueKopecks < 0n) {
            throw new TypeError('long-only position mark marketValueKopecks must be a non-negative bigint');
        }
        instrumentIds.add(mark.instrumentId);
        positionsValueKopecks += mark.marketValueKopecks;
    }

    return Object.freeze({
        cashKopecks: account.cashKopecks,
        positionsValueKopecks,
        equityKopecks: account.cashKopecks + positionsValueKopecks
    });
};
