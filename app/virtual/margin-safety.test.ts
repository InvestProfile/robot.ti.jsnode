import assert from 'node:assert/strict';
import test from 'node:test';
import {
    applyMarginSafetyCommand,
    MarginSafetyPolicy,
    openMarginSafety,
    replayMarginSafety
} from './margin-safety';
import { MarginScenarioState, marginRiskSnapshot } from './margin';

const policy: MarginSafetyPolicy = Object.freeze({
    liquidationFeeKopecks: 2n,
    liquidationSlippageBps: 100
});

const margin = (overrides: Partial<MarginScenarioState> = {}): MarginScenarioState => Object.freeze({
    scenarioId: 'account:1.5x',
    virtualAccountId: 'account',
    policy: Object.freeze({
        leverage: '1.5x', version: 'test', initialMarginBps: 6_667,
        maintenanceMarginBps: 5_000, annualInterestBps: 1_800,
        allowBorrowedAveragingDown: false, markMaxAgeSeconds: 300
    }),
    openedAt: '2026-01-01T00:00:00.000Z',
    lastEventAt: '2026-01-01T00:00:00.000Z',
    interestAccruedThroughAt: '2026-01-01T00:00:00.000Z',
    cashKopecks: 0n,
    debtKopecks: 700n,
    accruedInterestKopecks: 0n,
    interestRemainderNumerator: 0n,
    realizedPnlKopecks: 0n,
    positions: Object.freeze([
        Object.freeze({ instrumentId: 'BBB', lotSize: 1, quantityLots: 5, costBasisKopecks: 600n, markPriceKopecks: 100n, markObservedAt: '2026-01-01T00:00:00.000Z' }),
        Object.freeze({ instrumentId: 'AAA', lotSize: 1, quantityLots: 5, costBasisKopecks: 600n, markPriceKopecks: 100n, markObservedAt: '2026-01-01T00:00:00.000Z' })
    ]),
    audit: Object.freeze([]),
    ...overrides
});

const base = () => openMarginSafety(margin(), policy);

test('enters explicit liquidating state on maintenance breach', () => {
    const state = base();
    assert.equal(state.mode, 'liquidating');
    const result = applyMarginSafetyCommand(state, {
        id: 'evaluate-1', kind: 'evaluate', scenarioId: state.scenarioId,
        virtualAccountId: state.virtualAccountId, occurredAt: state.margin.lastEventAt
    });
    assert.equal(result.state.mode, 'liquidating');
    assert.match(result.reason, /maintenance margin breached/);
});

test('fails closed into reduce-only for stale or missing marks', () => {
    const stale = openMarginSafety(margin(), policy, '2026-01-01T00:06:00.000Z');
    assert.equal(stale.mode, 'reduce-only');
    const result = applyMarginSafetyCommand(stale, {
        id: 'stale', kind: 'evaluate', scenarioId: stale.scenarioId,
        virtualAccountId: stale.virtualAccountId, occurredAt: '2026-01-01T00:06:00.000Z'
    });
    assert.equal(result.outcome, 'rejected');
    assert.equal(result.state.mode, 'reduce-only');
    assert.match(result.reason, /stale mark/);

    const missing = margin({ positions: Object.freeze([{ ...margin().positions[0], markObservedAt: '' }]) });
    const missingState = openMarginSafety(missing, policy);
    assert.equal(missingState.mode, 'reduce-only');
});

test('reduce-only cannot sell beyond exposure or create a short', () => {
    const state = base();
    const result = applyMarginSafetyCommand(state, {
        id: 'too-many', kind: 'reduce', scenarioId: state.scenarioId,
        virtualAccountId: state.virtualAccountId, occurredAt: state.margin.lastEventAt,
        instrumentId: 'AAA', quantityLots: 6, executionPriceKopecks: 100n, feeKopecks: 0n
    });
    assert.equal(result.outcome, 'rejected');
    assert.equal(result.state.margin.positions.find(item => item.instrumentId === 'AAA')?.quantityLots, 5);
    assert.match(result.reason, /sell exceeds long-only position/);
});

test('stale marks fail closed to reduce-only but do not block explicit exposure reduction', () => {
    const state = openMarginSafety(margin({ debtKopecks: 0n }), policy, '2026-01-01T00:06:00.000Z');
    const reduced = applyMarginSafetyCommand(state, {
        id: 'stale-reduce', kind: 'reduce', scenarioId: state.scenarioId,
        virtualAccountId: state.virtualAccountId, occurredAt: '2026-01-01T00:06:00.000Z',
        instrumentId: 'AAA', quantityLots: 1, executionPriceKopecks: 99n, feeKopecks: 1n
    });
    assert.equal(reduced.outcome, 'applied');
    assert.equal(reduced.state.margin.positions.find(item => item.instrumentId === 'AAA')?.quantityLots, 4);
});

test('forced liquidation uses stable value then instrument tie-break and explicit costs', () => {
    const state = base();
    const result = applyMarginSafetyCommand(state, {
        id: 'liquidate-1', kind: 'liquidate', scenarioId: state.scenarioId,
        virtualAccountId: state.virtualAccountId, occurredAt: state.margin.lastEventAt,
        quotes: [
            { instrumentId: 'BBB', priceKopecks: 100n, observedAt: state.margin.lastEventAt },
            { instrumentId: 'AAA', priceKopecks: 100n, observedAt: state.margin.lastEventAt }
        ]
    });
    assert.equal(result.outcome, 'applied');
    const fills = result.state.audit.filter(entry => entry.instrumentId);
    assert.equal(fills[0].instrumentId, 'AAA');
    assert.equal(fills[0].executionPriceKopecks, 99n);
    assert.equal(fills[0].slippageKopecks, 1n);
    assert.equal(fills[0].feeKopecks, 2n);
    assert.ok(result.state.margin.positions.length < state.margin.positions.length);
    assert.equal(result.state.mode, 'resolved');
    assert.equal(marginRiskSnapshot(result.state.margin).maintenanceSatisfied, true);
});

test('rounds fractional liquidation slippage up conservatively', () => {
    const state = openMarginSafety(margin({ positions: Object.freeze([
        Object.freeze({ instrumentId: 'AAA', lotSize: 1, quantityLots: 5, costBasisKopecks: 600n, markPriceKopecks: 101n, markObservedAt: '2026-01-01T00:00:00.000Z' })
    ]) }), policy);
    const result = applyMarginSafetyCommand(state, {
        id: 'ceil-slip', kind: 'liquidate', scenarioId: state.scenarioId,
        virtualAccountId: state.virtualAccountId, occurredAt: state.margin.lastEventAt,
        quotes: [{ instrumentId: 'AAA', priceKopecks: 101n, observedAt: state.margin.lastEventAt }]
    });
    assert.equal(result.state.audit.find(entry => entry.instrumentId === 'AAA')?.slippageKopecks, 2n);
});

test('forced liquidation is idempotent and replay deterministic', () => {
    const state = base();
    const command = {
        id: 'liquidate-replay', kind: 'liquidate' as const, scenarioId: state.scenarioId,
        virtualAccountId: state.virtualAccountId, occurredAt: state.margin.lastEventAt,
        quotes: [
            { instrumentId: 'AAA', priceKopecks: 100n, observedAt: state.margin.lastEventAt },
            { instrumentId: 'BBB', priceKopecks: 100n, observedAt: state.margin.lastEventAt }
        ]
    };
    const once = applyMarginSafetyCommand(state, command);
    const twice = applyMarginSafetyCommand(once.state, command);
    assert.equal(twice.outcome, 'idempotent');
    assert.deepEqual(twice.state, once.state);
    assert.deepEqual(replayMarginSafety(state, [command]), once.state);
    assert.throws(() => applyMarginSafetyCommand(once.state, { ...command, quotes: [] }), /command ID conflict/);
});

test('failure injection remains liquidating and records an audit reason', () => {
    const state = base();
    const result = applyMarginSafetyCommand(state, {
        id: 'failure', kind: 'liquidate', scenarioId: state.scenarioId,
        virtualAccountId: state.virtualAccountId, occurredAt: state.margin.lastEventAt,
        quotes: [
            { instrumentId: 'AAA', priceKopecks: 100n, observedAt: state.margin.lastEventAt, failure: 'reject' },
            { instrumentId: 'BBB', priceKopecks: 100n, observedAt: state.margin.lastEventAt }
        ]
    });
    assert.equal(result.outcome, 'rejected');
    assert.equal(result.state.mode, 'liquidating');
    assert.equal(result.state.margin, state.margin);
    assert.match(result.state.audit.at(-1)?.reason ?? '', /execution rejected: AAA/);
});

test('prevalidates a later liquidation failure before applying any reduction', () => {
    const state = base();
    const result = applyMarginSafetyCommand(state, {
        id: 'later-failure', kind: 'liquidate', scenarioId: state.scenarioId,
        virtualAccountId: state.virtualAccountId, occurredAt: state.margin.lastEventAt,
        quotes: [
            { instrumentId: 'AAA', priceKopecks: 100n, observedAt: state.margin.lastEventAt },
            { instrumentId: 'BBB', priceKopecks: 100n, observedAt: state.margin.lastEventAt, failure: 'reject' }
        ]
    });
    assert.equal(result.outcome, 'rejected');
    assert.strictEqual(result.state.margin, state.margin);
    assert.equal(result.state.audit.filter(entry => entry.instrumentId).length, 0);
    assert.match(result.reason, /BBB/);
});

test('scenario identity is isolated', () => {
    const state = base();
    assert.throws(() => applyMarginSafetyCommand(state, {
        id: 'foreign', kind: 'evaluate', scenarioId: 'other',
        virtualAccountId: state.virtualAccountId, occurredAt: state.margin.lastEventAt
    }), /isolation violation/);
});
