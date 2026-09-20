import { createHash, randomBytes } from 'node:crypto';
import { IncomingMessage, ServerResponse } from 'node:http';
import { renderViewerPage } from './viewer-page';
import { operatorRestrictions, operatorRouteAllowed } from './operator-access';

const CLIENT = 'tinvest.robot';
const SESSION = '__Host-tinvest-session';
const TRANSACTION = '__Host-tinvest-login';
const opaque = () => randomBytes(32).toString('base64url');
const isOpaque = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
const cookie = (name: string, value: string, seconds: number) => `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${seconds}`;

export interface AuthCoreConfig {
    issuer: string;
    origin: string;
    secret: string;
    viewerSubjects: readonly string[];
    operatorSubjects?: readonly string[];
}

// A local grant permits only process-level diagnostics. It grants no account ownership.
export const authCoreConfig = (env: NodeJS.ProcessEnv): AuthCoreConfig | undefined => {
    const keys = ['ROBOT_AUTH_ORIGIN', 'ROBOT_AUTH_CONSUMER_ORIGIN', 'ROBOT_AUTH_SECRET', 'ROBOT_AUTH_VIEWER_SUBJECTS', 'ROBOT_AUTH_OPERATOR_SUBJECTS'];
    if (!keys.some(key => env[key] !== undefined)) return undefined;
    const issuer = env.ROBOT_AUTH_ORIGIN ?? '';
    const origin = env.ROBOT_AUTH_CONSUMER_ORIGIN ?? '';
    for (const value of [issuer, origin]) {
        let url: URL;
        try { url = new URL(value); } catch { throw new Error('Invalid Auth Core configuration'); }
        if (url.protocol !== 'https:' || url.origin !== value || url.username || url.password) throw new Error('Invalid Auth Core configuration');
    }
    const secret = env.ROBOT_AUTH_SECRET ?? '';
    if (secret.length < 32 || /[\s\r\n]/.test(secret)) throw new Error('Invalid Auth Core configuration');
    const viewerSubjects = (env.ROBOT_AUTH_VIEWER_SUBJECTS ?? '').split(',').map(value => value.trim()).filter(Boolean);
    if (viewerSubjects.some(value => !/^[A-Za-z0-9_-]{1,128}$/.test(value))) throw new Error('Invalid Auth Core configuration');
    const operatorSubjects = (env.ROBOT_AUTH_OPERATOR_SUBJECTS ?? '').split(',').map(value => value.trim()).filter(Boolean);
    if (operatorSubjects.some(value => !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value))) throw new Error('Invalid Auth Core configuration');
    return { issuer, origin, secret, viewerSubjects, operatorSubjects };
};

type Session = { token: string; expires: number; csrf: string; subject: string };
type Transaction = { state: string; verifier: string; expires: number };
type Dependencies = { fetch?: typeof fetch; now?: () => number; timeoutMs?: number };

export class AuthCoreAdapter {
    private readonly operatorRequests = new WeakSet<IncomingMessage>();
    isOperatorRequest(req: IncomingMessage): boolean { return this.operatorRequests.has(req); }
    private isOperator(subject: string): boolean { return this.config.operatorSubjects?.includes(subject) === true; }
    private readonly sessions = new Map<string, Session>();
    private readonly transactions = new Map<string, Transaction>();
    private readonly fetch: typeof fetch;
    private readonly now: () => number;
    private readonly timeoutMs: number;
    private readonly callback: string;

    constructor(private readonly config: AuthCoreConfig, dependencies: Dependencies = {}) {
        this.fetch = dependencies.fetch ?? fetch;
        this.now = dependencies.now ?? Date.now;
        this.timeoutMs = dependencies.timeoutMs ?? 3000;
        this.callback = `${config.origin}/auth/callback`;
    }

    private async post(path: string, body: Record<string, string>): Promise<Record<string, unknown>> {
        const response = await this.fetch(`${this.config.issuer}/api/sso/${path}`, {
            method: 'POST', redirect: 'error', signal: AbortSignal.timeout(this.timeoutMs),
            headers: { 'content-type': 'application/json', authorization: `Bearer ${this.config.secret}`, origin: this.config.issuer },
            body: JSON.stringify({ client_id: CLIENT, ...body })
        });
        if (!response.ok) throw new Error('Auth unavailable');
        const value: unknown = await response.json();
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Auth unavailable');
        return value as Record<string, unknown>;
    }

    private async inspect(token: string): Promise<{ subject: string; expires: number } | undefined> {
        const value = await this.post('introspect', { token });
        if (value.active === false) return undefined;
        const user = value.user as { id?: unknown } | undefined;
        const expires = typeof value.expiresAt === 'string' ? Date.parse(value.expiresAt) : NaN;
        if (value.active !== true || value.service !== CLIENT || !user || typeof user.id !== 'string'
            || !/^[A-Za-z0-9_-]{1,128}$/.test(user.id) || !Number.isFinite(expires)) throw new Error('Auth unavailable');
        if (expires <= this.now() || (!this.config.viewerSubjects.includes(user.id) && !this.isOperator(user.id))) return undefined;
        return { subject: user.id, expires };
    }

    /** false delegates only explicit Basic or a request marked by successful operator authorization. */
    async handle(req: IncomingMessage, res: ServerResponse, readStatus: () => unknown): Promise<boolean> {
        this.operatorRequests.delete(req);
        let url: URL;
        try { url = new URL(req.url ?? '/', this.config.origin); } catch {
            // URL errors can embed the original callback query in their message.
            res.writeHead(400, { 'cache-control': 'no-store', 'content-type': 'application/json' });
            res.end('{"error":"Invalid request URL"}');
            return true;
        }
        const cookies = (req.headers.cookie ?? '').split(';').map(value => value.trim().split('='));
        const values = (name: string) => cookies.filter(pair => pair[0] === name).map(pair => pair[1]);
        const sessionValues = values(SESSION);
        const sessionId = sessionValues.length === 1 ? sessionValues[0] : '';
        const authRoute = url.pathname.startsWith('/auth/');
        const viewerRoute = url.pathname === '/viewer' || url.pathname === '/api/viewer/status';
        if ((!authRoute || (url.pathname === '/auth/session' && req.method === 'GET')) && !viewerRoute && sessionValues.length === 0 && /^Basic /i.test(req.headers.authorization ?? '')) return false;

        res.setHeader('cache-control', 'no-store');
        res.setHeader('referrer-policy', 'no-referrer');
        res.setHeader('x-content-type-options', 'nosniff');
        res.setHeader('content-security-policy', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
        const reply = (status: number, data: unknown) => {
            res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify(data));
            return true;
        };
        const redirect = (location: string) => { res.writeHead(303, { location }); res.end(); return true; };
        const html = (body: string) => {
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
            res.end(`<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>T-Invest — просмотр</title><body>${body}</body></html>`);
            return true;
        };
        for (const [key, value] of this.transactions) if (value.expires <= this.now()) this.transactions.delete(key);
        for (const [key, value] of this.sessions) if (value.expires <= this.now()) this.sessions.delete(key);

        try {
            if (url.pathname === '/auth/login' && req.method === 'GET') {
                if (this.transactions.size >= 1000) return reply(503, { error: 'Login capacity exceeded' });
                const binding = opaque();
                const transaction = { state: opaque(), verifier: opaque(), expires: this.now() + 600_000 };
                this.transactions.set(binding, transaction);
                res.setHeader('set-cookie', cookie(TRANSACTION, binding, 600));
                const target = new URL('/', this.config.issuer);
                target.search = new URLSearchParams({ sso_client: CLIENT, redirect_uri: this.callback, state: transaction.state,
                    code_challenge: createHash('sha256').update(transaction.verifier).digest('base64url') }).toString();
                return redirect(target.href);
            }
            if (url.pathname === '/auth/callback' && req.method === 'GET') {
                const bindings = values(TRANSACTION);
                const binding = bindings.length === 1 ? bindings[0] : '';
                const transaction = this.transactions.get(binding);
                this.transactions.delete(binding); // consume before the first await, including failed exchanges
                res.setHeader('set-cookie', cookie(TRANSACTION, '', 0));
                const code = url.searchParams.get('code');
                if (!transaction || transaction.state !== url.searchParams.get('state') || !isOpaque(code)
                    || url.searchParams.getAll('state').length !== 1 || url.searchParams.getAll('code').length !== 1) return reply(401, { error: 'Invalid login transaction' });
                if (this.sessions.size >= 1000) return reply(503, { error: 'Session capacity exceeded' });
                const exchanged = await this.post('exchange', { code, redirect_uri: this.callback, code_verifier: transaction.verifier });
                const expires = typeof exchanged.expiresAt === 'string' ? Date.parse(exchanged.expiresAt) : NaN;
                if (!isOpaque(exchanged.token) || !Number.isFinite(expires) || expires <= this.now()) throw new Error('Auth unavailable');
                const actor = await this.inspect(exchanged.token);
                if (!actor) {
                    await this.post('revoke', { token: exchanged.token });
                    return reply(403, { error: 'Viewer access denied' });
                }
                const id = opaque();
                const expiry = Math.min(expires, actor.expires, this.now() + 8 * 60 * 60_000);
                this.sessions.delete(sessionId);
                this.sessions.set(id, { token: exchanged.token, expires: expiry, csrf: opaque(), subject: actor.subject });
                res.setHeader('set-cookie', [cookie(TRANSACTION, '', 0), cookie(SESSION, id, Math.floor((expiry - this.now()) / 1000))]);
                return redirect(this.isOperator(actor.subject) ? '/' : '/viewer');
            }
            const session = this.sessions.get(sessionId);
            if (!session) {
                if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/viewer') && sessionValues.length === 0) {
                    return redirect('/auth/login');
                }
                return reply(401, { error: 'Authentication required', login: '/auth/login' });
            }
            // Logout remains possible during an Auth outage. It grants no trading operation.
            if (url.pathname === '/auth/logout' && req.method === 'POST') {
                if (req.headers.origin !== this.config.origin) return reply(403, { error: 'CSRF rejected' });
                let csrf = req.headers['x-csrf-token'];
                if (!csrf && req.headers['content-type'] === 'application/x-www-form-urlencoded') {
                    let body = '';
                    for await (const chunk of req) {
                        body += chunk.toString();
                        if (body.length > 256) return reply(413, { error: 'Request too large' });
                    }
                    const form = new URLSearchParams(body);
                    if (form.getAll('csrf').length === 1) csrf = form.get('csrf') ?? undefined;
                }
                if (csrf !== session.csrf) return reply(403, { error: 'CSRF rejected' });
                this.sessions.delete(sessionId);
                res.setHeader('set-cookie', cookie(SESSION, '', 0));
                const revoked = await this.post('revoke', { token: session.token });
                if (revoked.ok !== true) throw new Error('Auth unavailable');
                return reply(200, { ok: true, remoteRevoked: true });
            }
            const actor = await this.inspect(session.token);
            if (!actor || actor.subject !== session.subject) {
                this.sessions.delete(sessionId);
                res.setHeader('set-cookie', cookie(SESSION, '', 0));
                return reply(403, { error: 'Viewer access denied' });
            }
            if (url.pathname === '/auth/session' && req.method === 'GET' && !url.search) {
                return reply(200, { access: this.isOperator(actor.subject) ? 'operator' : 'viewer', csrfToken: session.csrf,
                    restrictions: this.isOperator(actor.subject) ? operatorRestrictions : [] });
            }
            if (this.isOperator(actor.subject)) {
                if (url.pathname === '/viewer' && req.method === 'GET') return redirect('/');
                if (!operatorRouteAllowed(req.method ?? '', url.pathname)) return reply(403, { error: 'Operation blocked by access or operational restrictions' });
                // Even GET API handlers can trigger scans/cache writes. Require the session token for all API calls.
                if (url.pathname.startsWith('/api/') || req.method !== 'GET') {
                    if (req.headers['x-csrf-token'] !== session.csrf
                        || (req.headers.origin !== undefined && req.headers.origin !== this.config.origin)
                        || (req.method !== 'GET' && req.headers.origin !== this.config.origin)) return reply(403, { error: 'CSRF rejected' });
                }
                res.setHeader('content-security-policy', "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
                this.operatorRequests.add(req);
                return false;
            }
            if (req.method === 'GET' && url.pathname === '/' && !url.search) return redirect('/viewer');
            if (req.method !== 'GET' || !viewerRoute || url.search) return reply(403, { error: 'Operation not permitted for SSO viewer' });
            if (url.pathname === '/api/viewer/status') return reply(200, { status: readStatus() });
            const nonce = opaque();
            res.setHeader('content-security-policy', `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`);
            return html(renderViewerPage(readStatus(), session.csrf, nonce, this.now()));
        } catch {
            // Never log upstream errors, callback queries or credentials; no legacy fallback.
            return reply(503, { error: 'Auth Core unavailable', ...(url.pathname === '/auth/logout' ? { remoteRevoked: false } : {}) });
        }
    }
}
