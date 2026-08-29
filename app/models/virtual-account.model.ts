import { DataTypes, Model } from 'sequelize';
import sequelize from '../config/database';

export class VirtualAccountModel extends Model {
    public id!: number;
    public virtualAccountId!: string;
    public name!: string;
    public status!: 'active' | 'closed';
    public openedAt!: string;
}

VirtualAccountModel.init({
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    virtualAccountId: { type: DataTypes.STRING, allowNull: false, unique: true },
    name: { type: DataTypes.STRING, allowNull: false },
    status: { type: DataTypes.STRING, allowNull: false },
    openedAt: { type: DataTypes.STRING, allowNull: false }
}, { tableName: 'virtual_accounts', sequelize, timestamps: true });

export default VirtualAccountModel;
