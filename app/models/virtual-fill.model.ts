import { DataTypes, Model } from 'sequelize';
import sequelize from '../config/database';

export class VirtualFillModel extends Model {
    public sequence!: number;
    public virtualAccountId!: string;
    public fillId!: string;
    public orderId!: string;
    public instrumentId!: string;
    public side!: 'buy' | 'sell';
    public quantityLots!: number;
    public lotSize!: number;
    public referencePriceKopecks!: string;
    public executionPriceKopecks!: string;
    public grossAmountKopecks!: string;
    public feeKopecks!: string;
    public netCashDeltaKopecks!: string;
    public filledAt!: string;
}

VirtualFillModel.init({
    sequence: { type: DataTypes.BIGINT, autoIncrement: true, primaryKey: true },
    virtualAccountId: { type: DataTypes.STRING, allowNull: false },
    fillId: { type: DataTypes.STRING, allowNull: false },
    orderId: { type: DataTypes.STRING, allowNull: false },
    instrumentId: { type: DataTypes.STRING, allowNull: false },
    side: { type: DataTypes.STRING, allowNull: false },
    quantityLots: { type: DataTypes.INTEGER, allowNull: false },
    lotSize: { type: DataTypes.INTEGER, allowNull: false },
    referencePriceKopecks: { type: DataTypes.STRING, allowNull: false },
    executionPriceKopecks: { type: DataTypes.STRING, allowNull: false },
    grossAmountKopecks: { type: DataTypes.STRING, allowNull: false },
    feeKopecks: { type: DataTypes.STRING, allowNull: false },
    netCashDeltaKopecks: { type: DataTypes.STRING, allowNull: false },
    filledAt: { type: DataTypes.STRING, allowNull: false }
}, {
    tableName: 'virtual_fills', sequelize, timestamps: true,
    indexes: [
        { name: 'virtual_fills_account_fill_unique', unique: true, fields: ['virtualAccountId', 'fillId'] },
        { name: 'virtual_fills_account_order_unique', unique: true, fields: ['virtualAccountId', 'orderId'] }
    ]
});

export default VirtualFillModel;
