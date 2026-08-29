import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    InMemoryShadowObservationRepository,
    ShadowObservationRepository
} from './shadow-observation.repository';
import type { ShadowDecisionObservation } from './shadow-intent.adapter';

const observation = (overrides: Partial<ShadowDecisionObservation> = {}): ShadowDecisionObservation => ({
    decisionId: 'decision-1', virtualAccountId: 'paper-1', instrumentId: 'SBER',
    evaluatedAt: '2026-08-29T10:00:00.000Z', action: 'buy', status: 'allowed',
    source: 'score-buy', reason: 'risk gates passed', orderId: 'shadow:paper-1:decision-1',
    ...overrides
});

const contract = (name: string, create: () => ShadowObservationRepository) => {
    describe(name, () => {
        it('stores an exact retry once', async () => {
            const repository = create();
            await repository.append(observation());
            await repository.append({ ...observation() });
            assert.deepEqual(await repository.list('paper-1'), [observation()]);
        });

        it('rejects a changed payload with the same account-scoped decision ID', async () => {
            const repository = create();
            await repository.append(observation());
            await assert.rejects(repository.append(observation({ reason: 'changed' })), /ID conflict/);
        });

        it('isolates identical decision IDs between virtual accounts', async () => {
            const repository = create();
            await repository.append(observation());
            await repository.append(observation({ virtualAccountId: 'paper-2', orderId: undefined }));
            assert.equal((await repository.list('paper-1')).length, 1);
            assert.equal((await repository.list('paper-2')).length, 1);
        });

        it('rejects malformed observations before persistence', async () => {
            const repository = create();
            await assert.rejects(repository.append(observation({ decisionId: ' bad ' })), /trimmed/);
            await assert.rejects(repository.append(observation({ evaluatedAt: 'not-a-date' })), /RFC3339/);
            assert.equal((await repository.list('paper-1')).length, 0);
        });
    });
};

contract('in-memory shadow observation repository contract',
    () => new InMemoryShadowObservationRepository());
