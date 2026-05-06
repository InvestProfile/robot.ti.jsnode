import { DataTypes, Model } from 'sequelize';
import sequelize from '../config/database';

export type RuntimeAccountMode = 'trade' | 'observe';

export class RuntimeAccountModeModel extends Model {
    public id!: number;
    public accountId!: string;
    public mode!: RuntimeAccountMode;
    public updatedBy!: string;
    public reason!: string;
    public updatedAt!: Date;
}

RuntimeAccountModeModel.init({
    id: {
        type: DataTypes.INTEGER,
        autoIncrement: true,
        primaryKey: true,
    },
    accountId: {
        type: DataTypes.STRING,
        allowNull: false,
        unique: true,
    },
    mode: {
        type: DataTypes.STRING,
        allowNull: false,
    },
    updatedBy: {
        type: DataTypes.STRING,
        allowNull: true,
    },
    reason: {
        type: DataTypes.TEXT,
        allowNull: true,
    },
}, {
    tableName: 'runtime_account_modes',
    sequelize,
    timestamps: true,
});

export default RuntimeAccountModeModel;
