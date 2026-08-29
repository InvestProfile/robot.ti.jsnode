import type { ShadowDecisionObservation } from './shadow-intent.adapter';
import { normalizeRfc3339Timestamp } from '../virtual/codecs';

export interface ShadowObservationRepository {
    append(observation: ShadowDecisionObservation): Promise<void>;
    list(virtualAccountId: string): Promise<readonly ShadowDecisionObservation[]>;
}

const requireTrimmed = (value: string, field: string) => {
    if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
        throw new TypeError(`${field} must be a trimmed non-empty string`);
    }
};

export const canonicalShadowObservation = (
    observation: ShadowDecisionObservation
): ShadowDecisionObservation => {
    requireTrimmed(observation.decisionId, 'observation.decisionId');
    requireTrimmed(observation.virtualAccountId, 'observation.virtualAccountId');
    requireTrimmed(observation.instrumentId, 'observation.instrumentId');
    requireTrimmed(observation.reason, 'observation.reason');
    if (!['buy', 'sell', 'hold', 'skip'].includes(observation.action)) {
        throw new TypeError('observation.action is invalid');
    }
    if (!['allowed', 'blocked', 'hold'].includes(observation.status)) {
        throw new TypeError('observation.status is invalid');
    }
    if (observation.source !== undefined) requireTrimmed(observation.source, 'observation.source');
    if (observation.orderId !== undefined) requireTrimmed(observation.orderId, 'observation.orderId');
    return Object.freeze({
        ...observation,
        evaluatedAt: normalizeRfc3339Timestamp(observation.evaluatedAt)
    });
};

export const shadowObservationFingerprint = (observation: ShadowDecisionObservation) =>
    JSON.stringify({
        decisionId: observation.decisionId,
        virtualAccountId: observation.virtualAccountId,
        instrumentId: observation.instrumentId,
        evaluatedAt: observation.evaluatedAt,
        action: observation.action,
        status: observation.status,
        source: observation.source ?? null,
        reason: observation.reason,
        orderId: observation.orderId ?? null
    });

export class InMemoryShadowObservationRepository implements ShadowObservationRepository {
    readonly #accounts = new Map<string, Map<string, {
        fingerprint: string;
        observation: ShadowDecisionObservation;
    }>>();

    async append(observation: ShadowDecisionObservation): Promise<void> {
        const canonical = canonicalShadowObservation(observation);
        const fingerprint = shadowObservationFingerprint(canonical);
        const account = this.#accounts.get(canonical.virtualAccountId) ?? new Map();
        const existing = account.get(canonical.decisionId);
        if (existing) {
            if (existing.fingerprint !== fingerprint) {
                throw new Error(`shadow observation ID conflict: ${canonical.decisionId}`);
            }
            return;
        }
        account.set(canonical.decisionId, {
            fingerprint,
            observation: canonical
        });
        this.#accounts.set(canonical.virtualAccountId, account);
    }

    async list(virtualAccountId: string): Promise<readonly ShadowDecisionObservation[]> {
        return Object.freeze(Array.from(this.#accounts.get(virtualAccountId)?.values() ?? [],
            item => item.observation));
    }
}
