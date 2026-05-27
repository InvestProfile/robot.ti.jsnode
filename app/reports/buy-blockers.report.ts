import sequelize from '../config/database';
import { getRobotConfig } from '../config/robot.config';
import DatabaseService from '../services/database.service';
import InstrumentsService from '../services/instruments.service';
import BuySignalEvaluatorService, { BuySignalPreview } from '../services/buy-signal-evaluator.service';

const pad = (value: string, width: number) => {
    if (value.length >= width) return value.slice(0, width - 1) + '…';
    return value.padEnd(width, ' ');
};

const formatNumber = (value: number | undefined, digits = 0) => (
    value === undefined || !Number.isFinite(value) ? '-' : value.toFixed(digits)
);

const formatRub = (value: number | undefined) => formatNumber(value, 2);

const classifyBlocker = (preview: BuySignalPreview) => {
    const reason = preview.reason.toLowerCase();
    const checks = preview.preBuyRisk?.checks ?? [];

    if (reason.includes('no buy strategy signal')) return 'no_signal';
    if (preview.scoreAnalysis?.reason.toLowerCase().includes('negative tech gate')) return 'negative_tech';
    if (reason.includes('score-buy blocked') || reason.includes('score ')) return 'score';
    if (reason.includes('position concentration')) return 'position_concentration';
    if (reason.includes('portfolio is still below diversification')) return 'diversification';
    if (checks.some(check => check.key === 'add-on-position-profit' && check.status === 'block')) return 'weak_add_on';
    if (checks.some(check => ['spread', 'orderbook-ask', 'daily-turnover'].includes(check.key) && check.status === 'block')) return 'liquidity';
    if (checks.some(check => check.key === 'sector-share' && check.status === 'block')) return 'sector';
    if (reason.includes('daily') || reason.includes('limit')) return 'daily_limit';
    if (reason.includes('market regime') || reason.includes('market health')) return 'market';
    if (reason.includes('already in portfolio')) return 'already_in_portfolio';
    if (reason.includes('trading status')) return 'trading_status';
    if (reason.includes('not enough cash')) return 'cash';

    return 'other';
};

const explainScore = (preview: BuySignalPreview, defaultMinScore: number) => {
    const factors = preview.scoreAnalysis?.factors ?? {};
    const requiredScore = factors.negativeTechRequiredScore ?? defaultMinScore;

    return [
        `score=${formatNumber(preview.scoreAnalysis?.score)}`,
        `min=${formatNumber(requiredScore)}`,
        `base=${formatNumber(factors.baseScore)}`,
        `social=${formatNumber(factors.socialScoreAdjustment)}`,
        `analyst=${formatNumber(factors.analystScoreAdjustment)}`,
        `tech=${formatNumber(factors.technicalScoreAdjustment)}`
    ].join(' ');
};

const explainDataSources = (preview: BuySignalPreview) => {
    const text = preview.scoreAnalysis?.reason.toLowerCase() ?? '';
    const analyst = text.includes('analyst skipped')
        ? 'analyst:skipped'
        : text.includes('analyst stale cache ignored')
            ? 'analyst:stale-ignored'
            : text.includes('analyst') && text.includes('stale cache')
                ? 'analyst:stale'
                : text.includes('analyst') && text.includes('cached')
                    ? 'analyst:cached'
                    : text.includes('analyst')
                        ? 'analyst:fresh'
                        : 'analyst:none';
    const tech = text.includes('tech skipped')
        ? 'tech:skipped'
        : text.includes('tech') && text.includes('stale cache')
            ? 'tech:stale'
            : text.includes('tech') && text.includes('cached')
                ? 'tech:cached'
                : text.includes('tech')
                    ? 'tech:fresh'
                    : 'tech:none';

    return `${analyst} ${tech}`;
};

const getLimit = () => {
    const raw = process.argv.find(arg => /^\d+$/.test(arg));
    const limit = Number(raw ?? 80);
    return Number.isFinite(limit) && limit > 0 ? Math.trunc(limit) : 80;
};

const main = async () => {
    const limit = getLimit();
    const config = getRobotConfig();

    await DatabaseService.init();

    const shares = await InstrumentsService.getShares();
    const instruments = shares?.instruments ?? [];
    const previews = (await Promise.all(
        config.accountIds.map(accountId => BuySignalEvaluatorService.evaluateAccount(accountId, config, instruments))
    )).flat();

    const blocked = previews
        .filter(preview => preview.status === 'blocked')
        .map(preview => ({
            preview,
            blocker: classifyBlocker(preview)
        }));
    const allowed = previews.filter(preview => preview.status === 'allowed');
    const counts = blocked.reduce<Record<string, number>>((acc, item) => {
        acc[item.blocker] = (acc[item.blocker] ?? 0) + 1;
        return acc;
    }, {});

    console.log('Buy Blockers Report');
    console.log('===================');
    console.log(`Generated: ${new Date().toISOString()}`);
    console.log(`Accounts: ${config.accountIds.join(', ')}`);
    console.log(`Allowed: ${allowed.length}, blocked: ${blocked.length}`);
    console.log(`Blockers: ${Object.entries(counts).map(([key, count]) => `${key}=${count}`).join(', ') || '-'}`);
    console.log('');
    console.log([
        pad('Account', 16),
        pad('Ticker', 8),
        pad('Blocker', 20),
        pad('Score', 56),
        pad('Data', 34),
        pad('Price', 10),
        pad('Amount', 10),
        'Reason'
    ].join('  '));
    console.log('-'.repeat(140));

    for (const { preview, blocker } of blocked.slice(0, limit)) {
        console.log([
            pad(preview.accountAlias ?? preview.accountId, 16),
            pad(preview.ticker ?? '-', 8),
            pad(blocker, 20),
            pad(explainScore(preview, config.buyMinScore), 56),
            pad(explainDataSources(preview), 34),
            pad(formatRub(preview.currentPrice), 10),
            pad(formatRub(preview.estimatedOrderRub), 10),
            preview.reason
        ].join('  '));
    }
};

void main()
    .catch(error => {
        console.error('Buy blockers report failed:', error);
        process.exitCode = 1;
    })
    .finally(async () => {
        await sequelize.close().catch(() => undefined);
    });
