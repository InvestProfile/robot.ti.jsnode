import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    decodePaperLabCursor,
    encodePaperLabCursor,
    PaperLabReadModelService,
    PaperLabReadModelStore,
    parsePaperLabLimit,
    serializePaperKopecks
} from './paper-lab-read-model.service';

const emptyStore = (listAccounts: PaperLabReadModelStore['listAccounts']): PaperLabReadModelStore => ({
    listAccounts,
    async findAccount() { return null; },
    async listOrders() { return []; },
    async listFills() { return []; },
    async listReconciliationFills() { return []; },
    async listReconciliationLedger() { return []; },
    async listDecisions() { return []; }
});

describe('Paper Lab bounded read model', () => {
    it('serializes bigint money losslessly', () => {
        assert.equal(serializePaperKopecks(9_007_199_254_740_993n), '9007199254740993');
    });

    it('uses bounded integer limits', () => {
        assert.equal(parsePaperLabLimit(null), 50);
        assert.equal(parsePaperLabLimit('999'), 200);
        assert.throws(() => parsePaperLabLimit('1.5'), /positive integer/);
    });

    it('binds opaque cursors to their account', () => {
        const encoded = encodePaperLabCursor({ virtualAccountId: 'paper-a', offset: 50 });
        assert.deepEqual(decodePaperLabCursor(encoded, 'paper-a'), { virtualAccountId: 'paper-a', offset: 50 });
        assert.throws(() => decodePaperLabCursor(encoded, 'paper-b'), /account mismatch/);
    });

    it('single-flights identical reads and keeps account-list queries bounded', async () => {
        let calls = 0;
        let release: (() => void) | undefined;
        const gate = new Promise<void>(resolve => { release = resolve; });
        const service = new PaperLabReadModelService(emptyStore(async limit => {
            calls += 1;
            assert.equal(limit, 50);
            await gate;
            return [];
        }), () => new Date('2026-08-30T10:00:00Z'));
        const first = service.load(undefined, 200);
        const second = service.load(undefined, 200);
        release?.();
        assert.strictEqual(await first, await second);
        assert.equal(calls, 1);
    });

    it('expires cache deterministically after TTL', async () => {
        let now = Date.parse('2026-08-30T10:00:00Z');
        let calls = 0;
        const service = new PaperLabReadModelService(emptyStore(async () => { calls += 1; return []; }), () => new Date(now), 100);
        await service.load(undefined, 50);
        now += 99;
        await service.load(undefined, 50);
        assert.equal(calls, 1);
        now += 1;
        await service.load(undefined, 50);
        assert.equal(calls, 2);
    });
});
