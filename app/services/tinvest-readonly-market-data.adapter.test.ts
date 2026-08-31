import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    TInvestReadonlyMarketDataAdapter,
    type TInvestReadonlyMarketDataClient
} from './tinvest-readonly-market-data.adapter';

const quote = (units: number, nano = 0) => ({ units, nano });

const client = (overrides: Partial<TInvestReadonlyMarketDataClient> = {}) => {
    const statusRequests: unknown[] = [];
    const bookRequests: unknown[] = [];
    const implementation: TInvestReadonlyMarketDataClient = {
        getTradingStatuses: async request => {
            statusRequests.push(request);
            return { tradingStatuses: request.instrumentId.map(instrumentUid => ({ instrumentUid, tradingStatus: 5 })) };
        },
        getOrderBook: async request => {
            bookRequests.push(request);
            return {
                instrumentUid: request.instrumentId,
                bids: [{ price: quote(123, 450_000_000) }],
                asks: [{ price: quote(123, 470_000_000) }],
                orderbookTs: new Date('2026-08-31T12:34:56.789Z')
            };
        },
        ...overrides
    };
    return { implementation, statusRequests, bookRequests };
};

describe('TInvestReadonlyMarketDataAdapter', () => {
    it('batches statuses, requests depth-one books and emits stable exact quotes', async () => {
        const fake = client();
        const adapter = new TInvestReadonlyMarketDataAdapter(fake.implementation);
        const first = await adapter.readOrderBookTop(['uid-b', 'uid-a']);
        const replay = await adapter.readOrderBookTop(['uid-b', 'uid-a']);

        assert.deepEqual(fake.statusRequests[0], { instrumentId: ['uid-b', 'uid-a'] });
        assert.deepEqual(fake.bookRequests.slice(0, 2), [
            { instrumentId: 'uid-b', depth: 1 }, { instrumentId: 'uid-a', depth: 1 }
        ]);
        assert.equal(first[0].bidKopecks, 12_345n);
        assert.equal(first[0].askKopecks, 12_347n);
        assert.equal(first[0].brokerObservedAt, '2026-08-31T12:34:56.789Z');
        assert.equal(first[0].sessionStatus, 'open');
        assert.match(first[0].sourceObservationId, /^[0-9a-f]{64}$/);
        assert.equal(first[0].sourceObservationId, replay[0].sourceObservationId);
        assert.equal(first[0].sourceSequence, replay[0].sourceSequence);
    });

    it('maps break statuses and closes dealer, auction and unknown statuses fail-safe', async () => {
        const fake = client({
            getTradingStatuses: async request => ({ tradingStatuses: request.instrumentId.map((instrumentUid, index) => ({
                instrumentUid, tradingStatus: [4, 15, 14, 6, 999][index]
            })) })
        });
        const quotes = await new TInvestReadonlyMarketDataAdapter(fake.implementation)
            .readOrderBookTop(['break', 'dealer-break', 'dealer', 'auction', 'unknown']);
        assert.deepEqual(quotes.map(item => item.sessionStatus), ['break', 'break', 'closed', 'closed', 'closed']);
    });

    it('includes mapped session status in stable source identity', async () => {
        const withStatus = (tradingStatus: number) => client({
            getTradingStatuses: async request => ({
                tradingStatuses: request.instrumentId.map(instrumentUid => ({ instrumentUid, tradingStatus }))
            })
        }).implementation;
        const open = (await new TInvestReadonlyMarketDataAdapter(withStatus(5)).readOrderBookTop(['uid']))[0];
        const tradingBreak = (await new TInvestReadonlyMarketDataAdapter(withStatus(4)).readOrderBookTop(['uid']))[0];

        assert.equal(open.instrumentUid, tradingBreak.instrumentUid);
        assert.equal(open.brokerObservedAt, tradingBreak.brokerObservedAt);
        assert.equal(open.bidKopecks, tradingBreak.bidKopecks);
        assert.equal(open.askKopecks, tradingBreak.askKopecks);
        assert.equal(open.sessionStatus, 'open');
        assert.equal(tradingBreak.sessionStatus, 'break');
        assert.notEqual(open.sourceSequence, tradingBreak.sourceSequence);
        assert.notEqual(open.sourceObservationId, tradingBreak.sourceObservationId);
        assert.notDeepEqual(open, tradingBreak);
    });

    it('requires exact status coverage and exact returned instrument identities', async () => {
        const missing = client({ getTradingStatuses: async () => ({ tradingStatuses: [] }) });
        await assert.rejects(
            new TInvestReadonlyMarketDataAdapter(missing.implementation).readOrderBookTop(['uid']),
            /incomplete instrument coverage/
        );

        const mismatch = client({
            getOrderBook: async () => ({ instrumentUid: 'wrong', bids: [{ price: quote(1) }],
                asks: [{ price: quote(2) }], orderbookTs: new Date() })
        });
        await assert.rejects(
            new TInvestReadonlyMarketDataAdapter(mismatch.implementation).readOrderBookTop(['uid']),
            /UID mismatch/
        );
    });

    it('rejects missing timestamps, sides, sub-kopeck prices and crossed books', async () => {
        for (const [book, expected] of [
            [{ instrumentUid: 'uid', bids: [{ price: quote(1) }], asks: [{ price: quote(2) }] }, /orderbookTs/],
            [{ instrumentUid: 'uid', bids: [], asks: [{ price: quote(2) }], orderbookTs: new Date() }, /exactly one bid and ask/],
            [{ instrumentUid: 'uid', bids: [{ price: quote(1, 1) }], asks: [{ price: quote(2) }], orderbookTs: new Date() }, /whole kopeck/],
            [{ instrumentUid: 'uid', bids: [{ price: quote(2) }], asks: [{ price: quote(1) }], orderbookTs: new Date() }, /crossed/]
        ] as const) {
            const fake = client({ getOrderBook: async () => book });
            await assert.rejects(
                new TInvestReadonlyMarketDataAdapter(fake.implementation).readOrderBookTop(['uid']), expected
            );
        }
    });

    it('rejects blank or duplicate requests without calling the SDK and does not call SDK for empty input', async () => {
        const fake = client();
        const adapter = new TInvestReadonlyMarketDataAdapter(fake.implementation);
        await assert.rejects(adapter.readOrderBookTop(['']), /non-empty/);
        await assert.rejects(adapter.readOrderBookTop(['uid', 'uid']), /duplicate/);
        assert.deepEqual(await adapter.readOrderBookTop([]), []);
        assert.equal(fake.statusRequests.length, 0);
        assert.equal(fake.bookRequests.length, 0);
    });
});
