import { DataTypes, Model } from 'sequelize';
import sequelize from '../config/database';

export class VirtualObservationTickModel extends Model {
    public sequence!: number;
    public experimentId!: string;
    public tickId!: string;
    public observedAt!: string;
    public payloadFingerprint!: string;
    public payloadJson!: string;
}

VirtualObservationTickModel.init({
    sequence: { type: DataTypes.BIGINT, autoIncrement: true, primaryKey: true },
    experimentId: { type: DataTypes.STRING, allowNull: false, field: 'experiment_id' },
    tickId: { type: DataTypes.STRING, allowNull: false, field: 'tick_id' },
    observedAt: { type: DataTypes.STRING, allowNull: false, field: 'observed_at' },
    payloadFingerprint: { type: DataTypes.STRING, allowNull: false, field: 'payload_fingerprint' },
    payloadJson: { type: DataTypes.TEXT, allowNull: false, field: 'payload_json' }
}, {
    tableName: 'virtual_observation_ticks', sequelize, timestamps: true,
    createdAt: 'created_at', updatedAt: 'updated_at',
    indexes: [
        { name: 'virtual_observation_tick_unique', unique: true, fields: ['experimentId', 'tickId'] },
        { name: 'virtual_observation_time_sequence', fields: ['experimentId', 'observedAt', 'sequence'] }
    ]
});

export default VirtualObservationTickModel;
