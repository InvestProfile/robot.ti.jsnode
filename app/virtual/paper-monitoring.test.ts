import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    PAPER_MONITORING_REASON_CODES,
    PaperScenarioMonitoringSnapshot,
    evaluatePaperMonitoring
} from './paper-monitoring';

const evaluatedAt = '2026-08-30T12:00:00Z';
const healthy = (scenarioId = 'paper:1x', virtualAccountId = 'paper'): PaperScenarioMonitoringSnapshot => ({
    virtualAccountId,
    scenarioId,
    dataSources: [{ sourceId: 'market', observedAt: '2026-08-30T11:59:30Z', maxAgeSeconds: 60 }],
    accounting: { invariantSatisfied: true, assetsKopecks: 150n, equityKopecks: 100n, liabilitiesKopecks: 50n },
    orders: [{ orderId: 'order-1', state: 'known', reconciled: true }],
    margin: { maintenanceSatisfied: true, reduceOnly: false, liquidationRequired: false }
});

describe('paper monitoring', () => {
    it('classifies fresh, stale, missing and future data deterministically', () => {
        const scenario = { ...healthy(), dataSources: [
            { sourceId: 'fresh', observedAt: '2026-08-30T11:59:00Z', maxAgeSeconds: 60 },
            { sourceId: 'stale', observedAt: '2026-08-30T11:58:59Z', maxAgeSeconds: 60 },
            { sourceId: 'missing', maxAgeSeconds: 60 },
            { sourceId: 'future', observedAt: '2026-08-30T12:00:01Z', maxAgeSeconds: 60 }
        ] };
        const result = evaluatePaperMonitoring({ evaluatedAt, scenarios: [scenario] });
        assert.deepEqual(result.scenarios[0].freshness.map(value => [value.sourceId, value.state]), [
            ['fresh', 'fresh'], ['future', 'future'], ['missing', 'missing'], ['stale', 'stale']
        ]);
        assert.deepEqual(result.alerts.map(alert => alert.reasonCode), [
            PAPER_MONITORING_REASON_CODES.freshnessFuture,
            PAPER_MONITORING_REASON_CODES.freshnessMissing,
            PAPER_MONITORING_REASON_CODES.freshnessStale
        ]);
    });

    it('emits stable safety alerts for accounting, orders and margin states', () => {
        const scenario: PaperScenarioMonitoringSnapshot = {
            ...healthy(),
            accounting: { invariantSatisfied: false, assetsKopecks: 150n, equityKopecks: 99n, liabilitiesKopecks: 50n },
            orders: [{ orderId: 'unknown-1', state: 'unknown', reconciled: false }],
            margin: { maintenanceSatisfied: false, reduceOnly: true, liquidationRequired: true }
        };
        const result = evaluatePaperMonitoring({ evaluatedAt, scenarios: [scenario] });
        assert.deepEqual(new Set(result.alerts.map(alert => alert.reasonCode)), new Set([
            PAPER_MONITORING_REASON_CODES.accountingInvariant,
            PAPER_MONITORING_REASON_CODES.orderUnknown,
            PAPER_MONITORING_REASON_CODES.orderUnreconciled,
            PAPER_MONITORING_REASON_CODES.maintenanceBreach,
            PAPER_MONITORING_REASON_CODES.reduceOnly,
            PAPER_MONITORING_REASON_CODES.liquidationRequired
        ]));
        assert.equal(result.alerts.find(alert => alert.reasonCode === PAPER_MONITORING_REASON_CODES.reduceOnly)?.severity, 'warning');
        assert(result.alerts.filter(alert => alert.reasonCode !== PAPER_MONITORING_REASON_CODES.reduceOnly).every(alert => alert.severity === 'critical'));
    });

    it('is idempotent, deduped, sorted and immutable', () => {
        const input = { evaluatedAt, scenarios: [healthy('paper:1.5x'), healthy('paper:1x')] };
        const first = evaluatePaperMonitoring(input);
        const second = evaluatePaperMonitoring(input);
        assert.deepEqual(second, first);
        assert.deepEqual(first.scenarios.map(item => item.scenarioId), ['paper:1.5x', 'paper:1x']);
        assert.equal(new Set(first.alerts.map(alert => alert.dedupeKey)).size, first.alerts.length);
        assert(Object.isFrozen(first));
        assert(Object.isFrozen(first.scenarios));
        assert(Object.isFrozen(first.scenarios[0].alerts));
    });

    it('isolates alerts by virtual account and scenario', () => {
        const broken = { ...healthy('paper:1.5x', 'account-b'), accounting: {
            invariantSatisfied: false, assetsKopecks: 1n, equityKopecks: 1n, liabilitiesKopecks: 1n
        } };
        const result = evaluatePaperMonitoring({ evaluatedAt, scenarios: [broken, healthy('paper:1x', 'account-a')] });
        assert.equal(result.scenarios.find(item => item.virtualAccountId === 'account-a')?.alerts.length, 0);
        assert(result.alerts.every(alert => alert.virtualAccountId === 'account-b' && alert.scenarioId === 'paper:1.5x'));
    });

    it('fails closed under malformed and conflicting fault injection', () => {
        assert.throws(() => evaluatePaperMonitoring({ evaluatedAt: 'not-a-time', scenarios: [] }), /timestamp/);
        const badAge = evaluatePaperMonitoring({ evaluatedAt, scenarios: [
            { ...healthy(), dataSources: [{ sourceId: 'market', observedAt: evaluatedAt, maxAgeSeconds: -1 }] }
        ] });
        assert.equal(badAge.scenarios[0].status, 'failed');
        assert.match(badAge.scenarios[0].failureReason ?? '', /maxAgeSeconds/);
        const falseInvariant = evaluatePaperMonitoring({ evaluatedAt, scenarios: [
            { ...healthy(), accounting: { invariantSatisfied: true, assetsKopecks: 10n, equityKopecks: 9n, liabilitiesKopecks: 2n } }
        ] });
        assert.equal(falseInvariant.scenarios[0].status, 'failed');
        assert.throws(() => evaluatePaperMonitoring({ evaluatedAt, scenarios: [healthy(), healthy()] }), /duplicate monitoring scenario/);
        const duplicateOrder = evaluatePaperMonitoring({ evaluatedAt, scenarios: [
            { ...healthy(), orders: [
                { orderId: 'same', state: 'known', reconciled: true },
                { orderId: 'same', state: 'unknown', reconciled: false }
            ] }
        ] });
        assert.equal(duplicateOrder.scenarios[0].status, 'failed');
    });

    it('isolates a malformed scenario without suppressing healthy siblings', () => {
        const broken = { ...healthy('paper:broken'), dataSources: [
            { sourceId: 'market', observedAt: evaluatedAt, maxAgeSeconds: -1 }
        ] };
        const result = evaluatePaperMonitoring({ evaluatedAt, scenarios: [broken, healthy('paper:healthy')] });
        assert.equal(result.scenarios.find(item => item.scenarioId === 'paper:broken')?.status, 'failed');
        assert.equal(result.scenarios.find(item => item.scenarioId === 'paper:healthy')?.status, 'ok');
        assert.equal(result.alerts.filter(alert => alert.reasonCode === PAPER_MONITORING_REASON_CODES.evaluationFailed).length, 1);
    });

    it('uses account-scoped dedupe keys for identical external identifiers', () => {
        const unknown = (account: string) => ({ ...healthy('paper:1x', account), orders: [
            { orderId: 'shared-id', state: 'unknown' as const, reconciled: false }
        ] });
        const result = evaluatePaperMonitoring({ evaluatedAt, scenarios: [unknown('a'), unknown('b')] });
        assert.equal(result.alerts.length, 4);
        assert.equal(new Set(result.alerts.map(alert => alert.dedupeKey)).size, 4);
    });
});
