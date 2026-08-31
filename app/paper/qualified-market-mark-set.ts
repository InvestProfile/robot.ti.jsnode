import { createHash } from 'node:crypto';
import type { BrokerMarketMark } from '../market-observation/types';
import { assertUniqueMarketMarkIdentities, marketMarkFingerprint, type MarketSessionStatus } from '../market-observation/types';

export const MARKET_MARK_SESSION_POLICY_VERSION = 'market-mark-session-policy-v1' as const;

export interface MarketMarkSessionPolicy {
    readonly version: typeof MARKET_MARK_SESSION_POLICY_VERSION;
    readonly qualifiedStatuses: readonly MarketSessionStatus[];
}

export const DEFAULT_MARKET_MARK_SESSION_POLICY: MarketMarkSessionPolicy = Object.freeze({
    version: MARKET_MARK_SESSION_POLICY_VERSION,
    qualifiedStatuses: Object.freeze(['open'] as MarketSessionStatus[])
});

export type MarketMarkQualificationReason =
    | `MISSING_REQUIRED_MARK:${string}`
    | `STALE_MARK:${string}`
    | `CROSSED_MARK:${string}`
    | `OUT_OF_SPREAD_MARK:${string}`
    | `INVALID_MARK_FINGERPRINT:${string}`
    | `SESSION_STATUS_NOT_QUALIFIED:${string}:${MarketSessionStatus}`
    | 'MARK_SET_SKEW_EXCEEDED';

export interface MarketMarkQualificationRequest {
    readonly sourceTickId: string;
    readonly valuationAt: string;
    readonly requiredInstrumentUids: readonly string[];
    readonly benchmarkInstrumentUid: string;
    readonly marks: readonly BrokerMarketMark[];
    readonly maxMarkAgeMs: number;
    readonly maxInterInstrumentSkewMs: number;
    readonly sessionPolicy?: MarketMarkSessionPolicy;
}

export interface MarketMarkProvenance {
    readonly instrumentUid: string;
    readonly role: 'position' | 'benchmark';
    readonly observationId: string;
    readonly payloadFingerprint: string;
    readonly brokerObservedAt: string;
}

export interface QualifiedMarketMarkSet {
    readonly quality: 'qualified';
    readonly markSetId: string;
    readonly sourceTickId: string;
    readonly valuationAt: string;
    readonly marks: readonly BrokerMarketMark[];
    readonly benchmarkMark: BrokerMarketMark;
    readonly provenance: readonly MarketMarkProvenance[];
    readonly maximumAgeMs: number;
    readonly maximumSkewMs: number;
}

export interface RejectedMarketMarkSet {
    readonly quality: 'rejected';
    readonly sourceTickId: string;
    readonly valuationAt: string;
    readonly reasons: readonly MarketMarkQualificationReason[];
}

export type MarketMarkQualification = QualifiedMarketMarkSet | RejectedMarketMarkSet;

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');
const epoch = (value: string, field: string): number => {
    const parsed = Date.parse(value);
    if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
        throw new TypeError(`${field} must be a canonical ISO-8601 UTC timestamp`);
    }
    return parsed;
};

const frozenReasons = (reasons: readonly MarketMarkQualificationReason[]) =>
    Object.freeze([...new Set(reasons)].sort()) as readonly MarketMarkQualificationReason[];

export const qualifyMarketMarkSet = (request: MarketMarkQualificationRequest): MarketMarkQualification => {
    if (!request.sourceTickId.trim()) throw new TypeError('sourceTickId must be non-empty');
    if (!Number.isSafeInteger(request.maxMarkAgeMs) || request.maxMarkAgeMs < 0) throw new RangeError('maxMarkAgeMs must be a non-negative safe integer');
    if (!Number.isSafeInteger(request.maxInterInstrumentSkewMs) || request.maxInterInstrumentSkewMs < 0) {
        throw new RangeError('maxInterInstrumentSkewMs must be a non-negative safe integer');
    }
    assertUniqueMarketMarkIdentities(request.marks);
    const valuationAtMs = epoch(request.valuationAt, 'valuationAt');
    const sessionPolicy = request.sessionPolicy ?? DEFAULT_MARKET_MARK_SESSION_POLICY;
    if (sessionPolicy.version !== MARKET_MARK_SESSION_POLICY_VERSION) throw new TypeError('unsupported market mark session policy version');
    if (!sessionPolicy.qualifiedStatuses.length) throw new TypeError('session policy must qualify at least one status');
    const required = [...new Set([...request.requiredInstrumentUids, request.benchmarkInstrumentUid].map(value => value.trim()))];
    if (required.some(value => !value)) throw new TypeError('required instrument UIDs must be non-empty');

    const selected: BrokerMarketMark[] = [];
    const reasons: MarketMarkQualificationReason[] = [];
    for (const instrumentUid of required) {
        const candidates = request.marks
            .filter(mark => mark.instrumentUid === instrumentUid && epoch(mark.brokerObservedAt, 'brokerObservedAt') <= valuationAtMs)
            .sort((left, right) => epoch(right.brokerObservedAt, 'brokerObservedAt') - epoch(left.brokerObservedAt, 'brokerObservedAt'));
        const mark = candidates[0];
        if (!mark) { reasons.push(`MISSING_REQUIRED_MARK:${instrumentUid}`); continue; }
        if (marketMarkFingerprint(mark) !== mark.payloadFingerprint) reasons.push(`INVALID_MARK_FINGERPRINT:${instrumentUid}`);
        if (!sessionPolicy.qualifiedStatuses.includes(mark.sessionStatus)) {
            reasons.push(`SESSION_STATUS_NOT_QUALIFIED:${instrumentUid}:${mark.sessionStatus}`);
        }
        if (mark.bidKopecks > mark.askKopecks) reasons.push(`CROSSED_MARK:${instrumentUid}`);
        if (mark.markKopecks < mark.bidKopecks || mark.markKopecks > mark.askKopecks) reasons.push(`OUT_OF_SPREAD_MARK:${instrumentUid}`);
        const age = valuationAtMs - epoch(mark.brokerObservedAt, 'brokerObservedAt');
        if (age > request.maxMarkAgeMs) reasons.push(`STALE_MARK:${instrumentUid}`);
        selected.push(mark);
    }

    if (selected.length > 1) {
        const times = selected.map(mark => epoch(mark.brokerObservedAt, 'brokerObservedAt'));
        if (Math.max(...times) - Math.min(...times) > request.maxInterInstrumentSkewMs) reasons.push('MARK_SET_SKEW_EXCEEDED');
    }
    if (reasons.length) return Object.freeze({
        quality: 'rejected', sourceTickId: request.sourceTickId, valuationAt: request.valuationAt,
        reasons: frozenReasons(reasons)
    });

    const benchmarkMark = selected.find(mark => mark.instrumentUid === request.benchmarkInstrumentUid);
    if (!benchmarkMark) throw new Error('qualified mark set invariant failed: benchmark missing');
    const provenance = Object.freeze(selected.map(mark => Object.freeze({
        instrumentUid: mark.instrumentUid,
        role: mark.instrumentUid === request.benchmarkInstrumentUid ? 'benchmark' as const : 'position' as const,
        observationId: mark.observationId,
        payloadFingerprint: mark.payloadFingerprint,
        brokerObservedAt: mark.brokerObservedAt
    })).sort((left, right) => left.instrumentUid.localeCompare(right.instrumentUid)));
    const markSetId = sha256(JSON.stringify({
        sourceTickId: request.sourceTickId,
        valuationAt: request.valuationAt,
        provenance
    }));
    const ages = selected.map(mark => valuationAtMs - epoch(mark.brokerObservedAt, 'brokerObservedAt'));
    const times = selected.map(mark => epoch(mark.brokerObservedAt, 'brokerObservedAt'));
    return Object.freeze({
        quality: 'qualified', markSetId, sourceTickId: request.sourceTickId, valuationAt: request.valuationAt,
        marks: Object.freeze([...selected]), benchmarkMark, provenance,
        maximumAgeMs: Math.max(...ages), maximumSkewMs: Math.max(...times) - Math.min(...times)
    });
};

export interface ScenarioMarkSetProvenance {
    readonly scenarioId: string;
    readonly markSetId: string;
    readonly provenance: readonly MarketMarkProvenance[];
}

export const assignQualifiedMarkSetToScenarios = (
    markSet: QualifiedMarketMarkSet,
    scenarioIds: readonly string[]
): readonly ScenarioMarkSetProvenance[] => {
    const unique = [...new Set(scenarioIds.map(value => value.trim()))];
    if (!unique.length || unique.some(value => !value) || unique.length !== scenarioIds.length) {
        throw new TypeError('scenario IDs must be non-empty and unique');
    }
    return Object.freeze(unique.map(scenarioId => Object.freeze({
        scenarioId, markSetId: markSet.markSetId, provenance: markSet.provenance
    })));
};

export const assertSameScenarioMarkSet = (assignments: readonly ScenarioMarkSetProvenance[]): string => {
    if (!assignments.length) throw new Error('scenario mark-set assignments are missing');
    const expected = assignments[0];
    if (assignments.some(item => item.markSetId !== expected.markSetId || item.provenance !== expected.provenance)) {
        throw new Error('scenario mark-set provenance mismatch');
    }
    return expected.markSetId;
};
