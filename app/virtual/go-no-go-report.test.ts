import assert from 'node:assert/strict';
import test from 'node:test';
import { buildGoNoGoReport, ScenarioEconomics } from './go-no-go-report';
import { ObservationScenarioEvidence } from './observation-runner';

const evidence = (overrides: Partial<ObservationScenarioEvidence> = {}): ObservationScenarioEvidence => ({
    virtualAccountId: 'account-1', scenarioId: '1.2x', equityKopecks: 110_000n,
    closedVirtualTrades: 30, invariantViolationCount: 0, unknownUnreconciledOrderCount: 0,
    marginBreachCount: 0, feesIncluded: true, slippageIncluded: true, financingIncluded: true,
    benchmarkAvailable: true, firstObservedAt: '2026-08-01T00:00:00Z', lastObservedAt: '2026-08-14T00:00:00Z',
    peakEquityKopecks: 115_000n, maximumDrawdownKopecks: 5_000n, maximumDrawdownBps: 434,
    ...overrides
});
const economics = (overrides: Partial<ScenarioEconomics> = {}): ScenarioEconomics => ({
    virtualAccountId: 'account-1', scenarioId: '1.2x', strategyPnlKopecks: 10_000n,
    leverageAmplificationKopecks: 2_000n, financingKopecks: 300n, feesKopecks: 500n,
    slippageKopecks: 200n, benchmarkPnlKopecks: 4_000n, ...overrides
});

test('current short run is insufficient evidence', () => {
    const report = buildGoNoGoReport('2026-08-03T00:00:00Z', [evidence({ lastObservedAt: '2026-08-03T00:00:00Z', closedVirtualTrades: 4 })], [economics()]);
    assert.equal(report.decision, 'INSUFFICIENT-EVIDENCE');
    assert.equal(report.liveMarginAuthorized, false);
    assert.equal(report.ownerDecisionRequired, true);
});

test('qualified evidence with a safety failure is no-go', () => {
    const report = buildGoNoGoReport('2026-08-14T00:00:00Z', [evidence({ marginBreachCount: 1 })], [economics()]);
    assert.equal(report.decision, 'NO-GO');
    assert.deepEqual(report.reasons, ['MARGIN_SAFETY_BREACHES']);
});

test('safety failure remains no-go even before the minimum evidence window', () => {
    const report = buildGoNoGoReport('2026-08-03T00:00:00Z', [evidence({
        lastObservedAt: '2026-08-03T00:00:00Z', closedVirtualTrades: 4,
        invariantViolationCount: 1, unknownUnreconciledOrderCount: 1
    })], [economics()]);
    assert.equal(report.decision, 'NO-GO');
    assert.deepEqual(report.reasons, ['ACCOUNTING_INVARIANT_VIOLATIONS', 'UNKNOWN_UNRECONCILED_ORDERS']);
});

test('qualified clean evidence is only a candidate requiring owner approval', () => {
    const report = buildGoNoGoReport('2026-08-14T00:00:00Z', [evidence()], [economics()]);
    assert.equal(report.decision, 'GO-CANDIDATE');
    assert.equal(report.liveMarginAuthorized, false);
    assert.equal(report.ownerDecisionRequired, true);
    assert.equal(report.rows[0].netPnlKopecks, 11_000n);
    assert.deepEqual(report.reasons, ['OWNER_REVIEW_REQUIRED']);
});

test('requires explicit benchmark economics and a canonical report timestamp', () => {
    assert.throws(() => buildGoNoGoReport('2026-08-14', [evidence()], [economics()]), /RFC3339 UTC/);
    assert.throws(() => buildGoNoGoReport('2026-08-14T00:00:00Z', [evidence()], [
        { ...economics(), benchmarkPnlKopecks: undefined }
    ]), /benchmark P\/L missing/);
});
