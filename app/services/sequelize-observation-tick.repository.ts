import { createHash } from 'node:crypto';
import sequelize from '../config/database';
import { UniqueConstraintError } from 'sequelize';
import { VirtualObservationTickModel } from '../models/virtual-observation-tick.model';
import type { ObservationTickStore } from '../paper/shadow-composition';
import type { ObservationTick } from '../virtual/observation-runner';

const stringify = (tick: ObservationTick) => JSON.stringify(tick, (_key, value) =>
    typeof value === 'bigint' ? { $kopecks: value.toString() } : value
);

const parse = (payload: string): ObservationTick => JSON.parse(payload, (_key, value) => {
    if (value && typeof value === 'object' && Object.keys(value).length === 1
        && typeof value.$kopecks === 'string' && /^(0|-?[1-9]\d*)$/.test(value.$kopecks)) {
        return BigInt(value.$kopecks);
    }
    return value;
}) as ObservationTick;

const fingerprint = (payload: string) => createHash('sha256').update(payload).digest('hex');

export class SequelizeObservationTickRepository implements ObservationTickStore {
    async load(experimentId: string): Promise<readonly ObservationTick[]> {
        const rows = await VirtualObservationTickModel.findAll({
            where: { experimentId }, order: [['observedAt', 'ASC'], ['sequence', 'ASC']]
        });
        return Object.freeze(rows.map(row => parse(row.payloadJson)));
    }

    async append(experimentId: string, tick: ObservationTick): Promise<void> {
        const payloadJson = stringify(tick);
        const payloadFingerprint = fingerprint(payloadJson);
        try {
            await sequelize.transaction(async transaction => {
                const existing = await VirtualObservationTickModel.findOne({
                    where: { experimentId, tickId: tick.tickId }, transaction,
                    lock: transaction.LOCK.UPDATE
                });
                if (existing) {
                    if (existing.payloadFingerprint !== payloadFingerprint) {
                        throw new Error(`observation tick ID conflict: ${tick.tickId}`);
                    }
                    return;
                }
                await VirtualObservationTickModel.create({
                    experimentId, tickId: tick.tickId, observedAt: tick.observedAt,
                    payloadFingerprint, payloadJson
                }, { transaction });
            });
        } catch (error) {
            if (!(error instanceof UniqueConstraintError)) throw error;
            const winner = await VirtualObservationTickModel.findOne({ where: { experimentId, tickId: tick.tickId } });
            if (!winner || winner.payloadFingerprint !== payloadFingerprint) {
                throw new Error(`observation tick ID conflict: ${tick.tickId}`);
            }
        }
    }
}

export default SequelizeObservationTickRepository;
