import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { formatPaperKopecks } = require(path.resolve('ui/src/paper-money.cjs')) as {
    formatPaperKopecks(value: string | bigint, options?: { signed?: boolean }): string;
};

describe('Paper Lab dashboard contract', () => {
    it('renders explicit loading, empty, stale, error and unavailable evidence states', () => {
        const source = readFileSync('ui/src/main.jsx', 'utf8');
        for (const phrase of ['Загрузка Paper Lab', 'Эксперименты не созданы', 'Данные устарели', 'Ошибка Paper Lab',
            'INSUFFICIENT-EVIDENCE', 'Observation experiment', 'Equity curve (bounded)', 'Gate reasons / cumulative alerts']) {
            assert(source.includes(phrase), `missing UI state: ${phrase}`);
        }
        assert(source.includes('/api/paper-lab?limit=50'));
        assert(source.includes('virtualAccountId=${encodeURIComponent(nextId)}'));
        assert(!source.includes('Paper Lab trade'));
    });

    it('keeps PaperLab at module scope and forbids lossy Number conversion', () => {
        const source = readFileSync('ui/src/main.jsx', 'utf8');
        const paperIndex = source.indexOf('function PaperLab() {');
        const appIndex = source.indexOf('function App() {');
        assert(paperIndex >= 0 && paperIndex < appIndex, 'PaperLab must be declared before App at module scope');
        assert(!source.includes('function App() {\nfunction PaperLab'));
        assert(!source.includes('Number(value) / 100'));
    });

    it('formats decimal kopecks beyond Number.MAX_SAFE_INTEGER without precision loss', () => {
        assert.equal(formatPaperKopecks('9007199254740993123'), '90\u00a0071\u00a0992\u00a0547\u00a0409\u00a0931,23 ₽');
        assert.equal(formatPaperKopecks('-9007199254740993123'), '−90\u00a0071\u00a0992\u00a0547\u00a0409\u00a0931,23 ₽');
        assert.equal(formatPaperKopecks('123', { signed: true }), '+1,23 ₽');
    });
});
