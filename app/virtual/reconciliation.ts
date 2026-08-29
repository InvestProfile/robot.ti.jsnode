import type { VirtualFill } from './execution';
import type { VirtualCashAccountState } from './types';
import { validateVirtualCashAccountState } from './ledger';
import { markVirtualPosition } from './positions';
import { replayVirtualPositions } from './position-repository';

export interface VirtualInstrumentMark {
    readonly instrumentId: string;
    readonly priceKopecks: bigint;
}

export interface VirtualAccountReconciliation {
    readonly cashKopecks: bigint;
    readonly positionsValueKopecks: bigint;
    readonly equityKopecks: bigint;
    readonly contributionsKopecks: bigint;
    readonly interestKopecks: bigint;
    readonly realizedPnlKopecks: bigint;
    readonly unrealizedPnlKopecks: bigint;
    readonly feesKopecks: bigint;
    readonly turnoverKopecks: bigint;
    readonly fillCount: number;
    readonly openPositionCount: number;
}

export const reconcileVirtualAccount = (
    account: VirtualCashAccountState,
    fills: readonly VirtualFill[],
    marks: readonly VirtualInstrumentMark[]
): VirtualAccountReconciliation => {
    validateVirtualCashAccountState(account);
    const portfolio = replayVirtualPositions(account.virtualAccountId, fills);
    const marksByInstrument = new Map<string, bigint>();
    for (const mark of marks) {
        if (marksByInstrument.has(mark.instrumentId)) throw new Error(`duplicate position mark: ${mark.instrumentId}`);
        if (typeof mark.priceKopecks !== 'bigint' || mark.priceKopecks < 0n) {
            throw new TypeError('mark price must be a non-negative bigint');
        }
        marksByInstrument.set(mark.instrumentId, mark.priceKopecks);
    }

    const entriesById = new Map(account.entries.map(entry => [entry.id, entry]));
    for (const fill of portfolio.fills) {
        const cash = entriesById.get(`${fill.orderId}:cash`);
        if (!cash || cash.kind !== 'trade-cash' || cash.tradeReference !== fill.id
            || cash.amountKopecks !== fill.grossAmountKopecks
            || cash.direction !== (fill.side === 'buy' ? 'debit' : 'credit')) {
            throw new Error(`fill cash ledger mismatch: ${fill.id}`);
        }
        const fee = entriesById.get(`${fill.orderId}:fee`);
        if (fill.feeKopecks > 0n && (!fee || fee.kind !== 'fee' || fee.amountKopecks !== fill.feeKopecks)) {
            throw new Error(`fill fee ledger mismatch: ${fill.id}`);
        }
        if (fill.feeKopecks === 0n && fee) throw new Error(`unexpected fill fee ledger event: ${fill.id}`);
    }
    const fillIds = new Set(portfolio.fills.map(fill => fill.id));
    for (const entry of account.entries) {
        if (entry.kind === 'trade-cash' && !fillIds.has(entry.tradeReference)) {
            throw new Error(`orphan trade cash ledger event: ${entry.id}`);
        }
    }

    let positionsValueKopecks = 0n;
    let realizedPnlKopecks = 0n;
    let unrealizedPnlKopecks = 0n;
    for (const position of portfolio.positions) {
        const quantityLots = position.openLots.reduce((sum, lot) => sum + lot.quantityLots, 0);
        const mark = marksByInstrument.get(position.instrumentId);
        if (quantityLots > 0 && mark === undefined) throw new Error(`missing position mark: ${position.instrumentId}`);
        const valuation = markVirtualPosition(position, mark ?? 0n);
        positionsValueKopecks += valuation.marketValueKopecks;
        realizedPnlKopecks += valuation.realizedPnlKopecks;
        unrealizedPnlKopecks += valuation.unrealizedPnlKopecks;
    }
    const contributionsKopecks = account.entries
        .filter(entry => entry.kind === 'account-opened' || entry.kind === 'deposit')
        .reduce((sum, entry) => sum + entry.amountKopecks, 0n);
    const interestKopecks = account.entries
        .filter(entry => entry.kind === 'interest')
        .reduce((sum, entry) => sum + entry.amountKopecks, 0n);
    const equityKopecks = account.cashKopecks + positionsValueKopecks;
    const expectedEquity = contributionsKopecks - interestKopecks
        + realizedPnlKopecks + unrealizedPnlKopecks;
    if (equityKopecks !== expectedEquity) {
        throw new Error(`virtual account reconciliation mismatch: equity ${equityKopecks} expected ${expectedEquity}`);
    }
    const feesKopecks = portfolio.fills.reduce((sum, fill) => sum + fill.feeKopecks, 0n);
    const turnoverKopecks = portfolio.fills.reduce((sum, fill) => sum + fill.grossAmountKopecks, 0n);
    const openPositionCount = portfolio.positions.filter(position =>
        position.openLots.some(lot => lot.quantityLots > 0)
    ).length;
    return Object.freeze({
        cashKopecks: account.cashKopecks,
        positionsValueKopecks,
        equityKopecks,
        contributionsKopecks,
        interestKopecks,
        realizedPnlKopecks,
        unrealizedPnlKopecks,
        feesKopecks,
        turnoverKopecks,
        fillCount: portfolio.fills.length,
        openPositionCount
    });
};
