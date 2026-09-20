import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

// In-process HTTP with fake Auth/database; no broker, scans or production environment.
test('SSO operator reaches existing HTTP application, CSRF gate precedes handlers and revocation stops access', async () => {
    Object.assign(process.env, { DB_DIALECT: 'postgres', DB_NAME: 'test', DB_USER: 'test', DB_HOST: '127.0.0.1', DB_PORT: '1',
        ROBOT_ACCOUNT_IDS: 'test-account', ROBOT_HTTP_ENABLED: 'true', ROBOT_HTTP_PORT: '0', ROBOT_WEB_PASSWORD: 'test-basic', ROBOT_TRADING_PAUSED: 'true',
        ROBOT_AUTH_ORIGIN: 'https://auth.example', ROBOT_AUTH_CONSUMER_ORIGIN: 'https://robot.example', ROBOT_AUTH_SECRET: 's'.repeat(32),
        ROBOT_AUTH_VIEWER_SUBJECTS: '', ROBOT_AUTH_OPERATOR_SUBJECTS: '11111111-1111-4111-8111-111111111111' });
    const runtime = (await import('../services/runtime-config.service')).default;
    const { startReadOnlyHttpServer } = await import('./readonly-server');
    mock.method(runtime, 'getEffectiveConfig', async (base: unknown) => base);
    mock.method(runtime, 'getAccountModes', async () => []);
    let writes = 0;
    mock.method(runtime, 'setMarketRegimeSettings', async (settings: unknown) => { writes++; return settings; });
    let active = true;
    mock.method(globalThis, 'fetch', async (input: string) => Response.json(input.endsWith('/exchange')
        ? { token: 't'.repeat(43), expiresAt: new Date(Date.now() + 60_000).toISOString() }
        : { active, service: 'tinvest.robot', user: { id: process.env.ROBOT_AUTH_OPERATOR_SUBJECTS }, expiresAt: new Date(Date.now() + 60_000).toISOString() }));
    const server = startReadOnlyHttpServer()!;
    await new Promise<void>(resolve => server.once('listening', resolve));
    const port = (server.address() as { port: number }).port;
    function request(path: string, headers: Record<string, string> = {}, method = 'GET', body = '') {
        return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
            const req = http.request({ hostname: '127.0.0.1', port, path, headers, method }, res => {
                let data = ''; res.on('data', chunk => { data += chunk; }); res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: data }));
            }); req.on('error', reject); req.end(body);
        });
    }
    try {
        assert.equal((await request('/api/status')).status, 401);
        const login = await request('/auth/login');
        const state = new URL(login.headers.location!).searchParams.get('state');
        const callback = await request('/auth/callback?code=' + 'c'.repeat(43) + '&state=' + state, { cookie: login.headers['set-cookie']![0].split(';')[0] });
        assert.equal(callback.status, 303); assert.equal(callback.headers.location, '/');
        const cookie = callback.headers['set-cookie']![1].split(';')[0];
        const session = JSON.parse((await request('/auth/session', { cookie })).body);
        const root = await request('/', { cookie });
        assert.equal(root.status, 200); assert.ok(root.body.includes('id="root"')); assert.equal(root.headers['www-authenticate'], undefined);
        assert.ok(root.headers['content-security-policy']?.includes("script-src 'self'"));
        assert.equal((await request('/api/status', { cookie })).status, 403);
        const headers = { cookie, 'x-csrf-token': session.csrfToken, origin: 'https://robot.example', 'content-type': 'application/json', 'x-robot-admin-action': 'market-regime' };
        assert.equal((await request('/api/status', headers)).status, 200);
        assert.equal((await request('/api/admin/market-regime', { cookie }, 'POST', '{}')).status, 403); assert.equal(writes, 0);
        assert.equal((await request('/api/admin/market-regime', headers, 'POST', '{"minHealthPercent":50,"minAvgTrendPercent":0}')).status, 200); assert.equal(writes, 1);
        assert.equal((await request('/api/admin/live-actions', headers, 'POST', '{}')).status, 403);
        active = false;
        assert.equal((await request('/api/status', { ...headers, authorization: 'Basic ' + Buffer.from('robot:test-basic').toString('base64') })).status, 403);
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); mock.restoreAll(); }
});
