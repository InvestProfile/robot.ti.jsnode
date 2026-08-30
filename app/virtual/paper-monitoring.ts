export type PaperMonitoringSeverity = 'info' | 'warning' | 'critical';
export type PaperFreshnessState = 'fresh' | 'stale' | 'missing' | 'future';

export const PAPER_MONITORING_REASON_CODES = Object.freeze({
    freshnessMissing: 'PAPER_DATA_FRESHNESS_MISSING',
    freshnessStale: 'PAPER_DATA_FRESHNESS_STALE',
    freshnessFuture: 'PAPER_DATA_FRESHNESS_FUTURE',
    accountingInvariant: 'PAPER_ACCOUNTING_INVARIANT_VIOLATION',
    orderUnknown: 'PAPER_ORDER_STATE_UNKNOWN',
    orderUnreconciled: 'PAPER_ORDER_UNRECONCILED',
    maintenanceBreach: 'PAPER_MARGIN_MAINTENANCE_BREACH',
    reduceOnly: 'PAPER_MARGIN_REDUCE_ONLY',
    liquidationRequired: 'PAPER_MARGIN_LIQUIDATION_REQUIRED'
    ,evaluationFailed: 'PAPER_MONITORING_EVALUATION_FAILED'
} as const);

export type PaperMonitoringReasonCode = typeof PAPER_MONITORING_REASON_CODES[keyof typeof PAPER_MONITORING_REASON_CODES];

export interface PaperDataSourceSnapshot {
    readonly sourceId: string;
    readonly observedAt?: string;
    readonly maxAgeSeconds: number;
}

export interface PaperAccountingSnapshot {
    readonly invariantSatisfied: boolean;
    readonly assetsKopecks: bigint;
    readonly equityKopecks: bigint;
    readonly liabilitiesKopecks: bigint;
}

export interface PaperOrderMonitoringSnapshot {
    readonly orderId: string;
    readonly state: 'known' | 'unknown';
    readonly reconciled: boolean;
}

export interface PaperMarginSafetySnapshot {
    readonly maintenanceSatisfied: boolean;
    readonly reduceOnly: boolean;
    readonly liquidationRequired: boolean;
}

export interface PaperScenarioMonitoringSnapshot {
    readonly virtualAccountId: string;
    readonly scenarioId: string;
    readonly dataSources: readonly PaperDataSourceSnapshot[];
    readonly accounting: PaperAccountingSnapshot;
    readonly orders: readonly PaperOrderMonitoringSnapshot[];
    readonly margin?: PaperMarginSafetySnapshot;
}

export interface PaperMonitoringInput {
    readonly evaluatedAt: string;
    readonly scenarios: readonly PaperScenarioMonitoringSnapshot[];
}

export interface PaperFreshnessResult {
    readonly sourceId: string;
    readonly state: PaperFreshnessState;
    readonly ageSeconds?: number;
}

export interface PaperMonitoringAlert {
    readonly virtualAccountId: string;
    readonly scenarioId: string;
    readonly severity: PaperMonitoringSeverity;
    readonly reasonCode: PaperMonitoringReasonCode;
    readonly subjectId: string;
    readonly dedupeKey: string;
}

export interface PaperScenarioMonitoringResult {
    readonly virtualAccountId: string;
    readonly scenarioId: string;
    readonly freshness: readonly PaperFreshnessResult[];
    readonly alerts: readonly PaperMonitoringAlert[];
    readonly status: 'ok' | 'failed';
    readonly failureReason?: string;
}

export interface PaperMonitoringResult {
    readonly evaluatedAt: string;
    readonly scenarios: readonly PaperScenarioMonitoringResult[];
    readonly alerts: readonly PaperMonitoringAlert[];
}

const requireId = (value: string, field: string) => {
    if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
        throw new TypeError(`${field} must be a trimmed non-empty string`);
    }
    if (value.includes('\u0000')) throw new TypeError(`${field} contains an unsupported character`);
};

const timestampMillis = (value: string, field: string) => {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) {
        throw new TypeError(`${field} must be an RFC3339 UTC timestamp`);
    }
    const milliseconds = Date.parse(value);
    if (!Number.isFinite(milliseconds)) throw new TypeError(`${field} must be a valid timestamp`);
    return milliseconds;
};

const freeze = <T extends object>(value: T): Readonly<T> => Object.freeze(value);
const alertKey = (accountId: string, scenarioId: string, reasonCode: PaperMonitoringReasonCode, subjectId: string) =>
    [accountId, scenarioId, reasonCode, subjectId].join('\u0000');

const makeAlert = (
    scenario: PaperScenarioMonitoringSnapshot,
    severity: PaperMonitoringSeverity,
    reasonCode: PaperMonitoringReasonCode,
    subjectId: string
): PaperMonitoringAlert => freeze({
    virtualAccountId: scenario.virtualAccountId,
    scenarioId: scenario.scenarioId,
    severity,
    reasonCode,
    subjectId,
    dedupeKey: alertKey(scenario.virtualAccountId, scenario.scenarioId, reasonCode, subjectId)
});

const freshnessFor = (source: PaperDataSourceSnapshot, evaluatedAtMs: number): PaperFreshnessResult => {
    requireId(source.sourceId, 'sourceId');
    if (!Number.isSafeInteger(source.maxAgeSeconds) || source.maxAgeSeconds < 0) {
        throw new TypeError('maxAgeSeconds must be a non-negative safe integer');
    }
    if (source.observedAt === undefined) return freeze({ sourceId: source.sourceId, state: 'missing' });
    const observedAtMs = timestampMillis(source.observedAt, 'observedAt');
    const ageSeconds = (evaluatedAtMs - observedAtMs) / 1_000;
    const state: PaperFreshnessState = ageSeconds < 0
        ? 'future'
        : ageSeconds > source.maxAgeSeconds ? 'stale' : 'fresh';
    return freeze({ sourceId: source.sourceId, state, ageSeconds });
};

const validateAccounting = (accounting: PaperAccountingSnapshot) => {
    for (const [field, value] of Object.entries({
        assetsKopecks: accounting.assetsKopecks,
        equityKopecks: accounting.equityKopecks,
        liabilitiesKopecks: accounting.liabilitiesKopecks
    })) {
        if (typeof value !== 'bigint') throw new TypeError(`${field} must be a bigint`);
    }
    if (accounting.invariantSatisfied
        && accounting.assetsKopecks !== accounting.equityKopecks + accounting.liabilitiesKopecks) {
        throw new Error('accounting snapshot claims a false invariant');
    }
};

const monitorScenario = (
    scenario: PaperScenarioMonitoringSnapshot,
    evaluatedAtMs: number
): PaperScenarioMonitoringResult => {
    requireId(scenario.virtualAccountId, 'virtualAccountId');
    requireId(scenario.scenarioId, 'scenarioId');
    validateAccounting(scenario.accounting);
    const sourceIds = new Set<string>();
    const freshness = [...scenario.dataSources].map(source => {
        if (sourceIds.has(source.sourceId)) throw new Error(`duplicate data source: ${source.sourceId}`);
        sourceIds.add(source.sourceId);
        return freshnessFor(source, evaluatedAtMs);
    }).sort((a, b) => a.sourceId.localeCompare(b.sourceId));
    const alerts: PaperMonitoringAlert[] = [];
    for (const item of freshness) {
        if (item.state === 'missing') alerts.push(makeAlert(scenario, 'critical', PAPER_MONITORING_REASON_CODES.freshnessMissing, item.sourceId));
        if (item.state === 'stale') alerts.push(makeAlert(scenario, 'warning', PAPER_MONITORING_REASON_CODES.freshnessStale, item.sourceId));
        if (item.state === 'future') alerts.push(makeAlert(scenario, 'critical', PAPER_MONITORING_REASON_CODES.freshnessFuture, item.sourceId));
    }
    if (!scenario.accounting.invariantSatisfied
        || scenario.accounting.assetsKopecks !== scenario.accounting.equityKopecks + scenario.accounting.liabilitiesKopecks) {
        alerts.push(makeAlert(scenario, 'critical', PAPER_MONITORING_REASON_CODES.accountingInvariant, 'accounting'));
    }
    const orderIds = new Set<string>();
    for (const order of scenario.orders) {
        requireId(order.orderId, 'orderId');
        if (orderIds.has(order.orderId)) throw new Error(`duplicate order snapshot: ${order.orderId}`);
        orderIds.add(order.orderId);
        if (!['known', 'unknown'].includes(order.state)) throw new TypeError('unsupported order state');
        if (order.state === 'unknown') alerts.push(makeAlert(scenario, 'critical', PAPER_MONITORING_REASON_CODES.orderUnknown, order.orderId));
        if (!order.reconciled) alerts.push(makeAlert(scenario, 'critical', PAPER_MONITORING_REASON_CODES.orderUnreconciled, order.orderId));
    }
    if (scenario.margin) {
        if (!scenario.margin.maintenanceSatisfied) alerts.push(makeAlert(scenario, 'critical', PAPER_MONITORING_REASON_CODES.maintenanceBreach, 'margin'));
        if (scenario.margin.reduceOnly) alerts.push(makeAlert(scenario, 'warning', PAPER_MONITORING_REASON_CODES.reduceOnly, 'margin'));
        if (scenario.margin.liquidationRequired) alerts.push(makeAlert(scenario, 'critical', PAPER_MONITORING_REASON_CODES.liquidationRequired, 'margin'));
    }
    const unique = [...new Map(alerts.map(alert => [alert.dedupeKey, alert])).values()]
        .sort((a, b) => a.dedupeKey.localeCompare(b.dedupeKey));
    return freeze({
        virtualAccountId: scenario.virtualAccountId,
        scenarioId: scenario.scenarioId,
        freshness: freeze(freshness),
        alerts: freeze(unique),
        status: 'ok' as const
    });
};

export const evaluatePaperMonitoring = (input: PaperMonitoringInput): PaperMonitoringResult => {
    const evaluatedAtMs = timestampMillis(input.evaluatedAt, 'evaluatedAt');
    const scenarioKeys = new Set<string>();
    const scenarios = [...input.scenarios].map(scenario => {
        requireId(scenario.virtualAccountId, 'virtualAccountId');
        requireId(scenario.scenarioId, 'scenarioId');
        const key = `${scenario.virtualAccountId}\u0000${scenario.scenarioId}`;
        if (scenarioKeys.has(key)) throw new Error(`duplicate monitoring scenario: ${scenario.scenarioId}`);
        scenarioKeys.add(key);
        try {
            return monitorScenario(scenario, evaluatedAtMs);
        } catch (error) {
            const alert = makeAlert(scenario, 'critical', PAPER_MONITORING_REASON_CODES.evaluationFailed, 'monitoring');
            return freeze({
                virtualAccountId: scenario.virtualAccountId,
                scenarioId: scenario.scenarioId,
                freshness: freeze([] as PaperFreshnessResult[]),
                alerts: freeze([alert]),
                status: 'failed' as const,
                failureReason: error instanceof Error ? error.message : String(error)
            });
        }
    }).sort((a, b) => `${a.virtualAccountId}\u0000${a.scenarioId}`.localeCompare(`${b.virtualAccountId}\u0000${b.scenarioId}`));
    const alerts = scenarios.flatMap(scenario => scenario.alerts);
    return freeze({ evaluatedAt: input.evaluatedAt, scenarios: freeze(scenarios), alerts: freeze(alerts) });
};
