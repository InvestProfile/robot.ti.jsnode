import { DataTypes, Model } from 'sequelize';
import sequelize from '../config/database';

export class ShadowDecisionObservationModel extends Model {
    public sequence!: number;
    public virtualAccountId!: string;
    public decisionId!: string;
    public payloadFingerprint!: string;
    public instrumentId!: string;
    public evaluatedAt!: string;
    public action!: string;
    public status!: string;
    public source!: string | null;
    public reason!: string;
    public orderId!: string | null;
}

ShadowDecisionObservationModel.init({
    sequence: { type: DataTypes.BIGINT, autoIncrement: true, primaryKey: true },
    virtualAccountId: { type: DataTypes.STRING, allowNull: false },
    decisionId: { type: DataTypes.STRING, allowNull: false },
    payloadFingerprint: { type: DataTypes.TEXT, allowNull: false },
    instrumentId: { type: DataTypes.STRING, allowNull: false },
    evaluatedAt: { type: DataTypes.STRING, allowNull: false },
    action: { type: DataTypes.STRING, allowNull: false },
    status: { type: DataTypes.STRING, allowNull: false },
    source: { type: DataTypes.STRING, allowNull: true },
    reason: { type: DataTypes.TEXT, allowNull: false },
    orderId: { type: DataTypes.STRING, allowNull: true }
}, {
    tableName: 'shadow_decision_observations', sequelize, timestamps: true,
    indexes: [
        {
            name: 'shadow_observations_account_decision_unique', unique: true,
            fields: ['virtualAccountId', 'decisionId']
        },
        { name: 'shadow_observations_account_sequence', fields: ['virtualAccountId', 'sequence'] }
    ]
});

export default ShadowDecisionObservationModel;
