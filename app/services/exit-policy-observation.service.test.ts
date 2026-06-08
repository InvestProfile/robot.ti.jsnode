import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert';
import ExitPolicyObservationModel from '../models/exit-policy-observation.model';
import ExitPolicyObservationService from './exit-policy-observation.service';

const originalFindOne = ExitPolicyObservationModel.findOne;
const originalCreate = ExitPolicyObservationModel.create;
const originalFindAll = ExitPolicyObservationModel.findAll;

const baseInput = {
    accountId: 'acc-1',
    accountAlias: 'trade',
    accountMode: 'trade' as const,
    figi: 'figi-1',
    instrumentUid: 'uid-1',
    ticker: 'TEST',
    name: 'Test',
    averagePrice: 100,
    currentPrice: 96,
    quantityLots: 1,
    currentSignal: {
        action: 'sell' as const,
        source: 'stop-loss' as const,
        confidence: 1,
        reason: 'current stop',
        profitPercent: -4
    },
    currentReason: 'current stop',
    exitPolicy: {
        label: 'ATR x2 max10',
        mode: 'observe' as const,
        status: 'would-hold' as const,
        action: 'hold' as const,
        reason: 'candidate would hold',
        lossPercent: 4,
        currentStopPercent: 3,
        candidateStopPercent: 6,
        currentAverageDailyRangePercent: 3,
        candidateAverageDailyRangePercent: 3,
        currentSource: 'stop-loss'
    }
};

afterEach(() => {
    (ExitPolicyObservationModel.findOne as unknown) = originalFindOne;
    (ExitPolicyObservationModel.create as unknown) = originalCreate;
    (ExitPolicyObservationModel.findAll as unknown) = originalFindAll;
});

describe('ExitPolicyObservationService', () => {
    it('records only disagreement statuses', async () => {
        let created = 0;
        (ExitPolicyObservationModel.findOne as unknown) = async () => undefined;
        (ExitPolicyObservationModel.create as unknown) = async (payload: Record<string, unknown>) => {
            created += 1;
            return { get: () => payload };
        };

        const ignored = await ExitPolicyObservationService.record({
            ...baseInput,
            exitPolicy: {
                ...baseInput.exitPolicy,
                status: 'same-hold',
                action: 'hold'
            }
        });
        const recorded = await ExitPolicyObservationService.record(baseInput);

        assert.strictEqual(ignored, undefined);
        assert.strictEqual(created, 1);
        assert.strictEqual(recorded?.candidateStatus, 'would-hold');
        assert.strictEqual(recorded?.ticker, 'TEST');
    });

    it('reuses an existing observation inside the same bucket', async () => {
        let created = 0;
        const existing = { observationKey: 'existing', candidateStatus: 'would-hold' };
        (ExitPolicyObservationModel.findOne as unknown) = async () => ({ get: () => existing });
        (ExitPolicyObservationModel.create as unknown) = async () => {
            created += 1;
            return { get: () => ({}) };
        };

        const recorded = await ExitPolicyObservationService.record(baseInput);

        assert.strictEqual(created, 0);
        assert.deepStrictEqual(recorded, existing);
    });

    it('summarizes recent observations', async () => {
        (ExitPolicyObservationModel.findAll as unknown) = async () => [
            { get: () => ({ candidateStatus: 'would-hold', ticker: 'A' }) },
            { get: () => ({ candidateStatus: 'would-sell', ticker: 'B' }) },
            { get: () => ({ candidateStatus: 'would-hold', ticker: 'C' }) }
        ];

        const result = await ExitPolicyObservationService.list(500);

        assert.strictEqual(result.limit, 300);
        assert.strictEqual(result.summary.total, 3);
        assert.strictEqual(result.summary.wouldHold, 2);
        assert.strictEqual(result.summary.wouldSell, 1);
    });
});
