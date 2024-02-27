// trades.ts
import { Model, DataTypes } from 'sequelize';
import sequelize from '../config/database';

// Определяем модель 'Trades'
export class TradesModel extends Model {
    public id!: number;
    public figi!: string;
    public ticker!: string;
    public classCode!: string;
    public name!: string;
    public quantity!: string;
    public lot!: string;
    public price_currency!: string;
    public price_units!: string;
    public price_nano!: string;
    public direction!: string;
    public accountId!: string;
    public orderType!: string;
    public orderId!: string;
    public tradeDateTime!: string;
    public instrumentId!: string;
    public uid!: string;
    public positionUid!: string;
    public status!: string;
    // и так далее
}

TradesModel.init({
    id: {
        type: DataTypes.INTEGER,
        autoIncrement: true,
        primaryKey: true,
    },
    figi: {
        type: DataTypes.STRING,
        allowNull: true,
    },
    ticker: {
        type: DataTypes.STRING,
        allowNull: true,
    },
    classCode: {
        type: DataTypes.STRING,
        allowNull: true,
    },
    name: {
        type: DataTypes.STRING,
        allowNull: true,
    },
    quantity: {
        type: DataTypes.STRING,
        allowNull: true,
    },
    lot: {
        type: DataTypes.STRING,
        allowNull: true,
    },
    price_currency: {
        type: DataTypes.STRING,
        allowNull: true,
    },
    price_units: {
        type: DataTypes.STRING,
        allowNull: true,
    },
    price_nano: {
        type: DataTypes.STRING,
        allowNull: true,
    },
    direction: {
        type: DataTypes.STRING,
        allowNull: true,
    },
    accountId: {
        type: DataTypes.STRING,
        allowNull: true,
    },
    orderType: {
        type: DataTypes.STRING,
        allowNull: true,
    },
    orderId: {
        type: DataTypes.STRING,
        allowNull: true,
    },
    tradeDateTime:{
        type: DataTypes.STRING,
        allowNull: true,
    },
    instrumentId: {
        type: DataTypes.STRING,
        allowNull: true,
    },
    uid: {
        type: DataTypes.STRING,
        allowNull: true,
    },
    positionUid: {
        type: DataTypes.STRING,
        allowNull: true,
    },
    status: {
        type: DataTypes.BOOLEAN,
        allowNull: true,
    }
    // и так далее
}, {
    tableName: 'trades',
    sequelize, // передаем экземпляр sequelize
    timestamps: true, // включите или отключите временные метки в зависимости от вашего проекта
});

export default TradesModel;
