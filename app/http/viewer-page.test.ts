import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderViewerPage } from './viewer-page';

test('viewer renders only allowed process fields as readable labels, never arbitrary data', () => {
    const page = renderViewerPage({ isTickRunning: false, circuitBreakerOpen: true, consecutiveTickErrors: 3,
        startedAt: '2026-09-19T12:00:00Z', accountId: 'sensitive-account', error: '<script>bad()</script>' }, 'safe-csrf', 'safe-nonce', 0);
    for (const text of ['Обзор состояния', 'Ожидание', 'Блокировка активна', 'Ошибки подряд', 'Последняя активность', 'Обновлено:', 'UTC']) assert.ok(page.includes(text));
    assert.ok(!page.includes('sensitive-account') && !page.includes('bad()') && !page.includes('<pre>'));
    assert.ok(!page.includes('/api/status') && !page.includes('/api/accounts') && !page.includes('/api/positions'));
    assert.ok(page.includes('/api/viewer/status') && page.includes('/auth/logout'));
});

test('viewer tolerates absent/invalid fields and escapes HTML attributes', () => {
    const page = renderViewerPage({ startedAt: '<img src=x onerror=bad()>', consecutiveTickErrors: -1 }, '"><img>', 'nonce', 0);
    assert.ok(page.includes('Пока нет данных') && page.includes('Нет данных'));
    assert.ok(!page.includes('<img') && page.includes('&quot;&gt;&lt;img&gt;'));
    assert.doesNotThrow(() => renderViewerPage(null, '', 'nonce', 0));
});
