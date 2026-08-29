import { DataTypes, Model } from 'sequelize';
import sequelize from '../config/database';

export class VirtualLedgerEventModel extends Model {
    public sequence!: number;
    public virtualAccountId!: string;
    public eventId!: string;
    public occurredAt!: string;
    public kind!: string;
    public amountKopecks!: string;
    public reason!: string | null;
    public direction!: string | null;
    public tradeReference!: string | null;
}

VirtualLedgerEventModel.init({
    sequence: { type: DataTypes.BIGINT, autoIncrement: true, primaryKey: true },
    virtualAccountId: { type: DataTypes.STRING, allowNull: false },
    eventId: { type: DataTypes.STRING, allowNull: false },
    occurredAt: { type: DataTypes.STRING, allowNull: false },
    kind: { type: DataTypes.STRING, allowNull: false },
    amountKopecks: { type: DataTypes.STRING, allowNull: false },
    reason: { type: DataTypes.TEXT, allowNull: true },
    direction: { type: DataTypes.STRING, allowNull: true },
    tradeReference: { type: DataTypes.STRING, allowNull: true }
}, {
    tableName: 'virtual_ledger_events', sequelize, timestamps: true,
    indexes: [
        { name: 'virtual_ledger_account_event_unique', unique: true, fields: ['virtualAccountId', 'eventId'] },
        { name: 'virtual_ledger_account_sequence', fields: ['virtualAccountId', 'sequence'] }
    ]
});

export default VirtualLedgerEventModel;
