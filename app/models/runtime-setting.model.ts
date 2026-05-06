import { DataTypes, Model } from 'sequelize';
import sequelize from '../config/database';

export class RuntimeSettingModel extends Model {
    public id!: number;
    public key!: string;
    public value!: string;
    public updatedBy!: string;
    public updatedAt!: Date;
}

RuntimeSettingModel.init({
    id: {
        type: DataTypes.INTEGER,
        autoIncrement: true,
        primaryKey: true,
    },
    key: {
        type: DataTypes.STRING,
        allowNull: false,
        unique: true,
    },
    value: {
        type: DataTypes.TEXT,
        allowNull: false,
    },
    updatedBy: {
        type: DataTypes.STRING,
        allowNull: true,
    },
}, {
    tableName: 'runtime_settings',
    sequelize,
    timestamps: true,
});

export default RuntimeSettingModel;
