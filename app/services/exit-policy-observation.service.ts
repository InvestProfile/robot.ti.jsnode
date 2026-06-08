import { TradeSignal } from '../strategies/trade-signal';
import { ExitPolicyCandidateResult } from './exit-policy-candidate.service';
import ExitPolicyObservationModel from '../models/exit-policy-observation.model';

const OBSERVATION_BUCKET_MS = 15 * 60 * 1000;
const RECORDABLE_STATUSES = new Set(['would-hold', 'would-sell']);

export interface ExitPolicyObservationInput {
    accountId: string;
    accountAlias?: string;
    accountMode: 'trade' | 'observe';
    figi?: string;
    instrumentUid?: string;
    ticker?: string;
    name?: string;
    averagePrice?: number;
    currentPrice?: number;
    quantityLots?: number;
    currentSignal?: TradeSignal;
    currentReason?: string;
    exitPolicy?: ExitPolicyCandidateResult;
}

const finiteOrNull = (value: number | undefined) =>
    value !== undefined && Number.isFinite(value) ? value : null;

const getInstrumentKey = (input: ExitPolicyObservationInput) =>
    input.instrumentUid || input.figi || input.ticker || 'unknown';

const getObservationKey = (input: ExitPolicyObservationInput, observedAt: Date) => {
    const bucket = Math.floor(observedAt.getTime() / OBSERVATION_BUCKET_MS);
    return [
        bucket,
        input.accountId,
        getInstrumentKey(input),
        input.exitPolicy?.label,
        input.exitPolicy?.status,
        input.currentSignal?.source || '-'
    ].join(':');
};

const toPlain = (row: ExitPolicyObservationModel) => row.get({ plain: true });

export default class ExitPolicyObservationService {
    static isRecordable(exitPolicy: ExitPolicyCandidateResult | undefined) {
        return Boolean(exitPolicy && RECORDABLE_STATUSES.has(exitPolicy.status));
    }

    static async record(input: ExitPolicyObservationInput) {
        if (!this.isRecordable(input.exitPolicy)) return undefined;

        const observedAt = new Date();
        const observationKey = getObservationKey(input, observedAt);
        const existing = await ExitPolicyObservationModel.findOne({ where: { observationKey } });
        if (existing) return toPlain(existing);

        const row = await ExitPolicyObservationModel.create({
            observationKey,
            observedAt,
            accountId: input.accountId,
            accountAlias: input.accountAlias ?? null,
            accountMode: input.accountMode,
            figi: input.figi ?? null,
            instrumentUid: input.instrumentUid ?? null,
            ticker: input.ticker ?? null,
            name: input.name ?? null,
            currentAction: input.currentSignal?.action ?? null,
            currentSource: input.currentSignal?.source ?? null,
            currentReason: input.currentReason ?? input.currentSignal?.reason ?? null,
            candidateLabel: input.exitPolicy?.label,
            candidateStatus: input.exitPolicy?.status,
            candidateAction: input.exitPolicy?.action,
            candidateReason: input.exitPolicy?.reason,
            averagePrice: finiteOrNull(input.averagePrice),
            currentPrice: finiteOrNull(input.currentPrice),
            quantityLots: finiteOrNull(input.quantityLots),
            lossPercent: finiteOrNull(input.exitPolicy?.lossPercent),
            currentStopPercent: finiteOrNull(input.exitPolicy?.currentStopPercent),
            candidateStopPercent: finiteOrNull(input.exitPolicy?.candidateStopPercent),
            currentAverageDailyRangePercent: finiteOrNull(input.exitPolicy?.currentAverageDailyRangePercent),
            candidateAverageDailyRangePercent: finiteOrNull(input.exitPolicy?.candidateAverageDailyRangePercent)
        });

        return toPlain(row);
    }

    static async recordSafely(input: ExitPolicyObservationInput) {
        try {
            return await this.record(input);
        } catch (error) {
            console.error('Unable to record exit policy observation:', {
                accountId: input.accountId,
                ticker: input.ticker,
                instrumentUid: input.instrumentUid,
                status: input.exitPolicy?.status,
                error
            });
            return undefined;
        }
    }

    static async list(limit = 80) {
        const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), 300);
        const rows = await ExitPolicyObservationModel.findAll({
            order: [['observedAt', 'DESC']],
            limit: safeLimit
        });

        const items = rows.map(toPlain);
        const wouldHold = items.filter(item => item.candidateStatus === 'would-hold').length;
        const wouldSell = items.filter(item => item.candidateStatus === 'would-sell').length;

        return {
            generatedAt: new Date().toISOString(),
            limit: safeLimit,
            summary: {
                total: items.length,
                wouldHold,
                wouldSell
            },
            items
        };
    }
}
