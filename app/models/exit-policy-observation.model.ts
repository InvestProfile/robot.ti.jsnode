import { Model, DataTypes } from 'sequelize';
import sequelize from '../config/database';

export class ExitPolicyObservationModel extends Model {
    public id!: number;
    public observationKey!: string;
    public observedAt!: Date;
    public accountId!: string;
    public accountAlias!: string | null;
    public accountMode!: string;
    public figi!: string | null;
    public instrumentUid!: string | null;
    public ticker!: string | null;
    public name!: string | null;
    public currentAction!: string | null;
    public currentSource!: string | null;
    public currentReason!: string | null;
    public candidateLabel!: string;
    public candidateStatus!: string;
    public candidateAction!: string;
    public candidateReason!: string;
    public averagePrice!: number | null;
    public currentPrice!: number | null;
    public quantityLots!: number | null;
    public lossPercent!: number | null;
    public currentStopPercent!: number | null;
    public candidateStopPercent!: number | null;
    public currentAverageDailyRangePercent!: number | null;
    public candidateAverageDailyRangePercent!: number | null;
}

ExitPolicyObservationModel.init({
    id: {
        type: DataTypes.INTEGER,
        autoIncrement: true,
        primaryKey: true,
    },
    observationKey: {
        type: DataTypes.STRING,
        allowNull: false,
        unique: true,
    },
    observedAt: {
        type: DataTypes.DATE,
        allowNull: false,
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
    currentAction: {
        type: DataTypes.STRING,
        allowNull: true,
    },
    currentSource: {
        type: DataTypes.STRING,
        allowNull: true,
    },
    currentReason: {
        type: DataTypes.TEXT,
        allowNull: true,
    },
    candidateLabel: {
        type: DataTypes.STRING,
        allowNull: false,
    },
    candidateStatus: {
        type: DataTypes.STRING,
        allowNull: false,
    },
    candidateAction: {
        type: DataTypes.STRING,
        allowNull: false,
    },
    candidateReason: {
        type: DataTypes.TEXT,
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
    quantityLots: {
        type: DataTypes.INTEGER,
        allowNull: true,
    },
    lossPercent: {
        type: DataTypes.DOUBLE,
        allowNull: true,
    },
    currentStopPercent: {
        type: DataTypes.DOUBLE,
        allowNull: true,
    },
    candidateStopPercent: {
        type: DataTypes.DOUBLE,
        allowNull: true,
    },
    currentAverageDailyRangePercent: {
        type: DataTypes.DOUBLE,
        allowNull: true,
    },
    candidateAverageDailyRangePercent: {
        type: DataTypes.DOUBLE,
        allowNull: true,
    },
}, {
    tableName: 'exit_policy_observations',
    sequelize,
    timestamps: true,
    indexes: [
        {
            fields: ['observedAt']
        },
        {
            fields: ['accountId', 'instrumentUid', 'observedAt']
        },
        {
            fields: ['candidateStatus', 'observedAt']
        }
    ]
});

export default ExitPolicyObservationModel;
