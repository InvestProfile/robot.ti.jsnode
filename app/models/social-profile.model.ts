import { Model, DataTypes } from 'sequelize';
import sequelize from '../config/database';

export type SocialProfileStatus = 'configured' | 'pending-auth' | 'ready' | 'below-threshold' | 'error';

export class SocialProfileModel extends Model {
    public id!: number;
    public source!: string;
    public profileKey!: string;
    public profileUrl!: string;
    public displayName!: string | null;
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
    profileUrl: {
        type: DataTypes.STRING,
        allowNull: false,
    },
    displayName: {
        type: DataTypes.STRING,
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
