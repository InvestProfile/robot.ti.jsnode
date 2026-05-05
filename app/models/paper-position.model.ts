import { Model, DataTypes } from 'sequelize';
import sequelize from '../config/database';

export class PaperPositionModel extends Model {
    public id!: number;
    public status!: 'open' | 'closed';
    public ticker!: string;
    public name!: string | null;
    public figi!: string | null;
    public instrumentUid!: string;
    public entryPrice!: number;
    public currentPrice!: number | null;
    public exitPrice!: number | null;
    public highestPrice!: number;
    public quantityLots!: number;
    public lot!: number;
    public entryAmountRub!: number;
    public currentAmountRub!: number | null;
    public exitAmountRub!: number | null;
    public profitRub!: number | null;
    public profitPercent!: number | null;
    public entryScore!: number | null;
    public entryReason!: string;
    public exitSource!: string | null;
    public exitReason!: string | null;
    public openedAt!: Date;
    public closedAt!: Date | null;
}

PaperPositionModel.init({
    id: {
        type: DataTypes.INTEGER,
        autoIncrement: true,
        primaryKey: true,
    },
    status: {
        type: DataTypes.STRING,
        allowNull: false,
    },
    ticker: {
        type: DataTypes.STRING,
        allowNull: false,
    },
    name: {
        type: DataTypes.STRING,
        allowNull: true,
    },
    figi: {
        type: DataTypes.STRING,
        allowNull: true,
    },
    instrumentUid: {
        type: DataTypes.STRING,
        allowNull: false,
    },
    entryPrice: {
        type: DataTypes.DOUBLE,
        allowNull: false,
    },
    currentPrice: {
        type: DataTypes.DOUBLE,
        allowNull: true,
    },
    exitPrice: {
        type: DataTypes.DOUBLE,
        allowNull: true,
    },
    highestPrice: {
        type: DataTypes.DOUBLE,
        allowNull: false,
    },
    quantityLots: {
        type: DataTypes.INTEGER,
        allowNull: false,
    },
    lot: {
        type: DataTypes.INTEGER,
        allowNull: false,
    },
    entryAmountRub: {
        type: DataTypes.DOUBLE,
        allowNull: false,
    },
    currentAmountRub: {
        type: DataTypes.DOUBLE,
        allowNull: true,
    },
    exitAmountRub: {
        type: DataTypes.DOUBLE,
        allowNull: true,
    },
    profitRub: {
        type: DataTypes.DOUBLE,
        allowNull: true,
    },
    profitPercent: {
        type: DataTypes.DOUBLE,
        allowNull: true,
    },
    entryScore: {
        type: DataTypes.INTEGER,
        allowNull: true,
    },
    entryReason: {
        type: DataTypes.STRING,
        allowNull: false,
    },
    exitSource: {
        type: DataTypes.STRING,
        allowNull: true,
    },
    exitReason: {
        type: DataTypes.STRING,
        allowNull: true,
    },
    openedAt: {
        type: DataTypes.DATE,
        allowNull: false,
    },
    closedAt: {
        type: DataTypes.DATE,
        allowNull: true,
    },
}, {
    tableName: 'paper_positions',
    sequelize,
    timestamps: true,
});

export default PaperPositionModel;
