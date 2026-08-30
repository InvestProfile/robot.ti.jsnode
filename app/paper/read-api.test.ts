import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { encodePaperLabCursor } from '../services/paper-lab-read-model.service';
import { handlePaperReadApi, PaperLabReadPort } from './read-api';

const payload = {
    generatedAt: '2026-08-30T10:00:00Z', cache: { ttlMs: 15_000, state: 'fresh' as const },
    bounds: { requestedLimit: 50, maxLimit: 200, offset: 0 }, accounts: [], positions: [],
    orders: [], fills: [], decisions: [], evidence: {
        equityCurve: 'unavailable' as const, benchmark: 'unavailable' as const, reason: 'not implemented'
    }
};
const request = (path: string, method = 'GET') => ({ method, url: new URL(path, 'http://localhost') });

describe('Paper Lab read API boundary', () => {
    it('is GET-only and advertises Allow', async () => {
        const result = await handlePaperReadApi(request('/api/paper-lab', 'POST'), { async load() { return payload; } });
        assert.equal(result.statusCode, 405);
        assert.equal(result.allow, 'GET');
    });

    it('rejects malformed limits and caps a valid integer limit', async () => {
        const service: PaperLabReadPort = { async load(_id, limit) { assert.equal(limit, 200); return payload; } };
        assert.equal((await handlePaperReadApi(request('/api/paper-lab?limit=1.5'), service)).statusCode, 400);
        assert.equal((await handlePaperReadApi(request('/api/paper-lab?limit=-1'), service)).statusCode, 400);
        assert.equal((await handlePaperReadApi(request('/api/paper-lab?limit=999'), service)).statusCode, 200);
    });

    it('binds a cursor to exactly one virtual account', async () => {
        const cursor = encodePaperLabCursor({ virtualAccountId: 'paper-a', offset: 50 });
        const service: PaperLabReadPort = { async load() { return payload; } };
        const result = await handlePaperReadApi(request(`/api/paper-lab?virtualAccountId=paper-b&cursor=${cursor}`), service);
        assert.equal(result.statusCode, 400);
        assert.match(String((result.payload as { error: string }).error), /account mismatch/);
    });

    it('maps a missing experiment to 404 without leaking another account', async () => {
        const service: PaperLabReadPort = { async load(id) { throw new Error(`virtual account not found: ${id}`); } };
        const result = await handlePaperReadApi(request('/api/paper-lab?virtualAccountId=missing'), service);
        assert.equal(result.statusCode, 404);
    });

    it('passes only the requested account to the read port', async () => {
        const seen: Array<string | undefined> = [];
        const service: PaperLabReadPort = { async load(id) { seen.push(id); return payload; } };
        assert.equal((await handlePaperReadApi(request('/api/paper-lab?virtualAccountId=paper-a'), service)).statusCode, 200);
        assert.deepEqual(seen, ['paper-a']);
    });
});
