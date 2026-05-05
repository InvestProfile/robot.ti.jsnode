import { Model, DataTypes } from 'sequelize';
import sequelize from '../config/database';

export class BuySignalJournalModel extends Model {
    public id!: number;
    public signalKey!: string;
    public ticker!: string;
    public name!: string | null;
    public figi!: string | null;
    public instrumentUid!: string;
    public signaledAt!: Date;
    public signalPrice!: number;
    public signalScore!: number;
    public profileTrendDays!: number;
    public profileMinScore!: number;
    public reason!: string;
    public return1dPercent!: number | null;
    public return3dPercent!: number | null;
    public return5dPercent!: number | null;
    public return10dPercent!: number | null;
    public checkedAt!: Date | null;
    public completedAt!: Date | null;
}

BuySignalJournalModel.init({
    id: {
        type: DataTypes.INTEGER,
        autoIncrement: true,
        primaryKey: true,
    },
    signalKey: {
        type: DataTypes.STRING,
        allowNull: false,
        unique: true,
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
    signaledAt: {
        type: DataTypes.DATE,
        allowNull: false,
    },
    signalPrice: {
        type: DataTypes.DOUBLE,
        allowNull: false,
    },
    signalScore: {
        type: DataTypes.INTEGER,
        allowNull: false,
    },
    profileTrendDays: {
        type: DataTypes.INTEGER,
        allowNull: false,
    },
    profileMinScore: {
        type: DataTypes.INTEGER,
        allowNull: false,
    },
    reason: {
        type: DataTypes.STRING,
        allowNull: false,
    },
    return1dPercent: {
        type: DataTypes.DOUBLE,
        allowNull: true,
    },
    return3dPercent: {
        type: DataTypes.DOUBLE,
        allowNull: true,
    },
    return5dPercent: {
        type: DataTypes.DOUBLE,
        allowNull: true,
    },
    return10dPercent: {
        type: DataTypes.DOUBLE,
        allowNull: true,
    },
    checkedAt: {
        type: DataTypes.DATE,
        allowNull: true,
    },
    completedAt: {
        type: DataTypes.DATE,
        allowNull: true,
    },
}, {
    tableName: 'buy_signal_journal',
    sequelize,
    timestamps: true,
});

export default BuySignalJournalModel;
