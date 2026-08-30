import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    DEFAULT_MARGIN_SCENARIO_POLICIES,
    MARGIN_INTEREST_DENOMINATOR,
    MarginScenarioEvent,
    applyMarginScenarioEvent,
    applyParallelMarginEvent,
    marginRiskSnapshot,
    openDefaultMarginScenarios,
    openMarginScenario,
    replayMarginScenario
} from './margin';

const openedAt = '2026-08-30T10:00:00Z';
const policy = (leverage: '1x' | '1.2x' | '1.5x') =>
    DEFAULT_MARGIN_SCENARIO_POLICIES.find(item => item.leverage === leverage)!;
const open = (leverage: '1x' | '1.2x' | '1.5x' = '1.5x', cash = 10_000n) => openMarginScenario({
    scenarioId: `paper:${leverage}`, virtualAccountId: 'paper', startingCashKopecks: cash,
    openedAt, policy: policy(leverage)
});
const buy = (id: string, amount: bigint, occurredAt = openedAt): MarginScenarioEvent => ({
    id, kind: 'buy', occurredAt, instrumentId: 'SBER', lotSize: 1,
    quantityLots: 1, executionPriceKopecks: amount, feeKopecks: 0n
});

describe('deterministic margin scenario engine', () => {
    it('keeps immutable versioned policies and exact 1x no-debt parity', () => {
        const initial = open('1x', 100n);
        assert(Object.isFrozen(initial.policy));
        assert.equal(initial.policy.version, 'pm06-v1');
        const cashBuy = applyMarginScenarioEvent(initial, buy('cash', 100n));
        assert.equal(cashBuy.outcome, 'applied');
        assert.equal(cashBuy.state.cashKopecks, 0n);
        assert.equal(cashBuy.state.debtKopecks, 0n);
        const debtBuy = applyMarginScenarioEvent(initial, buy('debt', 101n));
        assert.equal(debtBuy.outcome, 'rejected');
        assert.match(debtBuy.reason!, /1x/);
        assert.equal(debtBuy.state.debtKopecks, 0n);
    });

    it('uses ceil requirements and floor buying power at exact leverage boundaries', () => {
        const initial = open('1.2x', 100n);
        assert.equal(marginRiskSnapshot(initial).buyingPowerKopecks, 119n);
        const accepted = applyMarginScenarioEvent(initial, buy('edge-ok', 119n));
        assert.equal(accepted.outcome, 'applied');
        assert.equal(accepted.state.debtKopecks, 19n);
        assert.equal(accepted.risk.initialRequirementKopecks, 100n);
        const rejected = applyMarginScenarioEvent(initial, buy('edge-no', 120n));
        assert.equal(rejected.outcome, 'rejected');
        assert.match(rejected.reason!, /initial margin/);
    });

    it('tracks debt explicitly, accrues conservative interest on deterministic virtual time and is idempotent', () => {
        const first = applyMarginScenarioEvent(open('1.5x', 100n), buy('levered', 149n));
        assert.equal(first.outcome, 'applied');
        assert.equal(first.state.cashKopecks, 0n);
        assert.equal(first.state.debtKopecks, 49n);
        const interest: MarginScenarioEvent = {
            id: 'interest-year', kind: 'interest', occurredAt: '2027-08-30T10:00:00Z',
            fromAt: openedAt, toAt: '2027-08-30T10:00:00Z'
        };
        const accrued = applyMarginScenarioEvent(first.state, interest);
        assert.equal(accrued.outcome, 'applied');
        assert.equal(accrued.state.accruedInterestKopecks, 8n);
        assert(accrued.state.interestRemainderNumerator > 0n);
        assert.equal(accrued.state.debtKopecks, 49n);
        assert.equal(accrued.risk.liabilitiesKopecks, 58n);
        const retry = applyMarginScenarioEvent(accrued.state, interest);
        assert.equal(retry.outcome, 'idempotent');
        assert.strictEqual(retry.state, accrued.state);
        assert.throws(() => applyMarginScenarioEvent(accrued.state, { ...interest, toAt: '2027-08-30T10:00:01Z', occurredAt: '2027-08-30T10:00:01Z' }), /ID conflict/);
    });

    it('rejects interest gaps and out-of-order events at virtual-time boundaries', () => {
        const state = applyMarginScenarioEvent(open('1.5x', 100n), buy('levered', 149n)).state;
        const gap = applyMarginScenarioEvent(state, {
            id: 'gap', kind: 'interest', occurredAt: '2026-08-30T12:00:00Z',
            fromAt: '2026-08-30T11:00:00Z', toAt: '2026-08-30T12:00:00Z'
        });
        assert.equal(gap.outcome, 'rejected');
        assert.match(gap.reason!, /boundary mismatch/);
        const old = applyMarginScenarioEvent(gap.state, buy('old', 1n, '2026-08-30T09:59:59Z'));
        assert.equal(old.outcome, 'rejected');
        assert.match(old.reason!, /out-of-order/);
    });

    it('blocks averaging down only when the new buy increases debt', () => {
        let state = applyMarginScenarioEvent(open('1.5x', 150n), buy('first', 80n)).state;
        state = applyMarginScenarioEvent(state, {
            id: 'down', kind: 'mark', occurredAt: '2026-08-30T10:01:00Z', observedAt: '2026-08-30T10:01:00Z',
            instrumentId: 'SBER', priceKopecks: 70n
        }).state;
        const cashOnly = applyMarginScenarioEvent(state, buy('cash-addon', 50n, '2026-08-30T10:02:00Z'));
        assert.equal(cashOnly.outcome, 'applied');
        const borrowed = applyMarginScenarioEvent(state, buy('borrowed-addon', 80n, '2026-08-30T10:02:00Z'));
        assert.equal(borrowed.outcome, 'rejected');
        assert.match(borrowed.reason!, /averaging down/);
    });

    it('fails closed for zero, future and stale marks before increasing exposure', () => {
        const state = applyMarginScenarioEvent(open('1.5x', 150n), buy('first', 80n)).state;
        assert.throws(() => applyMarginScenarioEvent(state, {
            id: 'zero', kind: 'mark', occurredAt: openedAt, observedAt: openedAt,
            instrumentId: 'SBER', priceKopecks: 0n
        }), /must be positive/);
        assert.throws(() => applyMarginScenarioEvent(state, {
            id: 'future', kind: 'mark', occurredAt: openedAt, observedAt: '2026-08-30T10:00:01Z',
            instrumentId: 'SBER', priceKopecks: 70n
        }), /future margin mark/);
        const stale = applyMarginScenarioEvent(state, buy('late', 1n, '2026-08-30T10:05:01Z'));
        assert.equal(stale.outcome, 'rejected');
        assert.match(stale.reason!, /stale mark/);
    });

    it('reports a price-shock maintenance breach without automatic liquidation', () => {
        const state = applyMarginScenarioEvent(open('1.5x', 100n), buy('levered', 149n)).state;
        const shock = applyMarginScenarioEvent(state, {
            id: 'shock', kind: 'mark', occurredAt: '2026-08-30T10:01:00Z', observedAt: '2026-08-30T10:01:00Z',
            instrumentId: 'SBER', priceKopecks: 80n
        });
        assert.equal(shock.outcome, 'applied');
        assert.equal(shock.risk.maintenanceSatisfied, false);
        assert.equal(shock.state.positions.length, 1, 'PM-06 must not auto-liquidate');
    });

    it('reconciles assets = equity + liabilities and repays debt on long-only sells', () => {
        let state = applyMarginScenarioEvent(open('1.5x', 100n), buy('levered', 149n)).state;
        state = applyMarginScenarioEvent(state, {
            id: 'interest-before-sell', kind: 'interest', occurredAt: '2026-08-30T10:01:00Z',
            fromAt: openedAt, toAt: '2026-08-30T10:01:00Z'
        }).state;
        const sold = applyMarginScenarioEvent(state, {
            id: 'sell', kind: 'sell', occurredAt: '2026-08-30T10:01:00Z', instrumentId: 'SBER',
            quantityLots: 1, executionPriceKopecks: 160n, feeKopecks: 1n
        });
        assert.equal(sold.outcome, 'applied');
        assert.equal(sold.state.debtKopecks, 0n);
        assert.equal(sold.state.cashKopecks, 109n);
        assert.equal(sold.risk.reconciled, true);
        assert.equal(sold.risk.assetsKopecks, sold.risk.equityKopecks + sold.risk.liabilitiesKopecks);
        const short = applyMarginScenarioEvent(sold.state, {
            id: 'short', kind: 'sell', occurredAt: '2026-08-30T10:02:00Z', instrumentId: 'SBER',
            quantityLots: 1, executionPriceKopecks: 160n, feeKopecks: 0n
        });
        assert.equal(short.outcome, 'rejected');
    });

    it('fans one event into isolated 1x/1.2x/1.5x states', () => {
        const initial = openDefaultMarginScenarios('paper', 100n, openedAt);
        const fanout = applyParallelMarginEvent(initial, buy('fanout', 130n));
        assert.deepEqual(fanout.results.map(result => result.outcome), ['rejected', 'rejected', 'applied']);
        assert.deepEqual(fanout.state.scenarios.map(state => state.debtKopecks), [0n, 0n, 30n]);
        assert.equal(new Set(fanout.state.scenarios.map(state => state.audit)).size, 3);
    });

    it('rejects malformed negative-liability state invariants', () => {
        const malformed = { ...open(), debtKopecks: -1n };
        assert.throws(() => marginRiskSnapshot(malformed), /non-negative bigint/);
    });

    it('replays exact audit events to identical restart state', () => {
        const initial = open('1.5x', 100n);
        const events: MarginScenarioEvent[] = [
            buy('levered', 149n),
            { id: 'mark', kind: 'mark', occurredAt: '2026-08-30T10:01:00Z', observedAt: '2026-08-30T10:01:00Z', instrumentId: 'SBER', priceKopecks: 140n },
            { id: 'interest', kind: 'interest', occurredAt: '2026-08-30T11:00:00Z', fromAt: openedAt, toAt: '2026-08-30T11:00:00Z' }
        ];
        const first = replayMarginScenario(initial, events);
        const restarted = replayMarginScenario(open('1.5x', 100n), events);
        assert.deepEqual(restarted, first);
        assert(first.audit.every(entry => Object.isFrozen(entry.event)));
    });

    it('keeps principal separate and does not compound adjacent-period interest', () => {
        let state = applyMarginScenarioEvent(open('1.5x', 100n), buy('principal', 149n)).state;
        const first = applyMarginScenarioEvent(state, {
            id: 'interest-1', kind: 'interest', occurredAt: '2027-08-30T10:00:00Z',
            fromAt: openedAt, toAt: '2027-08-30T10:00:00Z'
        });
        state = first.state;
        const second = applyMarginScenarioEvent(state, {
            id: 'interest-2', kind: 'interest', occurredAt: '2028-08-29T10:00:00Z',
            fromAt: '2027-08-30T10:00:00Z', toAt: '2028-08-29T10:00:00Z'
        });
        assert.equal(first.state.debtKopecks, 49n);
        assert.equal(second.state.debtKopecks, 49n);
        assert.equal(first.state.accruedInterestKopecks, 8n);
        assert.equal(second.state.accruedInterestKopecks, 17n);
        assert.equal(second.risk.liabilitiesKopecks, 67n);
        assert.equal(second.risk.assetsKopecks, second.risk.equityKopecks + second.risk.liabilitiesKopecks);
    });

    it('repays accrued interest first, then principal, then releases cash', () => {
        let state = applyMarginScenarioEvent(open('1.5x', 100n), {
            id: 'two-lots', kind: 'buy', occurredAt: openedAt, instrumentId: 'SBER', lotSize: 1,
            quantityLots: 2, executionPriceKopecks: 74n, feeKopecks: 0n
        }).state;
        state = applyMarginScenarioEvent(state, {
            id: 'interest', kind: 'interest', occurredAt: '2027-08-30T10:00:00Z',
            fromAt: openedAt, toAt: '2027-08-30T10:00:00Z'
        }).state;
        assert.equal(state.debtKopecks, 48n);
        assert.equal(state.accruedInterestKopecks, 8n);
        const partial = applyMarginScenarioEvent(state, {
            id: 'partial', kind: 'sell', occurredAt: '2027-08-30T10:00:00Z', instrumentId: 'SBER',
            quantityLots: 1, executionPriceKopecks: 30n, feeKopecks: 0n
        });
        assert.equal(partial.state.accruedInterestKopecks, 0n);
        assert.equal(partial.state.debtKopecks, 27n);
        assert.equal(partial.state.cashKopecks, 0n);
        const full = applyMarginScenarioEvent(partial.state, {
            id: 'full', kind: 'sell', occurredAt: '2027-08-30T10:00:00Z', instrumentId: 'SBER',
            quantityLots: 1, executionPriceKopecks: 100n, feeKopecks: 0n
        });
        assert.equal(full.state.accruedInterestKopecks, 0n);
        assert.equal(full.state.debtKopecks, 0n);
        assert.equal(full.state.cashKopecks, 73n);
        assert.equal(full.risk.reconciled, true);
    });

    it('enforces interest-mark-sell-buy ordering within one timestamp', () => {
        let state = applyMarginScenarioEvent(open('1.5x', 100n), buy('principal', 149n)).state;
        state = applyMarginScenarioEvent(state, {
            id: 'interest', kind: 'interest', occurredAt: '2026-08-30T11:00:00Z',
            fromAt: openedAt, toAt: '2026-08-30T11:00:00Z'
        }).state;
        state = applyMarginScenarioEvent(state, {
            id: 'mark', kind: 'mark', occurredAt: '2026-08-30T11:00:00Z', observedAt: '2026-08-30T11:00:00Z',
            instrumentId: 'SBER', priceKopecks: 149n
        }).state;
        const laterPhase = applyMarginScenarioEvent(state, {
            id: 'sell', kind: 'sell', occurredAt: '2026-08-30T11:00:00Z', instrumentId: 'SBER',
            quantityLots: 1, executionPriceKopecks: 149n, feeKopecks: 0n
        });
        assert.equal(laterPhase.outcome, 'applied');
        const phaseRegression = applyMarginScenarioEvent(laterPhase.state, {
            id: 'late-mark', kind: 'mark', occurredAt: '2026-08-30T11:00:00Z', observedAt: '2026-08-30T11:00:00Z',
            instrumentId: 'SBER', priceKopecks: 149n
        });
        assert.equal(phaseRegression.outcome, 'rejected');
        assert.match(phaseRegression.reason!, /phase order/);
    });

    it('preserves fractional interest across split periods and restart replay', () => {
        const initial = applyMarginScenarioEvent(open('1.5x', 100n), buy('principal', 149n)).state;
        const whole = applyMarginScenarioEvent(initial, {
            id: 'whole-year', kind: 'interest', occurredAt: '2027-08-30T10:00:00Z',
            fromAt: openedAt, toAt: '2027-08-30T10:00:00Z'
        }).state;
        const splitEvents: MarginScenarioEvent[] = [
            { id: 'q1', kind: 'interest', occurredAt: '2026-11-30T16:00:00Z', fromAt: openedAt, toAt: '2026-11-30T16:00:00Z' },
            { id: 'q2', kind: 'interest', occurredAt: '2027-03-02T22:00:00Z', fromAt: '2026-11-30T16:00:00Z', toAt: '2027-03-02T22:00:00Z' },
            { id: 'q3', kind: 'interest', occurredAt: '2027-06-02T04:00:00Z', fromAt: '2027-03-02T22:00:00Z', toAt: '2027-06-02T04:00:00Z' },
            { id: 'q4', kind: 'interest', occurredAt: '2027-08-30T10:00:00Z', fromAt: '2027-06-02T04:00:00Z', toAt: '2027-08-30T10:00:00Z' }
        ];
        const split = replayMarginScenario(initial, splitEvents);
        assert.equal(split.accruedInterestKopecks, whole.accruedInterestKopecks);
        assert.equal(split.interestRemainderNumerator, whole.interestRemainderNumerator);
        assert(split.interestRemainderNumerator < MARGIN_INTEREST_DENOMINATOR);
        assert.equal(marginRiskSnapshot(split).liabilitiesKopecks, marginRiskSnapshot(whole).liabilitiesKopecks);
        assert.deepEqual(replayMarginScenario(
            applyMarginScenarioEvent(open('1.5x', 100n), buy('principal', 149n)).state,
            splitEvents
        ), split);
    });

    it('isolates a deliberate conflict to one parallel scenario', () => {
        const initial = openDefaultMarginScenarios('paper', 100n, openedAt);
        const contaminated = Object.freeze({
            ...initial,
            scenarios: Object.freeze(initial.scenarios.map(scenario => scenario.policy.leverage === '1.2x'
                ? applyMarginScenarioEvent(scenario, buy('shared-id', 50n)).state
                : scenario))
        });
        const result = applyParallelMarginEvent(contaminated, buy('shared-id', 40n));
        assert.deepEqual(result.results.map(item => item.outcome), ['applied', 'failed', 'applied']);
        assert.match(result.results[1].reason!, /ID conflict/);
        assert.strictEqual(result.state.scenarios[1], contaminated.scenarios[1]);
        assert.equal(result.state.scenarios[0].audit.at(-1)?.eventId, 'shared-id');
        assert.equal(result.state.scenarios[2].audit.at(-1)?.eventId, 'shared-id');
    });
});
