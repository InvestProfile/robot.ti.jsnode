import { evaluateObservationGate, ObservationScenarioEvidence } from './observation-runner';

export type GoNoGoDecision = 'GO-CANDIDATE' | 'NO-GO' | 'INSUFFICIENT-EVIDENCE';

export interface ScenarioEconomics {
    readonly virtualAccountId: string;
    readonly scenarioId: string;
    readonly strategyPnlKopecks: bigint;
    readonly leverageAmplificationKopecks: bigint;
    readonly financingKopecks: bigint;
    readonly feesKopecks: bigint;
    readonly slippageKopecks: bigint;
    readonly benchmarkPnlKopecks?: bigint;
}

export interface GoNoGoScenarioRow extends ScenarioEconomics {
    readonly netPnlKopecks: bigint;
    readonly maximumDrawdownKopecks: bigint;
    readonly maximumDrawdownBps: number;
    readonly marginBreachCount: number;
    readonly evidenceQualified: boolean;
    readonly evidenceReasons: readonly string[];
}

export interface GoNoGoReport {
    readonly decision: GoNoGoDecision;
    readonly liveMarginAuthorized: false;
    readonly ownerDecisionRequired: true;
    readonly generatedAt: string;
    readonly rows: readonly GoNoGoScenarioRow[];
    readonly reasons: readonly string[];
}

const keyOf = (value: Pick<ScenarioEconomics, 'virtualAccountId' | 'scenarioId'>) =>
    `${value.virtualAccountId}\u0000${value.scenarioId}`;
const freeze = <T extends object>(value: T): Readonly<T> => Object.freeze(value);

export const buildGoNoGoReport = (
    generatedAt: string,
    evidence: readonly ObservationScenarioEvidence[],
    economics: readonly ScenarioEconomics[]
): GoNoGoReport => {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(generatedAt) || !Number.isFinite(Date.parse(generatedAt))) {
        throw new TypeError('generatedAt must be a valid RFC3339 UTC timestamp');
    }
    const evidenceByKey = new Map(evidence.map(item => [keyOf(item), item]));
    if (evidenceByKey.size !== evidence.length) throw new Error('duplicate evidence scenario');
    const seen = new Set<string>();
    const rows = economics.map(item => {
        const key = keyOf(item);
        if (seen.has(key)) throw new Error('duplicate economics scenario');
        seen.add(key);
        const observed = evidenceByKey.get(key);
        if (!observed) throw new Error(`missing scenario evidence: ${item.scenarioId}`);
        for (const [field, value] of Object.entries(item)) {
            if (field.endsWith('Kopecks') && value !== undefined && typeof value !== 'bigint') throw new TypeError(`${field} must be bigint`);
        }
        const gate = evaluateObservationGate(observed);
        if (observed.benchmarkAvailable && item.benchmarkPnlKopecks === undefined) {
            throw new Error(`benchmark P/L missing for scenario: ${item.scenarioId}`);
        }
        return freeze({
            ...item,
            netPnlKopecks: item.strategyPnlKopecks + item.leverageAmplificationKopecks
                - item.financingKopecks - item.feesKopecks - item.slippageKopecks,
            maximumDrawdownKopecks: observed.maximumDrawdownKopecks,
            maximumDrawdownBps: observed.maximumDrawdownBps,
            marginBreachCount: observed.marginBreachCount,
            evidenceQualified: gate.qualified,
            evidenceReasons: gate.reasons
        });
    }).sort((a, b) => keyOf(a).localeCompare(keyOf(b)));
    if (rows.length !== evidence.length) throw new Error('economics must cover every evidence scenario');

    const safetyReasons = [...new Set(evidence.flatMap(item => [
        ...(item.invariantViolationCount > 0 ? ['ACCOUNTING_INVARIANT_VIOLATIONS'] : []),
        ...(item.unknownUnreconciledOrderCount > 0 ? ['UNKNOWN_UNRECONCILED_ORDERS'] : []),
        ...(item.marginBreachCount > 0 ? ['MARGIN_SAFETY_BREACHES'] : [])
    ]))].sort();
    const failedSafety = safetyReasons.length > 0;
    const insufficient = rows.some(row => !row.evidenceQualified);
    const reasons = failedSafety
        ? safetyReasons
        : insufficient ? [...new Set(rows.flatMap(row => row.evidenceReasons))].sort() : ['OWNER_REVIEW_REQUIRED'];
    const decision: GoNoGoDecision = failedSafety
        ? 'NO-GO' : insufficient ? 'INSUFFICIENT-EVIDENCE' : 'GO-CANDIDATE';
    return freeze({
        decision,
        liveMarginAuthorized: false,
        ownerDecisionRequired: true,
        generatedAt,
        rows: freeze(rows),
        reasons: freeze(reasons)
    });
};
