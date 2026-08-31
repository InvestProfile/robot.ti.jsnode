import { createHash } from 'node:crypto';
import type { RobotConfig } from '../config/robot.config';
import type { ShadowDecisionAction, ShadowDecisionStatus, ShadowSourceTickDraft } from '../paper/shadow-source-outbox';

export const SHADOW_SOURCE_POLICY_VERSION = 'post-risk-v2-rounded-number-price-captured-after-read';
const DEFAULT_QUEUE_CAPACITY = 256;

export interface PostRiskSourceDecision {
    readonly sourceTradingTickId: string;
    readonly accountId: string;
    readonly instrumentId: string;
    readonly action: ShadowDecisionAction;
    readonly status: ShadowDecisionStatus;
    readonly approvedLots: number;
    readonly lotSize: number;
    readonly reason: string;
    readonly evaluatedAt: string;
    readonly priceRub: number;
    readonly quoteObservedAt: string;
    readonly quoteTimestampQuality: 'captured-after-read';
}

export interface ShadowSourceTickPublisher { publish(draft: ShadowSourceTickDraft): Promise<unknown>; }
export interface PostRiskOutboxProducer { enqueue(decision: PostRiskSourceDecision): boolean; }
export interface PostRiskOutboxRuntimeState {
    enabled: boolean; queueDepth: number; enqueued: number; published: number; dropped: number; failed: number;
    lastPublishedAt?: string; lastDropAt?: string; lastErrorAt?: string; lastError?: string;
}

const runtimeState: PostRiskOutboxRuntimeState = {
    enabled: false, queueDepth: 0, enqueued: 0, published: 0, dropped: 0, failed: 0
};
let processProducer: PostRiskOutboxProducer | undefined;
let processProducerFingerprint: string | undefined;
let processProducerInitialization: Promise<PostRiskOutboxProducer | undefined> | undefined;
let processProducerInitializationFingerprint: string | undefined;
export const getPostRiskOutboxRuntimeState = () => ({ ...runtimeState });

const stable = (value: unknown): unknown => {
    if (typeof value === 'bigint') return value.toString();
    if (Array.isArray(value)) return value.map(stable);
    if (value && typeof value === 'object') return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
            .map(([key, item]) => [key, stable(item)])
    );
    return value;
};
const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');

export const shadowStrategyConfigFingerprint = (config: RobotConfig) => {
    const { liveAllowedActions: _actions, dryRun: _dryRun, liveConfirmationRequired: _confirmation,
        tradingPaused: _paused, shadowSourceOutboxEnabled: _outbox, ...strategyConfig } = config;
    return fingerprint(strategyConfig);
};

const roundedRubNumberToKopecks = (value: number) => {
    if (!Number.isFinite(value) || value <= 0) throw new TypeError('source priceRub must be positive');
    const kopecks = Math.round(value * 100);
    if (!Number.isSafeInteger(kopecks) || kopecks <= 0) throw new TypeError('rounded source price is outside safe integer range');
    return BigInt(kopecks);
};

const validateDecision = (decision: PostRiskSourceDecision) => {
    if (!decision.accountId?.trim() || !decision.instrumentId?.trim() || !decision.reason?.trim()) {
        throw new TypeError('source account, instrument and reason are required');
    }
    if (!Number.isSafeInteger(decision.lotSize) || decision.lotSize <= 0) throw new TypeError('lotSize must be a positive safe integer');
    const executable = decision.status === 'allowed' && (decision.action === 'buy' || decision.action === 'sell');
    if (executable && (!Number.isSafeInteger(decision.approvedLots) || decision.approvedLots <= 0)) {
        throw new TypeError('allowed trade decision requires positive safe integer approvedLots');
    }
    if (!executable && decision.approvedLots !== 0) throw new TypeError('blocked/hold decision must approve zero lots');
    if (decision.quoteTimestampQuality !== 'captured-after-read') throw new TypeError('unsupported quote timestamp quality');
    if (!Number.isFinite(Date.parse(decision.evaluatedAt)) || !Number.isFinite(Date.parse(decision.quoteObservedAt))) {
        throw new TypeError('source timestamps are invalid');
    }
    return roundedRubNumberToKopecks(decision.priceRub);
};

const buildDraft = (decision: PostRiskSourceDecision, configFingerprint: string, completedAt: string): ShadowSourceTickDraft => {
    const priceKopecks = validateDecision(decision);
    const identity = fingerprint({ sourceTradingTickId: decision.sourceTradingTickId, accountId: decision.accountId,
        instrumentId: decision.instrumentId, action: decision.action, status: decision.status,
        approvedLots: decision.approvedLots, lotSize: decision.lotSize, configFingerprint });
    const sourceTickId = `live-post-risk:${identity}`;
    const eventId = `${sourceTickId}:decision`;
    return Object.freeze({
        sourceTickId, startedAt: decision.evaluatedAt, completedAt, expectedEventCount: 1,
        policyVersion: SHADOW_SOURCE_POLICY_VERSION, configFingerprint,
        events: Object.freeze([Object.freeze({
            kind: 'decision' as const, eventId, decisionId: eventId, sourceAccountId: decision.accountId,
            instrumentId: decision.instrumentId, action: decision.action, status: decision.status,
            approvedLots: decision.approvedLots, lotSize: decision.lotSize, reason: decision.reason,
            evaluatedAt: decision.evaluatedAt,
            quote: Object.freeze({ bidKopecks: priceKopecks, askKopecks: priceKopecks, markKopecks: priceKopecks,
                quoteObservedAt: decision.quoteObservedAt, quoteTimestampQuality: decision.quoteTimestampQuality })
        })])
    });
};

export const createPostRiskOutboxProducer = (
    publisher: ShadowSourceTickPublisher,
    configFingerprint: string,
    options: { capacity?: number; now?: () => Date } = {}
): PostRiskOutboxProducer => {
    const capacity = options.capacity ?? DEFAULT_QUEUE_CAPACITY;
    const now = options.now ?? (() => new Date());
    if (!Number.isSafeInteger(capacity) || capacity <= 0) throw new TypeError('queue capacity must be positive');
    const queue: ShadowSourceTickDraft[] = [];
    const acceptedPayloads = new Map<string, string>();
    let draining = false;
    const drain = () => {
        if (draining) return;
        draining = true;
        void (async () => {
            while (queue.length > 0) {
                const draft = queue[0];
                try {
                    await publisher.publish(draft);
                    runtimeState.published += 1;
                    runtimeState.lastPublishedAt = now().toISOString();
                } catch (error) {
                    runtimeState.failed += 1;
                    runtimeState.lastErrorAt = now().toISOString();
                    runtimeState.lastError = error instanceof Error ? error.message : String(error);
                    console.error('Shadow source outbox publish failed; virtual evidence dropped, live execution unchanged:', {
                        sourceTickId: draft.sourceTickId, error: runtimeState.lastError
                    });
                } finally {
                    queue.shift();
                    runtimeState.queueDepth = queue.length;
                }
            }
        })().finally(() => { draining = false; if (queue.length > 0) drain(); });
    };
    return {
        enqueue(decision) {
            let draft: ShadowSourceTickDraft;
            try { draft = buildDraft(decision, configFingerprint, now().toISOString()); }
            catch (error) {
                runtimeState.dropped += 1;
                runtimeState.lastDropAt = now().toISOString();
                runtimeState.lastError = error instanceof Error ? error.message : String(error);
                return false;
            }
            const payloadFingerprint = fingerprint(draft);
            const accepted = acceptedPayloads.get(draft.sourceTickId);
            if (accepted) {
                if (accepted !== payloadFingerprint) {
                    runtimeState.dropped += 1;
                    runtimeState.lastDropAt = now().toISOString();
                    runtimeState.lastError = 'shadow source logical identity payload conflict; first payload retained';
                }
                return accepted === payloadFingerprint;
            }
            if (queue.length >= capacity) {
                runtimeState.dropped += 1;
                runtimeState.lastDropAt = now().toISOString();
                runtimeState.lastError = 'shadow source outbox queue overflow';
                return false;
            }
            acceptedPayloads.set(draft.sourceTickId, payloadFingerprint);
            if (acceptedPayloads.size > capacity * 4) {
                const oldest = acceptedPayloads.keys().next().value as string | undefined;
                if (oldest) acceptedPayloads.delete(oldest);
            }
            queue.push(draft);
            runtimeState.enqueued += 1;
            runtimeState.queueDepth = queue.length;
            queueMicrotask(drain);
            return true;
        }
    };
};

export const createConfiguredPostRiskOutboxProducer = async (
    config: RobotConfig, factory?: () => Promise<ShadowSourceTickPublisher>
): Promise<PostRiskOutboxProducer | undefined> => {
    runtimeState.enabled = config.shadowSourceOutboxEnabled;
    if (!config.shadowSourceOutboxEnabled) return undefined;
    const configFingerprint = shadowStrategyConfigFingerprint(config);
    if (processProducer) {
        if (processProducerFingerprint !== configFingerprint) {
            runtimeState.failed += 1;
            runtimeState.lastErrorAt = new Date().toISOString();
            runtimeState.lastError = 'shadow source outbox rejected process-lifetime strategy reconfiguration';
            return undefined;
        }
        return processProducer;
    }
    if (processProducerInitialization) {
        if (processProducerInitializationFingerprint !== configFingerprint) {
            runtimeState.failed += 1;
            runtimeState.lastErrorAt = new Date().toISOString();
            runtimeState.lastError = 'shadow source outbox rejected concurrent strategy reconfiguration';
            return undefined;
        }
        return processProducerInitialization;
    }
    processProducerInitializationFingerprint = configFingerprint;
    processProducerInitialization = (async () => { try {
        const publisher = factory ? await factory() : await (async () => {
            const [{ createOutboxDatabase }, { SequelizeShadowSourceOutbox }] = await Promise.all([
                import('../config/outbox-database'), import('../paper/shadow-source-outbox')
            ]);
            return new SequelizeShadowSourceOutbox(createOutboxDatabase(), Math.max(5_000, config.intervalMs));
        })();
        processProducer = createPostRiskOutboxProducer(publisher, configFingerprint);
        processProducerFingerprint = configFingerprint;
        return processProducer;
    } catch (error) {
        runtimeState.failed += 1;
        runtimeState.lastErrorAt = new Date().toISOString();
        runtimeState.lastError = error instanceof Error ? error.message : String(error);
        console.error('Shadow source outbox unavailable; virtual evidence disabled, live execution unchanged:', { error: runtimeState.lastError });
        return undefined;
    } finally { processProducerInitialization = undefined; processProducerInitializationFingerprint = undefined; } })();
    return processProducerInitialization;
};

export const sourceTradingTickIdFor = (startedAt: string, intervalMs: number) => {
    const started = Date.parse(startedAt);
    if (!Number.isFinite(started) || !Number.isSafeInteger(intervalMs) || intervalMs <= 0) {
        throw new TypeError('valid tick start and positive interval are required');
    }
    const bucket = Math.floor(started / intervalMs) * intervalMs;
    return `trading:${intervalMs}:${new Date(bucket).toISOString()}`;
};

export const sourceTradingTickIdForProducer = (
    producer: PostRiskOutboxProducer | undefined,
    startedAt: string,
    intervalMs: number
) => producer ? sourceTradingTickIdFor(startedAt, intervalMs) : undefined;

export const resetPostRiskOutboxSingletonForTests = () => {
    processProducer = undefined;
    processProducerFingerprint = undefined;
    processProducerInitialization = undefined;
    processProducerInitializationFingerprint = undefined;
    Object.assign(runtimeState, { enabled: false, queueDepth: 0, enqueued: 0, published: 0, dropped: 0, failed: 0,
        lastPublishedAt: undefined, lastDropAt: undefined, lastErrorAt: undefined, lastError: undefined });
};

export const runLiveOperationAfterShadowEnqueue = <T>(
    producer: PostRiskOutboxProducer | undefined, decision: PostRiskSourceDecision | undefined, operation: () => T
): T => {
    if (producer && decision) producer.enqueue(decision);
    return operation();
};
