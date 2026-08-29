import { VirtualAccountModel } from '../models/virtual-account.model';
import { VirtualFillModel } from '../models/virtual-fill.model';
import { decodeKopecks } from '../virtual/codecs';
import type { VirtualFill } from '../virtual/execution';
import {
    VirtualPositionRepository,
    replayVirtualPositions
} from '../virtual/position-repository';

export const virtualFillRowToDomain = (row: VirtualFillModel): VirtualFill => ({
    id: row.fillId,
    orderId: row.orderId,
    virtualAccountId: row.virtualAccountId,
    instrumentId: row.instrumentId,
    side: row.side,
    quantityLots: row.quantityLots,
    lotSize: row.lotSize,
    referencePriceKopecks: decodeKopecks(row.referencePriceKopecks),
    executionPriceKopecks: decodeKopecks(row.executionPriceKopecks),
    grossAmountKopecks: decodeKopecks(row.grossAmountKopecks),
    feeKopecks: decodeKopecks(row.feeKopecks),
    netCashDeltaKopecks: decodeKopecks(row.netCashDeltaKopecks),
    filledAt: row.filledAt
});

export class SequelizeVirtualPositionRepository implements VirtualPositionRepository {
    async load(virtualAccountId: string) {
        const account = await VirtualAccountModel.findOne({ where: { virtualAccountId } });
        if (!account) throw new Error(`virtual account not found: ${virtualAccountId}`);
        const rows = await VirtualFillModel.findAll({
            where: { virtualAccountId },
            order: [['sequence', 'ASC']]
        });
        return replayVirtualPositions(virtualAccountId, rows.map(virtualFillRowToDomain));
    }
}

export default SequelizeVirtualPositionRepository;
