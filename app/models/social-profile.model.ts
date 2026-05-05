import { Model, DataTypes } from 'sequelize';
import sequelize from '../config/database';

export type SocialProfileStatus = 'configured' | 'pending-auth' | 'ready' | 'below-threshold' | 'error';

export class SocialProfileModel extends Model {
    public id!: number;
    public source!: string;
    public profileKey!: string;
    public profileUid!: string | null;
    public profileUrl!: string;
    public displayName!: string | null;
    public confidence!: number | null;
    public activity!: number;
    public description!: string | null;
    public followersCount!: number | null;
    public followingCount!: number | null;
    public monthOperationsCount!: number | null;
    public portfolioLowerRub!: number | null;
    public portfolioUpperRub!: number | null;
    public autoConfidence!: number | null;
    public effectiveConfidence!: number | null;
    public recentSignalsCount!: number;
    public recentBuySignalsCount!: number;
    public recentSellSignalsCount!: number;
    public scoreReason!: string | null;
    public scoreUpdatedAt!: Date | null;
    public minReturnPercent!: number;
    public lastReturnPercent!: number | null;
    public status!: SocialProfileStatus;
    public lastCheckedAt!: Date | null;
    public lastError!: string | null;
    public rawPayload!: object | null;
}

SocialProfileModel.init({
    id: {
        type: DataTypes.INTEGER,
        autoIncrement: true,
        primaryKey: true,
    },
    source: {
        type: DataTypes.STRING,
        allowNull: false,
    },
    profileKey: {
        type: DataTypes.STRING,
        allowNull: false,
        unique: true,
    },
    profileUid: {
        type: DataTypes.STRING,
        allowNull: true,
    },
    profileUrl: {
        type: DataTypes.STRING,
        allowNull: false,
    },
    displayName: {
        type: DataTypes.STRING,
        allowNull: true,
    },
    confidence: {
        type: DataTypes.DOUBLE,
        allowNull: true,
    },
    activity: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 1,
    },
    description: {
        type: DataTypes.STRING,
        allowNull: true,
    },
    followersCount: {
        type: DataTypes.INTEGER,
        allowNull: true,
    },
    followingCount: {
        type: DataTypes.INTEGER,
        allowNull: true,
    },
    monthOperationsCount: {
        type: DataTypes.INTEGER,
        allowNull: true,
    },
    portfolioLowerRub: {
        type: DataTypes.DOUBLE,
        allowNull: true,
    },
    portfolioUpperRub: {
        type: DataTypes.DOUBLE,
        allowNull: true,
    },
    autoConfidence: {
        type: DataTypes.DOUBLE,
        allowNull: true,
    },
    effectiveConfidence: {
        type: DataTypes.DOUBLE,
        allowNull: true,
    },
    recentSignalsCount: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
    },
    recentBuySignalsCount: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
    },
    recentSellSignalsCount: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
    },
    scoreReason: {
        type: DataTypes.STRING,
        allowNull: true,
    },
    scoreUpdatedAt: {
        type: DataTypes.DATE,
        allowNull: true,
    },
    minReturnPercent: {
        type: DataTypes.DOUBLE,
        allowNull: false,
    },
    lastReturnPercent: {
        type: DataTypes.DOUBLE,
        allowNull: true,
    },
    status: {
        type: DataTypes.STRING,
        allowNull: false,
    },
    lastCheckedAt: {
        type: DataTypes.DATE,
        allowNull: true,
    },
    lastError: {
        type: DataTypes.STRING,
        allowNull: true,
    },
    rawPayload: {
        type: DataTypes.JSONB,
        allowNull: true,
    },
}, {
    tableName: 'social_profiles',
    sequelize,
    timestamps: true,
    indexes: [
        { fields: ['source', 'status'] },
        { fields: ['profileKey'] }
    ]
});

export default SocialProfileModel;
