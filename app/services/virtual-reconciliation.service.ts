import type { VirtualLedgerRepository } from '../virtual/repository';
import type { VirtualPositionRepository } from '../virtual/position-repository';
import {
    VirtualAccountReconciliation,
    VirtualInstrumentMark,
    reconcileVirtualAccount
} from '../virtual/reconciliation';

export interface VirtualMarkProvider {
    getMarks(
        virtualAccountId: string,
        instrumentIds: readonly string[]
    ): Promise<readonly VirtualInstrumentMark[]>;
}

export class VirtualReconciliationService {
    constructor(
        private readonly ledger: Pick<VirtualLedgerRepository, 'load'>,
        private readonly positions: VirtualPositionRepository,
        private readonly marks: VirtualMarkProvider
    ) {}

    async load(virtualAccountId: string): Promise<VirtualAccountReconciliation> {
        const [account, portfolio] = await Promise.all([
            this.ledger.load(virtualAccountId),
            this.positions.load(virtualAccountId)
        ]);
        const instrumentIds = portfolio.positions
            .filter(position => position.openLots.some(lot => lot.quantityLots > 0))
            .map(position => position.instrumentId);
        const marks = await this.marks.getMarks(virtualAccountId, Object.freeze(instrumentIds));
        return reconcileVirtualAccount(account, portfolio.fills, marks);
    }
}

export default VirtualReconciliationService;
