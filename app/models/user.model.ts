// user.ts
import { Model, DataTypes } from 'sequelize';
import sequelize from '../config/database';

// Определяем модель 'User'
export class UserModel extends Model {
    public id!: number;
    public name!: string;
    public email!: string;
    // и так далее
}

UserModel.init({
    id: {
        type: DataTypes.INTEGER,
        autoIncrement: true,
        primaryKey: true,
    },
    name: {
        type: new DataTypes.STRING(128),
        allowNull: false,
    },
    email: {
        type: new DataTypes.STRING(128),
        allowNull: false,
    },
    // и так далее
}, {
    tableName: 'users',
    sequelize, // передаем экземпляр sequelize
    timestamps: false, // включите или отключите временные метки в зависимости от вашего проекта
});

export default UserModel;
