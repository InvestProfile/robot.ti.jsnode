import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { AuthCoreAdapter, authCoreConfig, AuthCoreConfig } from './auth-core';

const config: AuthCoreConfig = { issuer: 'https://auth.example', origin: 'https://robot.example', secret: 's'.repeat(32), viewerSubjects: ['subject-1'] };
const token = 't'.repeat(43);
const code = 'c'.repeat(43);

function fixture(overrides: Partial<AuthCoreConfig> = {}) {
    let now = Date.parse('2026-09-18T12:00:00Z');
    let grant: { state: string; challenge: string; callback: string; expires: number; used: boolean };
    let active = true;
    let subject = 'subject-1';
    let service = 'tinvest.robot';
    let failure = '';
    let reads = 0;
    const calls: { path: string; body: Record<string, string> }[] = [];
    const backchannel: typeof fetch = async (input, init) => {
        const path = new URL(String(input)).pathname.split('/').pop()!;
        const body = JSON.parse(String(init?.body));
        if (failure === 'wrong-client') body.client_id = 'crypto.robot';
        calls.push({ path, body });
        assert.equal(init?.redirect, 'error');
        assert.equal((init?.headers as Record<string, string>).origin, config.issuer);
        assert.ok(init?.signal);
        if (failure === 'timeout') {
            return await new Promise((_resolve, reject) => {
                const timer = setTimeout(() => reject(new Error('mock deadline exceeded')), 100);
                init!.signal!.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('mock timeout')); }, { once: true });
            });
        }
        if (failure === 'malformed') return new Response('not json');
        if (failure === 'redirect') return new Response('', { status: 302 });
        if ((init?.headers as Record<string, string>).authorization !== `Bearer ${config.secret}` || body.client_id !== 'tinvest.robot') return Response.json({}, { status: 401 });
        if (path === 'exchange') {
            if (!grant || grant.used || grant.expires <= now || body.code !== code || body.redirect_uri !== grant.callback
                || createHash('sha256').update(body.code_verifier).digest('base64url') !== grant.challenge) return Response.json({}, { status: 400 });
            grant.used = true;
            return Response.json({ token, expiresAt: new Date(now + 3600_000).toISOString() });
        }
        assert.equal(body.token, token);
        if (path === 'revoke') { active = false; return Response.json({ ok: true }); }
        return Response.json(active ? { active, service, user: { id: subject }, expiresAt: failure === 'expiry' ? 'invalid' : new Date(now + 3600_000).toISOString() } : { active: false });
    };
    const adapter = new AuthCoreAdapter({ ...config, ...overrides }, { fetch: backchannel, now: () => now, timeoutMs: 5 });
    async function request(path: string, headers: Record<string, string> = {}, method = 'GET', body = '') {
        const req = Readable.from(body ? [body] : []) as IncomingMessage;
        req.url = path; req.method = method; req.headers = headers;
        let status = 0;
        let data = '';
        const responseHeaders: Record<string, string | string[]> = {};
        const res = {
            setHeader(name: string, value: string | string[]) { responseHeaders[name] = value; },
            writeHead(value: number, more: Record<string, string> = {}) { status = value; Object.assign(responseHeaders, more); },
            end(value = '') { data = value; }
        } as unknown as ServerResponse;
        const handled = await adapter.handle(req, res, () => { reads++; return { circuitBreakerOpen: true }; });
        return { status, data, headers: responseHeaders, handled, operator: adapter.isOperatorRequest(req) };
    }
    async function begin() {
        const response = await request('/auth/login');
        const target = new URL(response.headers.location as string);
        assert.equal(target.origin, config.issuer);
        assert.equal(target.searchParams.get('sso_client'), 'tinvest.robot');
        grant = { state: target.searchParams.get('state')!, challenge: target.searchParams.get('code_challenge')!, callback: `${config.origin}/auth/callback`, expires: now + 60_000, used: false };
        const cookie = String(response.headers['set-cookie']).split(';')[0];
        return { response, cookie, callback: `/auth/callback?code=${code}&state=${grant.state}` };
    }
    async function login() {
        const start = await begin();
        const response = await request(start.callback, { cookie: start.cookie });
        assert.equal(response.status, 303);
        const cookie = (response.headers['set-cookie'] as string[])[1].split(';')[0];
        return { cookie, response, start };
    }
    return { request, begin, login, calls, reads: () => reads, advance: (ms: number) => { now += ms; },
        active: (value: boolean) => { active = value; }, subject: (value: string) => { subject = value; },
        service: (value: string) => { service = value; }, failure: (value: string) => { failure = value; },
        tamperPkce: () => { grant.challenge = 'wrong'; } };
}

test('configuration is opt-in, partial/insecure config fails closed, empty grant list is allowed', () => {
    assert.equal(authCoreConfig({}), undefined);
    assert.throws(() => authCoreConfig({ ROBOT_AUTH_SECRET: 'x' }));
    const env = { ROBOT_AUTH_ORIGIN: config.issuer, ROBOT_AUTH_CONSUMER_ORIGIN: config.origin, ROBOT_AUTH_SECRET: config.secret };
    assert.deepEqual(authCoreConfig(env)?.viewerSubjects, []);
    for (const origin of ['http://auth.example', 'https://auth.example/path', 'https://user:pw@auth.example', 'https://auth.example?x=1']) {
        assert.throws(() => authCoreConfig({ ...env, ROBOT_AUTH_ORIGIN: origin }));
    }
});

test('successful PKCE login uses isolated secure cookies; every read introspects; token never reaches browser', async () => {
    const f = fixture();
    const { cookie, response, start } = await f.login();
    for (const value of [...response.headers['set-cookie'] as string[], String(start.response.headers['set-cookie'])]) {
        assert.match(value, /HttpOnly; Secure; SameSite=Lax/); assert.match(value, /Path=\//); assert.doesNotMatch(value, /Domain=/);
    }
    assert.ok(!JSON.stringify(response).includes(token));
    for (const path of ['/viewer', '/api/viewer/status']) assert.equal((await f.request(path, { cookie })).status, 200);
    assert.equal(f.calls.filter(call => call.path === 'introspect').length, 3);
    assert.equal(f.reads(), 2);
    assert.equal((await f.request('/')).headers.location, '/auth/login');
});

test('direct requests and forged actor/role denied, Basic is only an explicit separate path', async () => {
    const f = fixture();
    assert.equal((await f.request('/api/status', { owner_id: 'subject-1', role: 'admin' })).status, 401);
    assert.equal((await f.request('/api/status', { authorization: 'Basic synthetic' })).handled, false);
    assert.equal((await f.request('/api/status', { authorization: 'Basic synthetic', cookie: '__Host-tinvest-session=invalid' })).status, 401);
    assert.equal((await f.request('/viewer', { authorization: 'Basic synthetic' })).headers.location, '/auth/login');
    assert.equal(f.reads(), 0);
});

for (const scenario of ['missing-cookie', 'wrong-state', 'duplicate-state', 'expired-transaction', 'expired-code', 'wrong-code', 'wrong-pkce', 'wrong-secret', 'wrong-callback', 'wrong-client']) {
    test(`login rejection: ${scenario}`, async () => {
        const f = fixture(scenario === 'wrong-secret' ? { secret: 'z'.repeat(32) } : scenario === 'wrong-callback' ? { origin: 'https://other.example' } : {});
        const start = await f.begin();
        let callback = start.callback;
        if (scenario === 'wrong-state') callback = callback.replace(/state=.*/, 'state=wrong');
        if (scenario === 'duplicate-state') callback += '&state=duplicate';
        if (scenario === 'wrong-code') callback = callback.replace(code, 'x'.repeat(43));
        if (scenario === 'expired-transaction') f.advance(600_001);
        if (scenario === 'expired-code') f.advance(60_001);
        if (scenario === 'wrong-pkce') f.tamperPkce();
        if (scenario === 'wrong-client') f.failure('wrong-client');
        const result = await f.request(callback, { cookie: scenario === 'missing-cookie' ? '' : start.cookie });
        assert.ok(result.status >= 400);
        assert.equal(f.reads(), 0);
        assert.ok(!JSON.stringify(result).includes(token));
    });
}

test('callback replay and browser binding are rejected before exchange', async () => {
    const f = fixture();
    const { start } = await f.login();
    assert.equal((await f.request(start.callback, { cookie: start.cookie })).status, 401);
    const another = await f.begin();
    assert.equal((await f.request(another.callback, { cookie: start.cookie })).status, 401);
    assert.equal(f.calls.filter(call => call.path === 'exchange').length, 1);
});

for (const reason of ['membership', 'parent-session', 'subject-changed', 'cross-client', 'timeout', 'malformed', 'redirect', 'expiry']) {
    test(`each protected request fails closed on ${reason}, even with Basic present`, async () => {
        const f = fixture();
        const { cookie } = await f.login();
        if (reason === 'membership' || reason === 'parent-session') f.active(false);
        else if (reason === 'subject-changed') f.subject('subject-2');
        else if (reason === 'cross-client') f.service('crypto.robot');
        else f.failure(reason);
        assert.ok((await f.request('/api/viewer/status', { cookie, authorization: 'Basic synthetic' })).status >= 400);
        assert.equal(f.reads(), 0);
    });
}

test('membership without local operation grant is insufficient; session expires locally', async () => {
    const f = fixture({ viewerSubjects: [] });
    const start = await f.begin();
    assert.equal((await f.request(start.callback, { cookie: start.cookie })).status, 403);
    assert.equal(f.calls.at(-1)?.path, 'revoke');
    const other = fixture();
    const { cookie } = await other.login();
    other.advance(3600_001);
    assert.equal((await other.request('/viewer', { cookie })).status, 401);
});

test('viewer cannot enter existing GET handlers, mutations or arbitrary static files', async () => {
    const f = fixture();
    const { cookie } = await f.login();
    for (const method of ['GET', 'POST', 'PUT', 'DELETE', 'HEAD', 'OPTIONS']) {
        for (const path of ['/api/admin/account-mode', '/api/admin/live-actions', '/api/admin/risk-settings', '/api/admin/sell-settings', '/api/admin/cancel-stale-limit-orders', '/api/admin/protective-stops-resync', '/api/social-cookies', '/api/preview', '/api/buy-scan', '/api/status', '/api/health', '/assets/file.js', '/api/viewer/status?accountId=other']) {
            assert.equal((await f.request(path, { cookie, origin: config.origin, authorization: 'Basic synthetic', role: 'admin' }, method)).status, 403);
        }
    }
    assert.equal((await f.request('/api/viewer/status', { cookie }, 'POST')).status, 403);
    assert.equal(f.reads(), 0);
});

test('logout requires exact Origin + CSRF; revokes remote and clears local session', async () => {
    const f = fixture();
    const { cookie } = await f.login();
    const page = await f.request('/viewer', { cookie });
    const csrf = /name="csrf" value="([^"]+)"/.exec(page.data)![1];
    assert.equal((await f.request('/auth/logout', { cookie }, 'POST')).status, 403);
    assert.equal((await f.request('/auth/logout', { cookie, origin: 'https://evil.example', 'x-csrf-token': csrf }, 'POST')).status, 403);
    assert.equal((await f.request('/auth/logout', { cookie, origin: config.origin, 'x-csrf-token': 'wrong' }, 'POST')).status, 403);
    const result = await f.request('/auth/logout', { cookie, origin: config.origin, 'content-type': 'application/x-www-form-urlencoded' }, 'POST', `csrf=${csrf}`);
    assert.equal(result.status, 200);
    assert.match(String(result.headers['set-cookie']), /Max-Age=0/);
    assert.equal((await f.request('/viewer', { cookie })).status, 401);
    assert.equal(f.calls.at(-1)?.path, 'revoke');
    assert.equal(f.calls.at(-1)?.body.client_id, 'tinvest.robot');
});

test('logout outage clears local session and reports remote revocation unconfirmed', async () => {
    const f = fixture();
    const { cookie } = await f.login();
    const csrf = /name="csrf" value="([^"]+)"/.exec((await f.request('/viewer', { cookie })).data)![1];
    f.failure('timeout');
    const result = await f.request('/auth/logout', { cookie, origin: config.origin, 'x-csrf-token': csrf }, 'POST');
    assert.equal(result.status, 503);
    assert.equal(JSON.parse(result.data).remoteRevoked, false);
    assert.match(String(result.headers['set-cookie']), /Max-Age=0/);
    assert.equal((await f.request('/viewer', { cookie })).status, 401);
});

test('malformed callback URL never escapes to application error logging; duplicate session cookies deny', async () => {
    const f = fixture();
    const bad = await f.request('http://[?code=synthetic-sensitive-code');
    assert.equal(bad.status, 400);
    assert.ok(!bad.data.includes('synthetic-sensitive-code'));
    const { cookie } = await f.login();
    assert.equal((await f.request('/viewer', { cookie: `${cookie}; ${cookie}` })).status, 401);
});


test('browser landing redirects through existing login; APIs and invalid cookies never redirect', async () => {
    const f = fixture();
    for (const path of ['/', '/viewer', '/?next=https://evil.example']) {
        const r = await f.request(path);
        assert.equal(r.status, 303);
        assert.equal(r.headers.location, '/auth/login');
        assert.equal(r.headers['www-authenticate'], undefined);
        assert.equal(r.headers['cache-control'], 'no-store');
    }
    for (const path of ['/api/health', '/api/status', '/api/viewer/status', '/auth/callback']) {
        const r = await f.request(path);
        assert.equal(r.status, 401);
        assert.equal(r.headers.location, undefined);
    }
    for (const path of ['/', '/viewer']) {
        const r = await f.request(path, { cookie: '__Host-tinvest-session=invalid', authorization: 'Basic synthetic' });
        assert.equal(r.status, 401);
        assert.equal(r.headers.location, undefined);
        assert.equal((await f.request(path, {}, 'POST')).status, 401);
    }
    assert.equal((await f.request('/', { authorization: 'Basic synthetic' })).handled, false);
    assert.equal(f.reads(), 0);
    const { cookie } = await f.login();
    const r = await f.request('/', { cookie });
    assert.equal(r.status, 303);
    assert.equal(r.headers.location, '/viewer');
    assert.equal((await f.request('/viewer', { cookie })).status, 200);
});

for (const reason of ['revoked', 'local-grant', 'outage']) {
    test(`landing preserves ${reason} without redirect loops`, async () => {
        for (const path of ['/', '/viewer']) {
            const f = fixture();
            const { cookie } = await f.login();
            if (reason === 'revoked') f.active(false);
            else if (reason === 'local-grant') f.subject('subject-2');
            else f.failure('timeout');
            const r = await f.request(path, { cookie });
            assert.equal(r.status, reason === 'outage' ? 503 : 403);
            assert.equal(r.headers.location, undefined);
            assert.equal(f.reads(), 0);
        }
    });
}

test('viewer page is protected, responsive, and uses per-response CSP nonces without operator assets', async () => {
    const f = fixture();
    const { cookie } = await f.login();
    const a = await f.request('/viewer', { cookie });
    const b = await f.request('/viewer', { cookie });
    assert.equal(a.status, 200);
    assert.match(a.data, /Обзор состояния/);
    assert.match(a.data, /name="viewport"/);
    assert.ok(!a.data.includes('<pre>') && !a.data.includes('/assets/'));
    const nonce = /<script nonce="([^"]+)"/.exec(a.data)![1];
    assert.ok(String(a.headers['content-security-policy']).includes(`script-src 'nonce-${nonce}'`));
    assert.ok(String(a.headers['content-security-policy']).includes(`style-src 'nonce-${nonce}'`));
    assert.ok(!String(a.headers['content-security-policy']).includes('unsafe-inline'));
    assert.notEqual(a.headers['content-security-policy'], b.headers['content-security-policy']);
});


const operatorSubject = '11111111-1111-4111-8111-111111111111';
function operatorFixture() {
    const f = fixture({ viewerSubjects: [], operatorSubjects: [operatorSubject] });
    f.subject(operatorSubject);
    return f;
}

test('operator config accepts only immutable UUID, never login or role', () => {
    const env = { ROBOT_AUTH_ORIGIN: config.issuer, ROBOT_AUTH_CONSUMER_ORIGIN: config.origin, ROBOT_AUTH_SECRET: config.secret };
    for (const value of ['admin', 'operator', '*', 'subject-1']) assert.throws(() => authCoreConfig({ ...env, ROBOT_AUTH_OPERATOR_SUBJECTS: value }));
    assert.deepEqual(authCoreConfig({ ...env, ROBOT_AUTH_OPERATOR_SUBJECTS: operatorSubject })?.operatorSubjects, [operatorSubject]);
    assert.throws(() => authCoreConfig({ ROBOT_AUTH_OPERATOR_SUBJECTS: operatorSubject }));
});

test('exact operator gets ordinary application and assets, session metadata contains no credentials', async () => {
    const f = operatorFixture();
    const { cookie, response } = await f.login();
    assert.equal(response.headers.location, '/');
    const session = await f.request('/auth/session', { cookie });
    const data = JSON.parse(session.data);
    assert.equal(data.access, 'operator');
    assert.equal(typeof data.csrfToken, 'string');
    assert.ok(!session.data.includes(config.secret) && !session.data.includes(operatorSubject) && !session.data.includes(token));
    for (const path of ['/', '/index.html', '/assets/index-abc.js', '/assets/index-abc.css']) {
        const r = await f.request(path, { cookie });
        assert.equal(r.handled, false); assert.equal(r.operator, true);
    }
    assert.equal((await f.request('/viewer', { cookie })).headers.location, '/');
    assert.equal((await f.request('/api/positions?accountId=existing', { cookie, 'x-csrf-token': data.csrfToken })).operator, true);
    assert.equal(f.reads(), 0);
});

test('operator API including compute GET requires session CSRF; mutation requires exact Origin', async () => {
    const f = operatorFixture(); const { cookie } = await f.login();
    const csrf = JSON.parse((await f.request('/auth/session', { cookie })).data).csrfToken;
    for (const [path, method] of [['/api/accounts', 'GET'], ['/api/buy-scan', 'GET'], ['/api/admin/risk-settings', 'POST'], ['/api/social-profiles/profile', 'PUT'], ['/api/social-profiles/profile', 'DELETE']]) {
        for (const headers of [{}, { 'x-csrf-token': 'wrong' }, { 'x-csrf-token': csrf, origin: 'https://evil.example' }] as Record<string, string>[]) {
            const r = await f.request(path, { cookie, ...headers }, method); assert.equal(r.status, 403); assert.equal(r.operator, false);
        }
        if (method !== 'GET') assert.equal((await f.request(path, { cookie, 'x-csrf-token': csrf }, method)).status, 403);
        const r = await f.request(path, { cookie, 'x-csrf-token': csrf, origin: config.origin }, method);
        assert.equal(r.handled, false); assert.equal(r.operator, true);
    }
});

test('operator cannot lift live restrictions, change credentials or reach unreviewed routes', async () => {
    const f = operatorFixture(); const { cookie } = await f.login();
    const csrf = JSON.parse((await f.request('/auth/session', { cookie })).data).csrfToken;
    for (const path of ['/api/admin/live-actions', '/api/admin/account-mode', '/api/admin/cancel-stale-limit-orders', '/api/admin/protective-stops-resync', '/api/social-cookies', '/api/admin/unpause', '/api/new-route', '/private.env', '/assets/../private.env']) {
        for (const method of ['GET', 'POST', 'PUT', 'DELETE']) {
            const r = await f.request(path, { cookie, origin: config.origin, 'x-csrf-token': csrf, authorization: 'Basic synthetic' }, method);
            assert.equal(r.status, 403); assert.equal(r.operator, false);
        }
    }
});

for (const reason of ['membership', 'subject', 'outage']) {
    test(`operator authority fails closed on ${reason} without Basic fallback`, async () => {
        const f = operatorFixture(); const { cookie } = await f.login();
        const csrf = JSON.parse((await f.request('/auth/session', { cookie })).data).csrfToken;
        if (reason === 'membership') f.active(false);
        else if (reason === 'subject') f.subject('22222222-2222-4222-8222-222222222222');
        else f.failure('timeout');
        const r = await f.request('/api/accounts', { cookie, 'x-csrf-token': csrf, authorization: 'Basic synthetic' });
        assert.equal(r.status, reason === 'outage' ? 503 : 403); assert.equal(r.operator, false); assert.equal(r.headers.location, undefined);
    });
}

test('viewer membership and role headers never grant application access', async () => {
    const f = fixture({ operatorSubjects: [operatorSubject] }); const { cookie } = await f.login();
    const r = await f.request('/api/accounts', { cookie, role: 'admin', owner_id: operatorSubject });
    assert.equal(r.status, 403); assert.equal(r.operator, false);
    assert.equal((await f.request('/auth/session', { authorization: 'Basic synthetic' })).handled, false);
    assert.equal((await f.request('/auth/session')).status, 401);
});
