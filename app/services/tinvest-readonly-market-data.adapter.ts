import { createHash } from 'node:crypto';
import type {
    ReadonlyMarketDataPort,
    ReadonlyMarketDataQuote
} from '../market-observation/tinvest-readonly-market-data.port';
import type { MarketSessionStatus } from '../market-observation/types';

interface SdkQuotation {
    readonly units: number;
    readonly nano: number;
}

interface SdkOrderBookLevel {
    readonly price?: SdkQuotation;
}

interface SdkOrderBook {
    readonly instrumentUid: string;
    readonly bids?: readonly SdkOrderBookLevel[];
    readonly asks?: readonly SdkOrderBookLevel[];
    readonly orderbookTs?: Date;
}

interface SdkTradingStatus {
    readonly instrumentUid: string;
    readonly tradingStatus: number;
}

export interface TInvestReadonlyMarketDataClient {
    getTradingStatuses(request: { instrumentId: string[] }): Promise<{
        tradingStatuses?: readonly SdkTradingStatus[];
    }>;
    getOrderBook(request: { instrumentId: string; depth: number }): Promise<SdkOrderBook>;
}

const NANO_PER_UNIT = 1_000_000_000n;
const NANO_PER_KOPECK = 10_000_000n;
const NORMAL_TRADING = 5;
const BREAK_IN_TRADING = 4;
const DEALER_BREAK_IN_TRADING = 15;

const requiredUid = (value: string, field: string): string => {
    const normalized = value.trim();
    if (!normalized) throw new TypeError(`${field} must be non-empty`);
    if (normalized !== value) throw new TypeError(`${field} must be canonical`);
    return normalized;
};

const exactKopecks = (quotation: SdkQuotation | undefined, field: string): bigint => {
    if (!quotation) throw new TypeError(`${field} price is missing`);
    if (!Number.isSafeInteger(quotation.units)) throw new TypeError(`${field}.units must be a safe integer`);
    if (!Number.isInteger(quotation.nano) || Math.abs(quotation.nano) >= Number(NANO_PER_UNIT)) {
        throw new TypeError(`${field}.nano must be an integer with absolute value below 1e9`);
    }
    const nanos = BigInt(quotation.units) * NANO_PER_UNIT + BigInt(quotation.nano);
    if (nanos % NANO_PER_KOPECK !== 0n) throw new RangeError(`${field} must be an exact whole kopeck`);
    const kopecks = nanos / NANO_PER_KOPECK;
    if (kopecks <= 0n) throw new RangeError(`${field} must be positive`);
    return kopecks;
};

const canonicalBrokerTimestamp = (value: Date | undefined): string => {
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
        throw new TypeError('orderbookTs must be an exact broker timestamp');
    }
    return value.toISOString();
};

const sessionStatus = (value: number): MarketSessionStatus => {
    if (value === NORMAL_TRADING) return 'open';
    if (value === BREAK_IN_TRADING || value === DEALER_BREAK_IN_TRADING) return 'break';
    return 'closed';
};

const identity = (
    uid: string,
    timestamp: string,
    bid: bigint,
    ask: bigint,
    status: MarketSessionStatus
): {
    observationId: string;
    sourceSequence: string;
} => {
    const sourceSequence = `${uid}:${timestamp}:${bid.toString()}:${ask.toString()}:${status}`;
    return {
        observationId: createHash('sha256').update(sourceSequence).digest('hex'),
        sourceSequence
    };
};

export class TInvestReadonlyMarketDataAdapter implements ReadonlyMarketDataPort {
    constructor(private readonly client: TInvestReadonlyMarketDataClient) {}

    async readOrderBookTop(instrumentUids: readonly string[]): Promise<readonly ReadonlyMarketDataQuote[]> {
        const requested = instrumentUids.map(uid => requiredUid(uid, 'instrumentUid'));
        if (new Set(requested).size !== requested.length) throw new Error('duplicate requested instrument UID');
        if (requested.length === 0) return [];

        const statusResponse = await this.client.getTradingStatuses({ instrumentId: [...requested] });
        const statuses = new Map<string, number>();
        for (const status of statusResponse.tradingStatuses ?? []) {
            const uid = requiredUid(status.instrumentUid, 'trading status instrumentUid');
            if (!requested.includes(uid)) throw new Error(`trading status returned unrequested instrument ${uid}`);
            if (statuses.has(uid)) throw new Error(`duplicate trading status for instrument ${uid}`);
            if (!Number.isInteger(status.tradingStatus)) throw new TypeError(`invalid trading status for instrument ${uid}`);
            statuses.set(uid, status.tradingStatus);
        }
        if (statuses.size !== requested.length) throw new Error('trading status batch has incomplete instrument coverage');

        return Promise.all(requested.map(async uid => {
            const book = await this.client.getOrderBook({ instrumentId: uid, depth: 1 });
            const returnedUid = requiredUid(book.instrumentUid, 'order book instrumentUid');
            if (returnedUid !== uid) throw new Error(`order book instrument UID mismatch for ${uid}`);
            if (book.bids?.length !== 1 || book.asks?.length !== 1) {
                throw new Error(`order book must contain exactly one bid and ask for ${uid}`);
            }
            const bidKopecks = exactKopecks(book.bids[0].price, 'bid');
            const askKopecks = exactKopecks(book.asks[0].price, 'ask');
            if (bidKopecks > askKopecks) throw new RangeError(`crossed order book for ${uid}`);
            const brokerObservedAt = canonicalBrokerTimestamp(book.orderbookTs);
            const mappedSessionStatus = sessionStatus(statuses.get(uid)!);
            const stable = identity(uid, brokerObservedAt, bidKopecks, askKopecks, mappedSessionStatus);
            return Object.freeze({
                sourceObservationId: stable.observationId,
                instrumentUid: uid,
                brokerObservedAt,
                bidKopecks,
                askKopecks,
                sourceSequence: stable.sourceSequence,
                sessionStatus: mappedSessionStatus
            });
        }));
    }
}
