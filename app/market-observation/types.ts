import { createHash } from 'node:crypto';

export const MARKET_MARK_SOURCE = 't-invest-market-data-readonly' as const;
export type MarketSessionStatus = 'open' | 'closed' | 'break';

export interface BrokerMarketMarkInput {
    readonly observationId: string;
    readonly sourceIdentity: string;
    readonly instrumentUid: string;
    readonly brokerObservedAt: string;
    readonly receivedAt: string;
    readonly bidKopecks: bigint;
    readonly askKopecks: bigint;
    readonly markKopecks: bigint;
    readonly source: typeof MARKET_MARK_SOURCE;
    readonly sessionStatus: MarketSessionStatus;
    readonly sourceSequence?: string;
}

export interface BrokerMarketMark extends BrokerMarketMarkInput {
    readonly payloadFingerprint: string;
}

const requiredText = (value: string, field: string): string => {
    const normalized = value.trim();
    if (!normalized) throw new TypeError(`${field} must be non-empty`);
    return normalized;
};

const canonicalTimestamp = (value: string, field: string): string => {
    const timestamp = requiredText(value, field);
    const epoch = Date.parse(timestamp);
    if (!Number.isFinite(epoch) || new Date(epoch).toISOString() !== timestamp) {
        throw new TypeError(`${field} must be a canonical ISO-8601 UTC timestamp`);
    }
    return timestamp;
};

const canonicalMoney = (value: bigint, field: string): bigint => {
    if (typeof value !== 'bigint') throw new TypeError(`${field} must be bigint kopecks`);
    if (value <= 0n) throw new RangeError(`${field} must be positive`);
    return value;
};

const canonicalPayload = (mark: BrokerMarketMarkInput): string => JSON.stringify({
    observationId: mark.observationId,
    sourceIdentity: mark.sourceIdentity,
    instrumentUid: mark.instrumentUid,
    brokerObservedAt: mark.brokerObservedAt,
    receivedAt: mark.receivedAt,
    bidKopecks: mark.bidKopecks.toString(),
    askKopecks: mark.askKopecks.toString(),
    markKopecks: mark.markKopecks.toString(),
    source: mark.source,
    sessionStatus: mark.sessionStatus,
    sourceSequence: mark.sourceSequence ?? null
});

export const marketMarkFingerprint = (mark: BrokerMarketMarkInput): string =>
    createHash('sha256').update(canonicalPayload(mark)).digest('hex');

export const createBrokerMarketMark = (input: BrokerMarketMarkInput): BrokerMarketMark => {
    const bidKopecks = canonicalMoney(input.bidKopecks, 'bidKopecks');
    const askKopecks = canonicalMoney(input.askKopecks, 'askKopecks');
    const markKopecks = canonicalMoney(input.markKopecks, 'markKopecks');
    if (bidKopecks > askKopecks) throw new RangeError('market mark is crossed: bidKopecks exceeds askKopecks');
    if (markKopecks < bidKopecks || markKopecks > askKopecks) {
        throw new RangeError('markKopecks must be within bid/ask');
    }
    const sourceSequence = input.sourceSequence?.trim();
    const canonical: BrokerMarketMarkInput = {
        observationId: requiredText(input.observationId, 'observationId'),
        sourceIdentity: requiredText(input.sourceIdentity, 'sourceIdentity'),
        instrumentUid: requiredText(input.instrumentUid, 'instrumentUid'),
        brokerObservedAt: canonicalTimestamp(input.brokerObservedAt, 'brokerObservedAt'),
        receivedAt: canonicalTimestamp(input.receivedAt, 'receivedAt'),
        bidKopecks,
        askKopecks,
        markKopecks,
        source: input.source,
        sessionStatus: input.sessionStatus,
        ...(sourceSequence ? { sourceSequence } : {})
    };
    if (canonical.source !== MARKET_MARK_SOURCE) throw new TypeError('unsupported market mark source');
    if (!['open', 'closed', 'break'].includes(canonical.sessionStatus)) {
        throw new TypeError('unsupported market session status');
    }
    return Object.freeze({ ...canonical, payloadFingerprint: marketMarkFingerprint(canonical) });
};

export const assertSameMarketMarkIdentity = (
    persisted: BrokerMarketMark,
    replayed: BrokerMarketMark
): BrokerMarketMark => {
    if (persisted.observationId !== replayed.observationId) {
        throw new Error('market mark observation identity mismatch');
    }
    if (persisted.sourceIdentity !== replayed.sourceIdentity) {
        throw new Error(`market mark source identity conflict: ${persisted.observationId}`);
    }
    if (persisted.payloadFingerprint !== replayed.payloadFingerprint) {
        throw new Error(`market mark payload conflict: ${persisted.observationId}`);
    }
    return persisted;
};

export const assertUniqueMarketMarkIdentities = (marks: readonly BrokerMarketMark[]): void => {
    const byObservationId = new Map<string, BrokerMarketMark>();
    const bySourceIdentity = new Map<string, BrokerMarketMark>();
    for (const mark of marks) {
        const byId = byObservationId.get(mark.observationId);
        if (byId) assertSameMarketMarkIdentity(byId, mark);
        const bySource = bySourceIdentity.get(mark.sourceIdentity);
        if (bySource && bySource.payloadFingerprint !== mark.payloadFingerprint) {
            throw new Error(`market mark source identity payload conflict: ${mark.sourceIdentity}`);
        }
        byObservationId.set(mark.observationId, mark);
        bySourceIdentity.set(mark.sourceIdentity, mark);
    }
};
