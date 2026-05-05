import { Model, DataTypes } from 'sequelize';
import sequelize from '../config/database';

export class SignalStateModel extends Model {
    public id!: number;
    public signalKey!: string;
    public accountId!: string;
    public accountMode!: string;
    public instrumentUid!: string;
    public ticker!: string;
    public signalSource!: string;
    public status!: string;
    public reason!: string;
    public fingerprint!: string;
    public lastPrice!: number;
    public lastLoggedAt!: Date;
}

SignalStateModel.init({
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
    accountId: {
        type: DataTypes.STRING,
        allowNull: false,
    },
    accountMode: {
        type: DataTypes.STRING,
        allowNull: false,
    },
    instrumentUid: {
        type: DataTypes.STRING,
        allowNull: true,
    },
    ticker: {
        type: DataTypes.STRING,
        allowNull: true,
    },
    signalSource: {
        type: DataTypes.STRING,
        allowNull: true,
    },
    status: {
        type: DataTypes.STRING,
        allowNull: false,
    },
    reason: {
        type: DataTypes.STRING,
        allowNull: false,
    },
    fingerprint: {
        type: DataTypes.STRING,
        allowNull: false,
    },
    lastPrice: {
        type: DataTypes.DOUBLE,
        allowNull: true,
    },
    lastLoggedAt: {
        type: DataTypes.DATE,
        allowNull: false,
    },
}, {
    tableName: 'signal_states',
    sequelize,
    timestamps: true,
});

export default SignalStateModel;
