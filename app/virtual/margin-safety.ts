import { normalizeRfc3339Timestamp } from './codecs';
import {
    applyMarginScenarioEvent,
    marginRiskSnapshot,
    MarginPositionState,
    MarginScenarioState
} from './margin';

export type MarginSafetyMode = 'normal' | 'reduce-only' | 'liquidating' | 'resolved';

export interface MarginSafetyPolicy {
    readonly liquidationFeeKopecks: bigint;
    readonly liquidationSlippageBps: number;
}

interface MarginSafetyCommandBase {
    readonly id: string;
    readonly scenarioId: string;
    readonly virtualAccountId: string;
    readonly occurredAt: string;
}

export interface MarginSafetyEvaluateCommand extends MarginSafetyCommandBase {
    readonly kind: 'evaluate';
}

export interface MarginSafetyReduceCommand extends MarginSafetyCommandBase {
    readonly kind: 'reduce';
    readonly instrumentId: string;
    readonly quantityLots: number;
    readonly executionPriceKopecks: bigint;
    readonly feeKopecks: bigint;
}

export interface MarginLiquidationQuote {
    readonly instrumentId: string;
    readonly priceKopecks: bigint;
    readonly observedAt: string;
    readonly failure?: 'reject';
}

export interface MarginSafetyLiquidateCommand extends MarginSafetyCommandBase {
    readonly kind: 'liquidate';
    readonly quotes: readonly MarginLiquidationQuote[];
}

export type MarginSafetyCommand =
    | MarginSafetyEvaluateCommand
    | MarginSafetyReduceCommand
    | MarginSafetyLiquidateCommand;

export interface MarginSafetyAuditEntry {
    readonly commandId: string;
    readonly occurredAt: string;
    readonly kind: MarginSafetyCommand['kind'];
    readonly fingerprint: string;
    readonly outcome: 'applied' | 'rejected';
    readonly from: MarginSafetyMode;
    readonly to: MarginSafetyMode;
    readonly reason: string;
    readonly instrumentId?: string;
    readonly quantityLots?: number;
    readonly executionPriceKopecks?: bigint;
    readonly feeKopecks?: bigint;
    readonly slippageKopecks?: bigint;
}

export interface MarginSafetyState {
    readonly scenarioId: string;
    readonly virtualAccountId: string;
    readonly mode: MarginSafetyMode;
    readonly margin: MarginScenarioState;
    readonly policy: MarginSafetyPolicy;
    readonly audit: readonly MarginSafetyAuditEntry[];
}

export interface MarginSafetyApplyResult {
    readonly state: MarginSafetyState;
    readonly outcome: 'applied' | 'rejected' | 'idempotent';
    readonly reason: string;
}

const requireId = (value: string, field: string) => {
    if (typeof value !== 'string' || !value || value.trim() !== value) {
        throw new TypeError(`${field} must be trimmed and non-empty`);
    }
};

const requireMoney = (value: bigint, field: string, positive = false) => {
    if (typeof value !== 'bigint' || value < 0n || (positive && value === 0n)) {
        throw new TypeError(`${field} must be ${positive ? 'positive' : 'non-negative'} bigint`);
    }
};

const fingerprint = (command: MarginSafetyCommand) => JSON.stringify(command, (_key, value) =>
    typeof value === 'bigint' ? value.toString() : value
);

const validatePolicy = (policy: MarginSafetyPolicy) => {
    requireMoney(policy.liquidationFeeKopecks, 'liquidationFeeKopecks');
    if (!Number.isSafeInteger(policy.liquidationSlippageBps)
        || policy.liquidationSlippageBps < 0 || policy.liquidationSlippageBps > 10_000) {
        throw new TypeError('liquidationSlippageBps is invalid');
    }
};

const markFailure = (margin: MarginScenarioState, at: string) => {
    const now = Date.parse(at);
    for (const position of margin.positions) {
        if (!position.markObservedAt || position.markPriceKopecks <= 0n) {
            return `missing mark: ${position.instrumentId}`;
        }
        const observed = Date.parse(position.markObservedAt);
        if (!Number.isFinite(observed)) return `missing mark: ${position.instrumentId}`;
        if (observed > now) return `future mark: ${position.instrumentId}`;
        if (now - observed > margin.policy.markMaxAgeSeconds * 1000) {
            return `stale mark: ${position.instrumentId}`;
        }
    }
    return undefined;
};

const riskMode = (margin: MarginScenarioState): MarginSafetyMode => {
    if (margin.positions.length === 0) return 'resolved';
    const risk = marginRiskSnapshot(margin);
    if (!risk.maintenanceSatisfied) return 'liquidating';
    if (!risk.fundsSufficient) return 'reduce-only';
    return 'normal';
};

const audit = (
    state: MarginSafetyState,
    command: MarginSafetyCommand,
    commandFingerprint: string,
    outcome: 'applied' | 'rejected',
    to: MarginSafetyMode,
    reason: string,
    details: Partial<MarginSafetyAuditEntry> = {}
): MarginSafetyState => Object.freeze({
    ...state,
    mode: to,
    audit: Object.freeze([...state.audit, Object.freeze({
        commandId: command.id,
        occurredAt: command.occurredAt,
        kind: command.kind,
        fingerprint: commandFingerprint,
        outcome,
        from: state.mode,
        to,
        reason,
        ...details
    })])
});

const result = (
    state: MarginSafetyState,
    outcome: MarginSafetyApplyResult['outcome'],
    reason: string
): MarginSafetyApplyResult => Object.freeze({ state, outcome, reason });

const quoteMap = (command: MarginSafetyLiquidateCommand) => {
    const quotes = new Map<string, MarginLiquidationQuote>();
    for (const quote of command.quotes) {
        requireId(quote.instrumentId, 'quote.instrumentId');
        requireMoney(quote.priceKopecks, 'quote.priceKopecks', true);
        const observedAt = normalizeRfc3339Timestamp(quote.observedAt);
        if (quotes.has(quote.instrumentId)) throw new Error(`duplicate liquidation quote: ${quote.instrumentId}`);
        quotes.set(quote.instrumentId, Object.freeze({ ...quote, observedAt }));
    }
    return quotes;
};

const liquidationOrder = (positions: readonly MarginPositionState[]) => [...positions].sort((left, right) => {
    const leftValue = left.markPriceKopecks * BigInt(left.lotSize) * BigInt(left.quantityLots);
    const rightValue = right.markPriceKopecks * BigInt(right.lotSize) * BigInt(right.quantityLots);
    if (leftValue !== rightValue) return leftValue > rightValue ? -1 : 1;
    return left.instrumentId.localeCompare(right.instrumentId);
});

export const openMarginSafety = (
    margin: MarginScenarioState,
    policy: MarginSafetyPolicy,
    at: string = margin.lastEventAt
): MarginSafetyState => {
    validatePolicy(policy);
    const occurredAt = normalizeRfc3339Timestamp(at);
    const failure = markFailure(margin, occurredAt);
    return Object.freeze({
        scenarioId: margin.scenarioId,
        virtualAccountId: margin.virtualAccountId,
        mode: failure ? 'reduce-only' : riskMode(margin),
        margin,
        policy: Object.freeze({ ...policy }),
        audit: Object.freeze([])
    });
};

export const applyMarginSafetyCommand = (
    source: MarginSafetyState,
    sourceCommand: MarginSafetyCommand
): MarginSafetyApplyResult => {
    validatePolicy(source.policy);
    requireId(sourceCommand.id, 'command.id');
    const command = Object.freeze({
        ...sourceCommand,
        occurredAt: normalizeRfc3339Timestamp(sourceCommand.occurredAt)
    }) as MarginSafetyCommand;
    if (command.scenarioId !== source.scenarioId || command.virtualAccountId !== source.virtualAccountId) {
        throw new Error('margin safety scenario isolation violation');
    }
    const commandFingerprint = fingerprint(command);
    const existing = source.audit.find(entry => entry.commandId === command.id);
    if (existing) {
        if (existing.fingerprint !== commandFingerprint) throw new Error(`margin safety command ID conflict: ${command.id}`);
        return result(source, 'idempotent', existing.reason);
    }

    const markError = markFailure(source.margin, command.occurredAt);
    if (command.kind === 'evaluate' && markError) {
        return result(audit(source, command, commandFingerprint, 'rejected', 'reduce-only', markError), 'rejected', markError);
    }

    if (command.kind === 'evaluate') {
        const to = riskMode(source.margin);
        const reason = to === 'normal' ? 'initial and maintenance margin satisfied'
            : to === 'reduce-only' ? 'initial margin breached'
                : to === 'liquidating' ? 'maintenance margin breached' : 'no exposure remains';
        return result(audit(source, command, commandFingerprint, 'applied', to, reason), 'applied', reason);
    }

    if (command.kind === 'reduce') {
        if (source.mode === 'resolved') {
            const reason = 'resolved scenario has no reducible exposure';
            return result(audit(source, command, commandFingerprint, 'rejected', source.mode, reason), 'rejected', reason);
        }
        if (!Number.isSafeInteger(command.quantityLots) || command.quantityLots <= 0) {
            throw new TypeError('quantityLots must be a positive safe integer');
        }
        requireMoney(command.executionPriceKopecks, 'executionPriceKopecks', true);
        requireMoney(command.feeKopecks, 'feeKopecks');
        const applied = applyMarginScenarioEvent(source.margin, {
            id: `margin-safety:${command.id}`,
            kind: 'sell',
            occurredAt: command.occurredAt,
            instrumentId: command.instrumentId,
            quantityLots: command.quantityLots,
            executionPriceKopecks: command.executionPriceKopecks,
            feeKopecks: command.feeKopecks
        });
        if (applied.outcome === 'rejected') {
            const reason = `reduce rejected: ${applied.reason ?? 'margin engine rejection'}`;
            return result(audit(source, command, commandFingerprint, 'rejected', source.mode, reason), 'rejected', reason);
        }
        const next = Object.freeze({ ...source, margin: applied.state });
        const to = riskMode(applied.state);
        const reason = to === 'liquidating' ? 'reduce applied; maintenance margin remains breached'
            : to === 'resolved' ? 'reduce applied; exposure resolved' : 'reduce applied; margin restored';
        return result(audit(next, command, commandFingerprint, 'applied', to, reason, {
            instrumentId: command.instrumentId,
            quantityLots: command.quantityLots,
            executionPriceKopecks: command.executionPriceKopecks,
            feeKopecks: command.feeKopecks
        }), 'applied', reason);
    }

    if (source.mode !== 'liquidating') {
        const reason = 'forced liquidation requires liquidating state';
        return result(audit(source, command, commandFingerprint, 'rejected', source.mode, reason), 'rejected', reason);
    }

    const quotes = quoteMap(command);
    for (const position of liquidationOrder(source.margin.positions)) {
        const quote = quotes.get(position.instrumentId);
        if (!quote) {
            const reason = `missing liquidation quote: ${position.instrumentId}`;
            return result(audit(source, command, commandFingerprint, 'rejected', 'liquidating', reason), 'rejected', reason);
        }
        const quoteAge = Date.parse(command.occurredAt) - Date.parse(quote.observedAt);
        if (quoteAge < 0 || quoteAge > source.margin.policy.markMaxAgeSeconds * 1000) {
            const reason = `${quoteAge < 0 ? 'future' : 'stale'} liquidation quote: ${position.instrumentId}`;
            return result(audit(source, command, commandFingerprint, 'rejected', 'liquidating', reason), 'rejected', reason);
        }
        if (quote.failure === 'reject') {
            const reason = `liquidation execution rejected: ${position.instrumentId}`;
            return result(audit(source, command, commandFingerprint, 'rejected', 'liquidating', reason), 'rejected', reason);
        }
    }
    let next = source;
    for (const position of liquidationOrder(source.margin.positions)) {
        if (marginRiskSnapshot(next.margin).maintenanceSatisfied) break;
        const quote = quotes.get(position.instrumentId);
        if (!quote) throw new Error(`prevalidated liquidation quote missing: ${position.instrumentId}`);
        const slippageNumerator = quote.priceKopecks * BigInt(next.policy.liquidationSlippageBps);
        const slippageKopecks = slippageNumerator === 0n ? 0n : (slippageNumerator + 9_999n) / 10_000n;
        if (slippageKopecks >= quote.priceKopecks) {
            const reason = `liquidation slippage exhausted price: ${position.instrumentId}`;
            return result(audit(next, command, commandFingerprint, 'rejected', 'liquidating', reason), 'rejected', reason);
        }
        const executionPriceKopecks = quote.priceKopecks - slippageKopecks;
        const applied = applyMarginScenarioEvent(next.margin, {
            id: `forced-liquidation:${command.id}:${position.instrumentId}`,
            kind: 'sell',
            occurredAt: command.occurredAt,
            instrumentId: position.instrumentId,
            quantityLots: position.quantityLots,
            executionPriceKopecks,
            feeKopecks: next.policy.liquidationFeeKopecks
        });
        if (applied.outcome === 'rejected') {
            const reason = `liquidation sell rejected: ${position.instrumentId}: ${applied.reason ?? 'unknown'}`;
            return result(audit(next, command, commandFingerprint, 'rejected', 'liquidating', reason), 'rejected', reason);
        }
        next = audit(Object.freeze({ ...next, margin: applied.state }), command, commandFingerprint, 'applied', 'liquidating',
            `forced liquidation reduced ${position.instrumentId}`, {
                instrumentId: position.instrumentId,
                quantityLots: position.quantityLots,
                executionPriceKopecks,
                feeKopecks: next.policy.liquidationFeeKopecks,
                slippageKopecks
            });
    }
    const to: MarginSafetyMode = marginRiskSnapshot(next.margin).maintenanceSatisfied || next.margin.positions.length === 0
        ? 'resolved' : 'liquidating';
    const reason = to === 'resolved' ? 'forced liquidation resolved maintenance breach'
        : 'forced liquidation exhausted candidates without restoring maintenance margin';
    return result(audit(next, command, commandFingerprint, 'applied', to, reason), 'applied', reason);
};

export const replayMarginSafety = (
    initial: MarginSafetyState,
    commands: readonly MarginSafetyCommand[]
): MarginSafetyState => commands.reduce((state, command) => applyMarginSafetyCommand(state, command).state, initial);
