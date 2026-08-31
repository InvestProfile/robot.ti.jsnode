import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { RobotConfig } from '../config/robot.config';
import type { ShadowSourceTickDraft } from '../paper/shadow-source-outbox';
import {
    createConfiguredPostRiskOutboxProducer,
    createPostRiskOutboxProducer,
    getPostRiskOutboxRuntimeState,
    resetPostRiskOutboxSingletonForTests,
    runLiveOperationAfterShadowEnqueue,
    shadowStrategyConfigFingerprint,
    sourceTradingTickIdFor,
    sourceTradingTickIdForProducer
} from './post-risk-outbox-producer.service';

const config = (overrides: Partial<RobotConfig> = {}) => ({
    accountIds: ['account'], observeAccountIds: [], accountAliases: {}, protectedAccountIds: [], dryRun: false,
    liveConfirmationRequired: true, liveAllowedActions: ['sell'], tradingPaused: false, intervalMs: 60_000,
    shadowSourceOutboxEnabled: false, enabledStrategies: ['score-buy', 'stop-loss'], buyDailyGuardEnabled: true,
    buyDailyGuardEnforced: true, liquidityRiskEnabled: true, liquidityRiskEnforced: true,
    sellHoldWinnerMinProfitPercent: 2, ...overrides
} as RobotConfig);

const decision = (overrides = {}) => ({
    sourceTradingTickId: 'trading:60000:2026-08-31T12:00:00.000Z',
    accountId: 'account', instrumentId: 'uid-1', action: 'buy' as const, status: 'allowed' as const,
    approvedLots: 2, lotSize: 10, reason: 'all post-risk checks passed',
    evaluatedAt: '2026-08-31T12:00:00.050Z', priceRub: 123.456,
    quoteObservedAt: '2026-08-31T12:00:00.000Z', quoteTimestampQuality: 'captured-after-read' as const,
    ...overrides
});
const turn = () => new Promise<void>(resolve => setImmediate(resolve));

describe('post-risk outbox producer', () => {
    it('does not construct any dependency when disabled', async () => {
        resetPostRiskOutboxSingletonForTests();
        let calls = 0;
        const producer = await createConfiguredPostRiskOutboxProducer(config(), async () => {
            calls += 1; return { async publish() {} };
        });
        assert.equal(producer, undefined);
        assert.equal(calls, 0);
        assert.equal(sourceTradingTickIdForProducer(undefined, 'not-a-date', 0), undefined);
    });

    it('initializes exactly one process-lifetime producer for repeated ticks', async () => {
        resetPostRiskOutboxSingletonForTests();
        let factories = 0;
        const enabled = config({ shadowSourceOutboxEnabled: true });
        const factory = async () => { factories += 1; return { async publish() {} }; };
        const first = await createConfiguredPostRiskOutboxProducer(enabled, factory);
        const second = await createConfiguredPostRiskOutboxProducer(enabled, factory);
        assert.equal(first, second);
        assert.equal(factories, 1);
        assert.equal(await createConfiguredPostRiskOutboxProducer(
            config({ shadowSourceOutboxEnabled: true, buyDailyGuardEnforced: false }), factory
        ), undefined);
        assert.equal(factories, 1);
    });

    it('a hanging publish cannot delay or alter live order arguments/result', async () => {
        let publishStarted = false;
        const producer = createPostRiskOutboxProducer({
            async publish() { publishStarted = true; await new Promise(() => undefined); }
        }, 'a'.repeat(64));
        const orderArgs = Object.freeze({ accountId: 'account', side: 'BUY', lots: 2, instrumentId: 'uid-1' });
        const expectedResult = Object.freeze({ orderId: 'broker-result', status: 'posted' });
        let receivedArgs: typeof orderArgs | undefined;

        const actual = runLiveOperationAfterShadowEnqueue(producer, decision(), () => {
            receivedArgs = orderArgs;
            return expectedResult;
        });

        assert.equal(actual, expectedResult);
        assert.equal(receivedArgs, orderArgs);
        assert.equal(publishStarted, false);
        await turn();
        assert.equal(publishStarted, true);
        assert.equal(getPostRiskOutboxRuntimeState().queueDepth, 1);
    });

    it('serializes background drain and drops overflow without blocking callers', async () => {
        let releaseFirst: (() => void) | undefined;
        const seen: string[] = [];
        const producer = createPostRiskOutboxProducer({
            async publish(draft) {
                seen.push(draft.sourceTickId);
                if (seen.length === 1) await new Promise<void>(resolve => { releaseFirst = resolve; });
            }
        }, 'b'.repeat(64), { capacity: 2 });
        assert.equal(producer.enqueue(decision()), true);
        assert.equal(producer.enqueue(decision({ instrumentId: 'uid-2' })), true);
        assert.equal(producer.enqueue(decision({ instrumentId: 'uid-3' })), false);
        await turn();
        assert.equal(seen.length, 1);
        releaseFirst?.();
        await turn();
        assert.equal(seen.length, 2);
    });

    it('rejects invalid allowed lots but accepts zero for blocked/hold', async () => {
        const drafts: ShadowSourceTickDraft[] = [];
        const producer = createPostRiskOutboxProducer({ async publish(draft) { drafts.push(draft); } }, 'c'.repeat(64));
        assert.equal(producer.enqueue(decision({ approvedLots: 0 })), false);
        assert.equal(producer.enqueue(decision({ approvedLots: 1.5 })), false);
        assert.equal(producer.enqueue(decision({ status: 'blocked', approvedLots: 0 })), true);
        assert.equal(producer.enqueue(decision({ action: 'hold', status: 'hold', approvedLots: 0 })), true);
        await turn();
        assert.equal(drafts.length, 2);
    });

    it('derives stable account-scoped identities and records honest timestamp quality', async () => {
        const drafts: ShadowSourceTickDraft[] = [];
        const producer = createPostRiskOutboxProducer({ async publish(draft) { drafts.push(draft); } }, 'd'.repeat(64), {
            now: () => new Date('2026-08-31T12:00:00.100Z')
        });
        producer.enqueue(decision());
        producer.enqueue(decision());
        producer.enqueue(decision({ accountId: 'account-2' }));
        await turn();
        assert.equal(drafts.length, 2);
        assert.notEqual(drafts[0].sourceTickId, drafts[1].sourceTickId);
        assert.equal(drafts[0].events[0].sourceAccountId, 'account');
        assert.equal(drafts[0].events[0].quote.quoteTimestampQuality, 'captured-after-read');
        assert.equal(drafts[0].events[0].quote.markKopecks, 12346n);
    });

    it('keeps logical ID stable across retry timestamps and changes it next scheduler bucket', async () => {
        const drafts: ShadowSourceTickDraft[] = [];
        const producer = createPostRiskOutboxProducer({ async publish(draft) { drafts.push(draft); } }, 'e'.repeat(64));
        const first = decision();
        assert.equal(producer.enqueue(first), true);
        assert.equal(producer.enqueue(decision({
            evaluatedAt: '2026-08-31T12:00:10.000Z', quoteObservedAt: '2026-08-31T12:00:09.900Z'
        })), false);
        assert.equal(producer.enqueue(decision({
            sourceTradingTickId: 'trading:60000:2026-08-31T12:01:00.000Z',
            evaluatedAt: '2026-08-31T12:01:00.050Z', quoteObservedAt: '2026-08-31T12:01:00.000Z'
        })), true);
        await turn();
        assert.equal(drafts.length, 2);
        assert.notEqual(drafts[0].sourceTickId, drafts[1].sourceTickId);
        assert.equal(sourceTradingTickIdFor('2026-08-31T12:00:59.999Z', 60_000), first.sourceTradingTickId);
        assert.notEqual(sourceTradingTickIdFor('2026-08-31T12:01:00.000Z', 60_000), first.sourceTradingTickId);
    });

    it('construction failure is observable but leaves live result unchanged', async () => {
        resetPostRiskOutboxSingletonForTests();
        const unavailable = await createConfiguredPostRiskOutboxProducer(config({ shadowSourceOutboxEnabled: true }),
            async () => { throw new Error('database unavailable'); });
        assert.equal(unavailable, undefined);
        assert.deepEqual({ orderId: 'unchanged' }, { orderId: 'unchanged' });
    });

    it('excludes emergency execution toggles from strategy fingerprint', () => {
        const baseline = config();
        const emergency = config({ liveAllowedActions: ['buy', 'sell'], tradingPaused: true, dryRun: true,
            liveConfirmationRequired: false, shadowSourceOutboxEnabled: true });
        assert.equal(shadowStrategyConfigFingerprint(baseline), shadowStrategyConfigFingerprint(emergency));
        assert.notEqual(shadowStrategyConfigFingerprint(baseline),
            shadowStrategyConfigFingerprint(config({ buyDailyGuardEnforced: false })));
    });
});
