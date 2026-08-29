import sequelize from '../config/database';
import { VirtualAccountModel } from '../models/virtual-account.model';
import { VirtualLedgerEventModel } from '../models/virtual-ledger-event.model';
import { decodeVirtualLedgerEvent, encodeKopecks } from '../virtual/codecs';
import { applyVirtualLedgerEvent, openVirtualCashAccount, replayVirtualLedger } from '../virtual/ledger';
import { AccountOpenedEvent, DuplicateEventPolicy, StoredVirtualLedgerEvent, VirtualLedgerEvent } from '../virtual/types';
import { VirtualAccountRecord, VirtualLedgerRepository } from '../virtual/repository';

export const virtualLedgerRowToStoredEvent = (row: VirtualLedgerEventModel): StoredVirtualLedgerEvent => {
    const base = {
        id: row.eventId,
        virtualAccountId: row.virtualAccountId,
        occurredAt: row.occurredAt,
        kind: row.kind,
        amountKopecks: row.amountKopecks
    };
    if (row.kind === 'fee' || row.kind === 'interest') return { ...base, kind: row.kind, reason: row.reason || '' } as StoredVirtualLedgerEvent;
    if (row.kind === 'trade-cash') return {
        ...base, kind: 'trade-cash', direction: row.direction as 'credit' | 'debit',
        tradeReference: row.tradeReference || ''
    } as StoredVirtualLedgerEvent;
    return base as StoredVirtualLedgerEvent;
};

export const virtualLedgerEventToColumns = (event: VirtualLedgerEvent) => {
    return {
        virtualAccountId: event.virtualAccountId,
        eventId: event.id,
        occurredAt: event.occurredAt,
        kind: event.kind,
        amountKopecks: encodeKopecks(event.amountKopecks),
        reason: event.kind === 'fee' || event.kind === 'interest' ? event.reason : null,
        direction: event.kind === 'trade-cash' ? event.direction : null,
        tradeReference: event.kind === 'trade-cash' ? event.tradeReference : null
    };
};

export class SequelizeVirtualLedgerRepository implements VirtualLedgerRepository {
    async createAccount(account: VirtualAccountRecord, openingEvent: AccountOpenedEvent) {
        if (openingEvent.virtualAccountId !== account.virtualAccountId) throw new Error('opening event account does not match account record');
        const state = openVirtualCashAccount(openingEvent);
        return sequelize.transaction(async transaction => {
            await VirtualAccountModel.create({ ...account }, { transaction });
            await VirtualLedgerEventModel.create(virtualLedgerEventToColumns(state.entries[0]), { transaction });
            return state;
        });
    }

    async append(event: VirtualLedgerEvent, duplicatePolicy: DuplicateEventPolicy = 'reject') {
        return sequelize.transaction(async transaction => {
            const account = await VirtualAccountModel.findOne({
                where: { virtualAccountId: event.virtualAccountId }, transaction,
                lock: transaction.LOCK.UPDATE
            });
            if (!account) throw new Error(`virtual account not found: ${event.virtualAccountId}`);
            const rows = await VirtualLedgerEventModel.findAll({
                where: { virtualAccountId: event.virtualAccountId }, order: [['sequence', 'ASC']],
                transaction, lock: transaction.LOCK.UPDATE
            });
            const before = replayVirtualLedger(rows.map(row => decodeVirtualLedgerEvent(virtualLedgerRowToStoredEvent(row))));
            const after = applyVirtualLedgerEvent(before, event, duplicatePolicy);
            if (after !== before) await VirtualLedgerEventModel.create(virtualLedgerEventToColumns(after.entries[after.entries.length - 1]), { transaction });
            return after;
        });
    }

    async load(virtualAccountId: string) {
        const account = await VirtualAccountModel.findOne({ where: { virtualAccountId } });
        if (!account) throw new Error(`virtual account not found: ${virtualAccountId}`);
        const rows = await VirtualLedgerEventModel.findAll({ where: { virtualAccountId }, order: [['sequence', 'ASC']] });
        return replayVirtualLedger(rows.map(row => decodeVirtualLedgerEvent(virtualLedgerRowToStoredEvent(row))));
    }
}

export default SequelizeVirtualLedgerRepository;
