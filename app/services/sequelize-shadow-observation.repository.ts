import sequelize from '../config/database';
import { ShadowDecisionObservationModel } from '../models/shadow-decision-observation.model';
import { VirtualAccountModel } from '../models/virtual-account.model';
import type { ShadowDecisionObservation } from '../paper/shadow-intent.adapter';
import {
    ShadowObservationRepository,
    canonicalShadowObservation,
    shadowObservationFingerprint
} from '../paper/shadow-observation.repository';

const fromRow = (row: ShadowDecisionObservationModel): ShadowDecisionObservation => Object.freeze({
    decisionId: row.decisionId,
    virtualAccountId: row.virtualAccountId,
    instrumentId: row.instrumentId,
    evaluatedAt: row.evaluatedAt,
    action: row.action as ShadowDecisionObservation['action'],
    status: row.status as ShadowDecisionObservation['status'],
    source: row.source ?? undefined,
    reason: row.reason,
    orderId: row.orderId ?? undefined
});

export class SequelizeShadowObservationRepository implements ShadowObservationRepository {
    async append(observation: ShadowDecisionObservation): Promise<void> {
        const canonical = canonicalShadowObservation(observation);
        const payloadFingerprint = shadowObservationFingerprint(canonical);
        await sequelize.transaction(async transaction => {
            const account = await VirtualAccountModel.findOne({
                where: { virtualAccountId: canonical.virtualAccountId },
                transaction,
                lock: transaction.LOCK.UPDATE
            });
            if (!account) {
                throw new Error(`virtual account not found: ${canonical.virtualAccountId}`);
            }
            const existing = await ShadowDecisionObservationModel.findOne({
                where: {
                    virtualAccountId: canonical.virtualAccountId,
                    decisionId: canonical.decisionId
                },
                transaction,
                lock: transaction.LOCK.UPDATE
            });
            if (existing) {
                if (existing.payloadFingerprint !== payloadFingerprint) {
                    throw new Error(`shadow observation ID conflict: ${canonical.decisionId}`);
                }
                return;
            }
            await ShadowDecisionObservationModel.create({
                virtualAccountId: canonical.virtualAccountId,
                decisionId: canonical.decisionId,
                payloadFingerprint,
                instrumentId: canonical.instrumentId,
                evaluatedAt: canonical.evaluatedAt,
                action: canonical.action,
                status: canonical.status,
                source: canonical.source ?? null,
                reason: canonical.reason,
                orderId: canonical.orderId ?? null
            }, { transaction });
        });
    }

    async list(virtualAccountId: string): Promise<readonly ShadowDecisionObservation[]> {
        const rows = await ShadowDecisionObservationModel.findAll({
            where: { virtualAccountId },
            order: [['sequence', 'ASC']]
        });
        return Object.freeze(rows.map(fromRow));
    }
}

export default SequelizeShadowObservationRepository;
