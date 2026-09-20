// Explicit application surface: adding a route requires review, never grants a role globally.
const reads = new Set([
    '/api/health', '/api/status', '/api/config', '/api/decisions', '/api/trades', '/api/trade-pnl',
    '/api/pnl-reconciliation', '/api/exit-quality', '/api/exit-entry-quality', '/api/accounting-audit',
    '/api/order-safety', '/api/protective-stops', '/api/snapshots', '/api/performance', '/api/limits',
    '/api/preview', '/api/daily-buy-list', '/api/buy-scan', '/api/analyst-forecasts', '/api/tech-analysis',
    '/api/scan-universe', '/api/market-regime', '/api/market-lab', '/api/buy-backtest', '/api/buy-optimize',
    '/api/buy-signals', '/api/buy-lab', '/api/buy-recommendations', '/api/paper-positions', '/api/paper-lab',
    '/api/strategy-evidence', '/api/sell-brain', '/api/exit-policy-observations', '/api/robot-positions',
    '/api/social-signals', '/api/social-collector', '/api/social-consensus', '/api/social-evidence',
    '/api/accounts', '/api/positions', '/api/social-profiles'
]);
export const operatorRestrictions = [
    '/api/admin/account-mode', '/api/admin/live-actions', '/api/admin/cancel-stale-limit-orders',
    '/api/admin/protective-stops-resync', '/api/social-cookies'
];
const settings = new Set(['/api/admin/order-type', '/api/admin/market-regime', '/api/admin/risk-settings', '/api/admin/sell-settings']);
export function operatorRouteAllowed(method: string, pathname: string): boolean {
    if (operatorRestrictions.includes(pathname)) return false;
    if (method === 'GET') return reads.has(pathname) || pathname === '/' || pathname === '/index.html'
        || /^\/assets\/[A-Za-z0-9_.-]+\.(js|css|png|svg|webp)$/.test(pathname);
    if (method === 'POST' && (settings.has(pathname) || pathname === '/api/social-profiles')) return true;
    if (/^\/api\/social-profiles\/[A-Za-z0-9_-]+$/.test(pathname)) return method === 'PUT' || method === 'DELETE';
    return method === 'POST' && /^\/api\/social-profiles\/[A-Za-z0-9_-]+\/toggle$/.test(pathname);
}
