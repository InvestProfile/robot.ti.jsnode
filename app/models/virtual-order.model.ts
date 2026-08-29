import { DataTypes, Model } from 'sequelize';
import sequelize from '../config/database';

export class VirtualOrderModel extends Model {
    public sequence!: number;
    public virtualAccountId!: string;
    public orderId!: string;
    public requestFingerprint!: string;
    public instrumentId!: string;
    public side!: 'buy' | 'sell';
    public quantityLots!: number;
    public submittedAt!: string;
    public status!: 'filled' | 'rejected';
    public rejectionReason!: string | null;
    public completedAt!: string;
    public resultJson!: string;
}

VirtualOrderModel.init({
    sequence: { type: DataTypes.BIGINT, autoIncrement: true, primaryKey: true },
    virtualAccountId: { type: DataTypes.STRING, allowNull: false },
    orderId: { type: DataTypes.STRING, allowNull: false },
    requestFingerprint: { type: DataTypes.TEXT, allowNull: false },
    instrumentId: { type: DataTypes.STRING, allowNull: false },
    side: { type: DataTypes.STRING, allowNull: false },
    quantityLots: { type: DataTypes.INTEGER, allowNull: false },
    submittedAt: { type: DataTypes.STRING, allowNull: false },
    status: { type: DataTypes.STRING, allowNull: false },
    rejectionReason: { type: DataTypes.STRING, allowNull: true },
    completedAt: { type: DataTypes.STRING, allowNull: false },
    resultJson: { type: DataTypes.TEXT, allowNull: false }
}, {
    tableName: 'virtual_orders', sequelize, timestamps: true,
    indexes: [
        { name: 'virtual_orders_account_order_unique', unique: true, fields: ['virtualAccountId', 'orderId'] },
        { name: 'virtual_orders_account_sequence', fields: ['virtualAccountId', 'sequence'] }
    ]
});

export default VirtualOrderModel;
