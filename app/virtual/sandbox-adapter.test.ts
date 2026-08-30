import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
    decodeSandboxMoney, deterministicSandboxClientOrderId, SandboxTransport,
    SandboxTransportRequest, SandboxTransportResponse, TInvestSandboxAdapter
} from './sandbox-adapter';

class RecordingTransport implements SandboxTransport {
    readonly requests: SandboxTransportRequest[] = [];
    constructor(private readonly response: SandboxTransportResponse = { state: 'accepted' }) {}
    async execute(request: SandboxTransportRequest) {
        this.requests.push(request);
        return this.response;
    }
}

const order = { experimentId: 'experiment-a', intentId: 'intent-1', accountId: 'sandbox-account', instrumentId: 'SBER', side: 'buy' as const, quantityLots: 2, kind: 'limit' as const, priceKopecks: 12_345_678_901_234_567_890n };

describe('T-Invest sandbox adapter', () => {
    it('exposes unmistakable non-live labels and explicit limitations', () => {
        const adapter = new TInvestSandboxAdapter(new RecordingTransport());
        assert.deepStrictEqual(adapter.environment, { kind: 't-invest-sandbox', label: 'T-INVEST SANDBOX — VIRTUAL MONEY — NOT LIVE', isLive: false });
        assert.strictEqual(adapter.capabilities.virtualFunding, true);
        assert.ok(adapter.capabilities.limitations.some(value => value.includes('not a realistic margin model')));
        assert.ok(Object.isFrozen(adapter.capabilities.limitations));
    });

    it('maps account lifecycle and lossless virtual funding commands', async () => {
        const transport = new RecordingTransport();
        const adapter = new TInvestSandboxAdapter(transport);
        await adapter.openAccount('open-1');
        await adapter.fundAccount('fund-1', 'sandbox-account', 99_999_999_999_999_999_999n);
        await adapter.closeAccount('close-1', 'sandbox-account');
        assert.deepStrictEqual(transport.requests.map(value => value.operation), ['open-account', 'fund-account', 'close-account']);
        assert.strictEqual(transport.requests[1].amountKopecks, '99999999999999999999');
        assert.strictEqual(decodeSandboxMoney(transport.requests[1].amountKopecks as string), 99_999_999_999_999_999_999n);
        assert.throws(() => decodeSandboxMoney('01'), /canonical/);
    });

    it('creates deterministic client IDs and maps buy, sell and stop requests', async () => {
        const transport = new RecordingTransport();
        const adapter = new TInvestSandboxAdapter(transport);
        const firstId = deterministicSandboxClientOrderId('experiment-a', 'intent-1');
        assert.strictEqual(firstId, deterministicSandboxClientOrderId('experiment-a', 'intent-1'));
        assert.notStrictEqual(firstId, deterministicSandboxClientOrderId('experiment-b', 'intent-1'));
        await adapter.submitOrder(order);
        await adapter.submitOrder({ ...order, intentId: 'sell-market', side: 'sell', kind: 'market', priceKopecks: undefined });
        await adapter.submitStop({ ...order, intentId: 'stop-1', side: 'sell', kind: 'stop-loss', stopPriceKopecks: 12_000n, limitPriceKopecks: 11_900n });
        assert.deepStrictEqual(transport.requests[0], {
            environment: 't-invest-sandbox', operation: 'submit-order', commandId: firstId,
            clientOrderId: firstId, accountId: 'sandbox-account', instrumentId: 'SBER', side: 'buy',
            quantityLots: 2, orderKind: 'limit', priceKopecks: '12345678901234567890'
        });
        assert.strictEqual(transport.requests[1].priceKopecks, undefined);
        assert.deepStrictEqual([transport.requests[2].stopKind, transport.requests[2].stopPriceKopecks, transport.requests[2].limitPriceKopecks], ['stop-loss', '12000', '11900']);
    });

    it('deduplicates identical commands and rejects ID conflicts without another call', async () => {
        const transport = new RecordingTransport({ state: 'accepted', brokerOrderId: 'broker-1' });
        const adapter = new TInvestSandboxAdapter(transport);
        const first = adapter.submitOrder(order);
        const repeated = adapter.submitOrder({ ...order });
        assert.strictEqual(repeated, first);
        assert.strictEqual((await repeated).brokerOrderId, 'broker-1');
        assert.strictEqual(transport.requests.length, 1);
        assert.throws(() => adapter.submitOrder({ ...order, quantityLots: 3 }), /ID conflict/);
        assert.strictEqual(transport.requests.length, 1);
    });

    it('turns ambiguous responses and transport failures into non-retryable reconciliation states', async () => {
        const unknownTransport = new RecordingTransport({ state: 'unknown' });
        const unknownAdapter = new TInvestSandboxAdapter(unknownTransport);
        const unknown = await unknownAdapter.submitOrder(order);
        assert.strictEqual(unknown.state, 'unknown-reconcile-required');
        assert.strictEqual(unknown.retryAllowed, false);
        await unknownAdapter.submitOrder({ ...order });
        assert.strictEqual(unknownTransport.requests.length, 1);

        const failedTransport: SandboxTransport = { execute: async () => { throw new Error('timeout after submit'); } };
        const failed = await new TInvestSandboxAdapter(failedTransport).submitOrder(order);
        assert.deepStrictEqual([failed.state, failed.retryAllowed], ['unknown-reconcile-required', false]);
    });

    it('validates order shapes before crossing the transport boundary', () => {
        const transport = new RecordingTransport();
        const adapter = new TInvestSandboxAdapter(transport);
        assert.throws(() => adapter.submitOrder({ ...order, kind: 'market', priceKopecks: 1n }), /must not include/);
        assert.throws(() => adapter.submitOrder({ ...order, priceKopecks: undefined }), /requires/);
        assert.throws(() => adapter.fundAccount('fund', 'sandbox-account', -1n), /positive bigint/);
        assert.strictEqual(transport.requests.length, 0);
    });

    it('fails closed for malformed responses and accepted results without required identities', async () => {
        const malformed = new TInvestSandboxAdapter({ execute: async () => ({ state: 'surprise' } as never) });
        assert.strictEqual((await malformed.openAccount('bad-state')).state, 'unknown-reconcile-required');

        const noAccount = new TInvestSandboxAdapter(new RecordingTransport({ state: 'accepted' }));
        assert.match((await noAccount.openAccount('no-account')).reason ?? '', /no account ID/);

        const noOrder = new TInvestSandboxAdapter(new RecordingTransport({ state: 'accepted' }));
        assert.match((await noOrder.submitOrder(order)).reason ?? '', /no broker order ID/);

        const badIdentity = new TInvestSandboxAdapter(new RecordingTransport({ state: 'pending', brokerOrderId: ' bad ' }));
        const result = await badIdentity.getOrderState('bad-id', 'account', 'broker');
        assert.deepStrictEqual([result.state, result.retryAllowed], ['unknown-reconcile-required', false]);
    });
});
