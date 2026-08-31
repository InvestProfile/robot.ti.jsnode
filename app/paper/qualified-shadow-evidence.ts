import { createHash } from 'node:crypto';
import type { CompleteShadowSourceTick } from './shadow-source-outbox';
import type { ShadowScenarioState } from './shadow-scenario-fanout';
import type { ObservationExperimentConfigV2 } from './observation-persistence';
import { qualifyMarketMarkSet, type MarketMarkQualification, type QualifiedMarketMarkSet } from './qualified-market-mark-set';
import type { BrokerMarketMark } from '../market-observation/types';
import { applyMarginScenarioEvent, marginRiskSnapshot } from '../virtual/margin';
import { applyQualifiedBenchmarkObservation, openNormalizedPriceBenchmark, type BenchmarkBaseline, type BenchmarkPoint } from '../virtual/benchmark';

export interface QualifiedMarketEvidenceLoader {
    loadAsOf(input: { instrumentUids: readonly string[]; valuationAt: string }): Promise<readonly BrokerMarketMark[]>;
}

export interface QualifiedShadowTickPreparation {
    readonly requiredInstrumentUids: readonly string[];
    readonly qualification: MarketMarkQualification;
}

export interface QualifiedScenarioBenchmarkPoint {
    readonly scenarioId: string;
    readonly point: BenchmarkPoint;
    readonly payloadFingerprint: string;
}

export interface QualifiedBenchmarkEvidence {
    readonly baseline: BenchmarkBaseline;
    readonly points: readonly QualifiedScenarioBenchmarkPoint[];
}

export interface PersistedScenarioBenchmarkPoint {
    readonly scenarioId: string;
    readonly point: BenchmarkPoint;
}

const sha256 = (value: unknown) => createHash('sha256').update(JSON.stringify(value, (_key, item) =>
    typeof item === 'bigint' ? item.toString() : item)).digest('hex');

export const requiredQualifiedInstrumentUids = (
    sourceTick: CompleteShadowSourceTick,
    states: readonly ShadowScenarioState[],
    benchmarkInstrumentUid: string
): readonly string[] => {
    const values = [
        benchmarkInstrumentUid,
        ...sourceTick.events.map(event => event.instrumentId),
        ...states.flatMap(state => state.margin.positions.map(position => position.instrumentId)),
        ...states.flatMap(state => state.liquidationPlan?.instrumentIds ?? [])
    ];
    if (values.some(value => typeof value !== 'string' || !value.trim())) {
        throw new TypeError('qualified evidence instrument UIDs must be non-empty');
    }
    return Object.freeze([...new Set(values.map(value => value.trim()))].sort());
};

export const prepareQualifiedShadowTick = async (input: {
    readonly config: ObservationExperimentConfigV2;
    readonly sourceTick: CompleteShadowSourceTick;
    readonly states: readonly ShadowScenarioState[];
    readonly loader: QualifiedMarketEvidenceLoader;
}): Promise<QualifiedShadowTickPreparation> => {
    const requiredInstrumentUids = requiredQualifiedInstrumentUids(
        input.sourceTick, input.states, input.config.evidenceConfig.benchmarkInstrumentUid
    );
    const marks = await input.loader.loadAsOf({ instrumentUids: requiredInstrumentUids, valuationAt: input.sourceTick.completedAt });
    const qualification = qualifyMarketMarkSet({
        sourceTickId: input.sourceTick.sourceTickId, valuationAt: input.sourceTick.completedAt,
        requiredInstrumentUids: requiredInstrumentUids.filter(uid => uid !== input.config.evidenceConfig.benchmarkInstrumentUid),
        benchmarkInstrumentUid: input.config.evidenceConfig.benchmarkInstrumentUid, marks,
        maxMarkAgeMs: input.config.evidenceConfig.maxMarkAgeMs,
        maxInterInstrumentSkewMs: input.config.evidenceConfig.maxInterInstrumentSkewMs
    });
    return Object.freeze({ requiredInstrumentUids, qualification });
};

export const applyQualifiedMarksToScenarios = (
    states: readonly ShadowScenarioState[], markSet: QualifiedMarketMarkSet
): readonly ShadowScenarioState[] => {
    const byUid = new Map(markSet.marks.map(mark => [mark.instrumentUid, mark]));
    return Object.freeze(states.map(state => {
        let margin = state.margin;
        for (const position of state.margin.positions) {
            const mark = byUid.get(position.instrumentId);
            if (!mark) throw new Error('qualified mark missing for open position: ' + position.instrumentId);
            const result = applyMarginScenarioEvent(margin, {
                id: 'qualified-mark:' + markSet.markSetId + ':' + state.scenarioId + ':' + position.instrumentId,
                kind: 'mark', instrumentId: position.instrumentId, occurredAt: markSet.valuationAt,
                observedAt: mark.brokerObservedAt, priceKopecks: mark.markKopecks
            });
            if (result.outcome === 'rejected') throw new Error(result.reason ?? 'qualified margin mark rejected');
            margin = result.state;
        }
        return Object.freeze({ ...state, margin });
    }));
};

export const buildQualifiedBenchmarkEvidence = (input: {
    readonly config: ObservationExperimentConfigV2;
    readonly markSet: QualifiedMarketMarkSet;
    readonly states: readonly ShadowScenarioState[];
    readonly persistedBaseline?: BenchmarkBaseline;
    readonly persistedLastPoints?: readonly PersistedScenarioBenchmarkPoint[];
}): QualifiedBenchmarkEvidence => {
    const benchmark = input.markSet.benchmarkMark;
    const baseline = input.persistedBaseline ?? Object.freeze({
        observationId: benchmark.observationId, brokerObservedAt: benchmark.brokerObservedAt, markKopecks: benchmark.markKopecks
    });
    const benchmarkTime = Date.parse(benchmark.brokerObservedAt);
    const baselineTime = Date.parse(baseline.brokerObservedAt);
    const sameBaselineId = benchmark.observationId === baseline.observationId;
    if (sameBaselineId && (benchmark.brokerObservedAt !== baseline.brokerObservedAt
        || benchmark.markKopecks !== baseline.markKopecks)) {
        throw new Error('benchmark baseline observation ID conflict');
    }
    if (benchmarkTime < baselineTime || (benchmarkTime === baselineTime && !sameBaselineId)) {
        throw new Error('benchmark observation must not precede or collide with persisted baseline');
    }
    if (input.persistedBaseline && !input.persistedLastPoints) {
        throw new Error('persisted benchmark baseline requires the exact last-point scenario set');
    }
    const lastByScenario = new Map((input.persistedLastPoints ?? []).map(item => [item.scenarioId, item.point]));
    if (lastByScenario.size !== (input.persistedLastPoints ?? []).length) {
        throw new Error('persisted benchmark scenario points must be unique');
    }
    if (input.persistedLastPoints) {
        const expected = [...input.states.map(state => state.scenarioId)].sort();
        const actual = [...lastByScenario.keys()].sort();
        if (JSON.stringify(actual) !== JSON.stringify(expected)) {
            throw new Error('persisted benchmark scenario points must match the exact scenario set');
        }
    }
    const points = input.states.map(state => {
        const opened = openNormalizedPriceBenchmark(input.config.benchmarkId ?? input.config.evidenceConfig.benchmarkInstrumentUid,
            BigInt(input.config.startingCashKopecks));
        const last = lastByScenario.get(state.scenarioId);
        if (last && Date.parse(last.brokerObservedAt) < Date.parse(baseline.brokerObservedAt)) {
            throw new Error('persisted benchmark point cannot precede baseline: ' + state.scenarioId);
        }
        const seeded = Object.freeze({ ...opened, baseline, points: Object.freeze(last ? [last] : []) });
        const next = applyQualifiedBenchmarkObservation(seeded, {
            observationId: benchmark.observationId, brokerObservedAt: benchmark.brokerObservedAt,
            markKopecks: benchmark.markKopecks, scenarioEquityKopecks: marginRiskSnapshot(state.margin).equityKopecks
        });
        const point = next.points[next.points.length - 1];
        if (!point) throw new Error('qualified benchmark point missing');
        return Object.freeze({ scenarioId: state.scenarioId, point, payloadFingerprint: sha256({ scenarioId: state.scenarioId, point }) });
    });
    return Object.freeze({ baseline, points: Object.freeze(points) });
};
