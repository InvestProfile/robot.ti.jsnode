import { Model, DataTypes } from 'sequelize';
import sequelize from '../config/database';

export class TradeDecisionModel extends Model {
    public id!: number;
    public accountId!: string;
    public accountAlias!: string;
    public accountMode!: string;
    public figi!: string;
    public instrumentUid!: string;
    public ticker!: string;
    public name!: string;
    public status!: string;
    public signalSource!: string;
    public reason!: string;
    public averagePrice!: number;
    public currentPrice!: number;
    public profitPercent!: number;
    public quantityLots!: number;
}

TradeDecisionModel.init({
    id: {
        type: DataTypes.INTEGER,
        autoIncrement: true,
        primaryKey: true,
    },
    accountId: {
        type: DataTypes.STRING,
        allowNull: false,
    },
    accountAlias: {
        type: DataTypes.STRING,
        allowNull: true,
    },
    accountMode: {
        type: DataTypes.STRING,
        allowNull: false,
        defaultValue: 'trade',
    },
    figi: {
        type: DataTypes.STRING,
        allowNull: true,
    },
    instrumentUid: {
        type: DataTypes.STRING,
        allowNull: true,
    },
    ticker: {
        type: DataTypes.STRING,
        allowNull: true,
    },
    name: {
        type: DataTypes.STRING,
        allowNull: true,
    },
    status: {
        type: DataTypes.STRING,
        allowNull: false,
    },
    signalSource: {
        type: DataTypes.STRING,
        allowNull: true,
    },
    reason: {
        type: DataTypes.STRING,
        allowNull: false,
    },
    averagePrice: {
        type: DataTypes.DOUBLE,
        allowNull: true,
    },
    currentPrice: {
        type: DataTypes.DOUBLE,
        allowNull: true,
    },
    profitPercent: {
        type: DataTypes.DOUBLE,
        allowNull: true,
    },
    quantityLots: {
        type: DataTypes.INTEGER,
        allowNull: true,
    },
}, {
    tableName: 'trade_decisions',
    sequelize,
    timestamps: true,
});

export default TradeDecisionModel;
