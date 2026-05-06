import { Model, DataTypes } from 'sequelize';
import sequelize from '../config/database';

export type SocialSignalAction = 'buy' | 'sell' | 'hold' | 'watch';

export class SocialSignalModel extends Model {
    public id!: number;
    public source!: string;
    public actorKey!: string;
    public actorName!: string | null;
    public actorReturnPercent!: number | null;
    public ticker!: string;
    public name!: string | null;
    public figi!: string | null;
    public instrumentUid!: string | null;
    public action!: SocialSignalAction;
    public confidence!: number | null;
    public price!: number | null;
    public reason!: string | null;
    public sourceUrl!: string | null;
    public rawPayload!: object | null;
    public observedAt!: Date;
}

SocialSignalModel.init({
    id: {
        type: DataTypes.INTEGER,
        autoIncrement: true,
        primaryKey: true,
    },
    source: {
        type: DataTypes.STRING,
        allowNull: false,
    },
    actorKey: {
        type: DataTypes.STRING,
        allowNull: false,
    },
    actorName: {
        type: DataTypes.STRING,
        allowNull: true,
    },
    actorReturnPercent: {
        type: DataTypes.DOUBLE,
        allowNull: true,
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
        allowNull: true,
    },
    action: {
        type: DataTypes.STRING,
        allowNull: false,
    },
    confidence: {
        type: DataTypes.DOUBLE,
        allowNull: true,
    },
    price: {
        type: DataTypes.DOUBLE,
        allowNull: true,
    },
    reason: {
        type: DataTypes.TEXT,
        allowNull: true,
    },
    sourceUrl: {
        type: DataTypes.STRING,
        allowNull: true,
    },
    rawPayload: {
        type: DataTypes.JSONB,
        allowNull: true,
    },
    observedAt: {
        type: DataTypes.DATE,
        allowNull: false,
    },
}, {
    tableName: 'social_signals',
    sequelize,
    timestamps: true,
    indexes: [
        { fields: ['source', 'actorKey', 'ticker', 'action', 'observedAt'] },
        { fields: ['ticker', 'observedAt'] }
    ]
});

export default SocialSignalModel;
