import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { completeAcquiredVirtualObservationRuntime } from './virtual-observation-runtime.service';
import type { ObservationLease } from '../paper/observation-persistence';

describe('virtual observation runtime lease ownership', () => {
    it('releases an acquired lease when post-acquire construction fails', async () => {
        let releases = 0;
        const lease: ObservationLease = {
            leaseName: 'virtual-observation:test',
            ownerId: 'test-owner',
            renew: async () => true,
            release: async () => { releases += 1; }
        };
        const failure = new Error('runtime constructor failed');
        await assert.rejects(
            completeAcquiredVirtualObservationRuntime(lease, () => { throw failure; }),
            error => error === failure
        );
        assert.equal(releases, 1);
    });
});
