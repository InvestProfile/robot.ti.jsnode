import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runVirtualObservationWorker } from './virtual-observation.worker';

describe('separate virtual observation worker', () => {
    it('loads no database/runtime dependencies when its flag is absent', async () => {
        let loads = 0;
        await runVirtualObservationWorker({}, async () => {
            loads += 1;
            throw new Error('disabled worker must not load dependencies');
        });
        assert.equal(loads, 0);
    });

    it('fails before dependency loading when enabled configuration is incomplete', async () => {
        let loads = 0;
        await assert.rejects(runVirtualObservationWorker({
            ROBOT_VIRTUAL_OBSERVATION_ENABLED: 'true'
        }, async () => {
            loads += 1;
            throw new Error('must not load dependencies');
        }), /requires ROBOT_VIRTUAL_OBSERVATION_EXPERIMENT_ID/);
        assert.equal(loads, 0);
    });
});
