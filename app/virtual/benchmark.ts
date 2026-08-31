export const BENCHMARK_METHODOLOGY = 'normalized-price-return' as const;
export const BENCHMARK_RETURN_SCOPE = 'price-only-excludes-dividends-fees-and-total-return' as const;

export interface QualifiedBenchmarkObservation {
    readonly observationId: string;
    readonly brokerObservedAt: string;
    readonly markKopecks: bigint;
    readonly scenarioEquityKopecks: bigint;
}

export interface BenchmarkBaseline {
    readonly observationId: string;
    readonly brokerObservedAt: string;
    readonly markKopecks: bigint;
}

export interface BenchmarkPoint {
    readonly observationId: string;
    readonly brokerObservedAt: string;
    readonly markKopecks: bigint;
    readonly scenarioEquityKopecks: bigint;
    readonly benchmarkEquityKopecks: bigint;
    readonly benchmarkPnlKopecks: bigint;
    readonly scenarioPnlKopecks: bigint;
    readonly scenarioReturnBps: bigint;
    readonly benchmarkReturnBps: bigint;
    readonly excessPnlKopecks: bigint;
    readonly excessReturnBps: bigint;
}

export interface NormalizedPriceBenchmarkState {
    readonly benchmarkId: string;
    readonly initialEquityKopecks: bigint;
    readonly methodology: typeof BENCHMARK_METHODOLOGY;
    readonly returnScope: typeof BENCHMARK_RETURN_SCOPE;
    readonly baseline?: BenchmarkBaseline;
    readonly points: readonly BenchmarkPoint[];
}

const requireId = (value: string, field: string) => {
    if (typeof value !== 'string' || !value || value.trim() !== value) {
        throw new TypeError(`${field} must be trimmed and non-empty`);
    }
};

const brokerTimestamp = (value: string) => {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) {
        throw new TypeError('brokerObservedAt must be an RFC3339 UTC timestamp');
    }
    const milliseconds = Date.parse(value);
    if (!Number.isFinite(milliseconds)) throw new TypeError('brokerObservedAt must be valid');
    return milliseconds;
};

const requirePositiveBigInt = (value: bigint, field: string) => {
    if (typeof value !== 'bigint' || value <= 0n) throw new TypeError(`${field} must be a positive bigint`);
};

const requireNonNegativeBigInt = (value: bigint, field: string) => {
    if (typeof value !== 'bigint' || value < 0n) throw new TypeError(`${field} must be a non-negative bigint`);
};

const freeze = <T extends object>(value: T): Readonly<T> => Object.freeze(value);

const observationFingerprint = (value: QualifiedBenchmarkObservation) => [
    value.observationId,
    value.brokerObservedAt,
    value.markKopecks.toString(10),
    value.scenarioEquityKopecks.toString(10)
].map(item => `${item.length}:${item}`).join('|');

const pointFingerprint = (value: BenchmarkPoint) => observationFingerprint(value);

const normalizeObservation = (source: QualifiedBenchmarkObservation): QualifiedBenchmarkObservation => {
    if (!source || typeof source !== 'object') throw new TypeError('observation must be an object');
    requireId(source.observationId, 'observationId');
    brokerTimestamp(source.brokerObservedAt);
    requirePositiveBigInt(source.markKopecks, 'markKopecks');
    requireNonNegativeBigInt(source.scenarioEquityKopecks, 'scenarioEquityKopecks');
    return freeze({
        observationId: source.observationId,
        brokerObservedAt: source.brokerObservedAt,
        markKopecks: source.markKopecks,
        scenarioEquityKopecks: source.scenarioEquityKopecks
    });
};

/** Mathematical floor keeps fractional losses conservative; BigInt division alone truncates toward zero. */
const floorDiv = (numerator: bigint, denominator: bigint): bigint => {
    const quotient = numerator / denominator;
    const remainder = numerator % denominator;
    return remainder < 0n ? quotient - 1n : quotient;
};

const returnBps = (current: bigint, baseline: bigint) =>
    floorDiv((current - baseline) * 10_000n, baseline);

export const openNormalizedPriceBenchmark = (
    benchmarkId: string,
    initialEquityKopecks: bigint
): NormalizedPriceBenchmarkState => {
    requireId(benchmarkId, 'benchmarkId');
    requirePositiveBigInt(initialEquityKopecks, 'initialEquityKopecks');
    return freeze({
        benchmarkId,
        initialEquityKopecks,
        methodology: BENCHMARK_METHODOLOGY,
        returnScope: BENCHMARK_RETURN_SCOPE,
        points: freeze([] as BenchmarkPoint[])
    });
};

export const applyQualifiedBenchmarkObservation = (
    state: NormalizedPriceBenchmarkState,
    source: QualifiedBenchmarkObservation
): NormalizedPriceBenchmarkState => {
    const observation = normalizeObservation(source);
    const existing = state.points.find(point => point.observationId === observation.observationId);
    if (existing) {
        if (pointFingerprint(existing) !== observationFingerprint(observation)) {
            throw new Error(`benchmark observation ID conflict: ${observation.observationId}`);
        }
        return state;
    }

    const last = state.points[state.points.length - 1];
    if (last && brokerTimestamp(observation.brokerObservedAt) <= brokerTimestamp(last.brokerObservedAt)) {
        throw new Error('benchmark observations must be strictly chronological by broker timestamp');
    }

    const baseline = state.baseline ?? freeze({
        observationId: observation.observationId,
        brokerObservedAt: observation.brokerObservedAt,
        markKopecks: observation.markKopecks
    });
    const benchmarkEquityKopecks = state.initialEquityKopecks * observation.markKopecks / baseline.markKopecks;
    const scenarioReturnBps = returnBps(observation.scenarioEquityKopecks, state.initialEquityKopecks);
    const benchmarkReturnBps = returnBps(observation.markKopecks, baseline.markKopecks);
    const point = freeze({
        ...observation,
        benchmarkEquityKopecks,
        benchmarkPnlKopecks: benchmarkEquityKopecks - state.initialEquityKopecks,
        scenarioPnlKopecks: observation.scenarioEquityKopecks - state.initialEquityKopecks,
        scenarioReturnBps,
        benchmarkReturnBps,
        excessPnlKopecks: observation.scenarioEquityKopecks - benchmarkEquityKopecks,
        excessReturnBps: scenarioReturnBps - benchmarkReturnBps
    });
    return freeze({
        benchmarkId: state.benchmarkId,
        initialEquityKopecks: state.initialEquityKopecks,
        methodology: BENCHMARK_METHODOLOGY,
        returnScope: BENCHMARK_RETURN_SCOPE,
        baseline,
        points: freeze([...state.points, point])
    });
};

export const replayQualifiedBenchmarkObservations = (
    benchmarkId: string,
    initialEquityKopecks: bigint,
    observations: readonly QualifiedBenchmarkObservation[]
) => observations.reduce(
    applyQualifiedBenchmarkObservation,
    openNormalizedPriceBenchmark(benchmarkId, initialEquityKopecks)
);
