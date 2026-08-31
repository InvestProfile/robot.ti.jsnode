import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runVirtualObservationWorker } from './virtual-observation.worker';
import type { ObservationExperimentSettings } from './observation-persistence';

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

    it('constructs exact v2 evidence settings while legacy remains v1', async () => {
        const captured: ObservationExperimentSettings[] = [];
        const run = (environment: Parameters<typeof runVirtualObservationWorker>[0]) => runVirtualObservationWorker(environment, async () => ({
            authenticate: async () => undefined,
            close: async () => undefined,
            prepareRuntime: async (_experimentId, _leaseTtlMs, settings) => {
                captured.push(settings);
                throw new Error('captured');
            }
        })).catch(error => assert.match(String(error), /captured/));
        await run({ ROBOT_VIRTUAL_OBSERVATION_ENABLED: 'true', ROBOT_VIRTUAL_OBSERVATION_EXPERIMENT_ID: 'legacy' });
        await run({
            ROBOT_VIRTUAL_OBSERVATION_ENABLED: 'true',
            ROBOT_VIRTUAL_OBSERVATION_EXPERIMENT_ID: 'qualified',
            ROBOT_VIRTUAL_EVIDENCE_VERSION: '2',
            ROBOT_VIRTUAL_BENCHMARK_ID: 'IMOEX',
            ROBOT_VIRTUAL_BENCHMARK_INSTRUMENT_UID: ' benchmark-uid ',
            ROBOT_VIRTUAL_EVIDENCE_MAX_MARK_AGE_MS: '7000',
            ROBOT_VIRTUAL_EVIDENCE_MAX_INTER_INSTRUMENT_SKEW_MS: '2500'
        });
        assert.equal('evidenceConfig' in captured[0], false);
        assert.deepEqual(captured[1].evidenceConfig, {
            configVersion: 2, marketDataSource: 't-invest-market-data-readonly',
            sessionPolicyVersion: 't-invest-session-v1-open-only', benchmarkInstrumentUid: 'benchmark-uid',
            benchmarkMethodology: 'normalized-price-return',
            benchmarkReturnScope: 'price-only-excludes-dividends-fees-and-total-return',
            maxMarkAgeMs: 7000, maxInterInstrumentSkewMs: 2500
        });
        assert.equal(Object.isFrozen(captured[1].evidenceConfig), true);
    });

    it('rejects unsupported and incomplete v2 config before dependency loading', async () => {
        const base = { ROBOT_VIRTUAL_OBSERVATION_ENABLED: 'true', ROBOT_VIRTUAL_OBSERVATION_EXPERIMENT_ID: 'qualified' };
        const cases = [
            [{ ...base, ROBOT_VIRTUAL_EVIDENCE_VERSION: '3' }, /must be 1 or 2/],
            [{ ...base, ROBOT_VIRTUAL_EVIDENCE_VERSION: '2' }, /BENCHMARK_ID is required/],
            [{ ...base, ROBOT_VIRTUAL_EVIDENCE_VERSION: '2', ROBOT_VIRTUAL_BENCHMARK_ID: 'IMOEX' }, /BENCHMARK_INSTRUMENT_UID is required/],
            [{ ...base, ROBOT_VIRTUAL_EVIDENCE_VERSION: '2', ROBOT_VIRTUAL_BENCHMARK_ID: 'IMOEX',
                ROBOT_VIRTUAL_BENCHMARK_INSTRUMENT_UID: 'uid', ROBOT_VIRTUAL_EVIDENCE_MAX_MARK_AGE_MS: '0' }, /MAX_MARK_AGE_MS/],
            [{ ...base, ROBOT_VIRTUAL_EVIDENCE_VERSION: '2', ROBOT_VIRTUAL_BENCHMARK_ID: 'IMOEX',
                ROBOT_VIRTUAL_BENCHMARK_INSTRUMENT_UID: 'uid', ROBOT_VIRTUAL_EVIDENCE_MAX_INTER_INSTRUMENT_SKEW_MS: '-1' }, /MAX_INTER_INSTRUMENT_SKEW_MS/]
        ] as const;
        for (const [environment, pattern] of cases) {
            let loads = 0;
            await assert.rejects(runVirtualObservationWorker(environment, async () => {
                loads += 1;
                throw new Error('must not load dependencies');
            }), pattern);
            assert.equal(loads, 0);
        }
    });

    it('rejects invalid intervals before loading dependencies even with an explicit valid TTL', async () => {
        for (const interval of ['0', 'NaN', '1.5', String(24 * 60 * 60 * 1000 + 1)]) {
            let loads = 0;
            await assert.rejects(runVirtualObservationWorker({
                ROBOT_VIRTUAL_OBSERVATION_ENABLED: 'true',
                ROBOT_VIRTUAL_OBSERVATION_EXPERIMENT_ID: 'interval-check',
                ROBOT_VIRTUAL_OBSERVATION_INTERVAL_MS: interval,
                ROBOT_VIRTUAL_OBSERVATION_LEASE_TTL_MS: String(24 * 60 * 60 * 1000 + 2)
            }, async () => {
                loads += 1;
                throw new Error('must not load dependencies');
            }), /ROBOT_VIRTUAL_OBSERVATION_INTERVAL_MS/);
            assert.equal(loads, 0);
        }
    });
});
