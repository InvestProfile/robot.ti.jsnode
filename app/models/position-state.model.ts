import { Model, DataTypes } from 'sequelize';
import sequelize from '../config/database';

export class PositionStateModel extends Model {
    public id!: number;
    public accountId!: string;
    public figi!: string;
    public instrumentUid!: string;
    public highestPrice!: number;
    public lastPrice!: number;
}

PositionStateModel.init({
    id: {
        type: DataTypes.INTEGER,
        autoIncrement: true,
        primaryKey: true,
    },
    accountId: {
        type: DataTypes.STRING,
        allowNull: false,
    },
    figi: {
        type: DataTypes.STRING,
        allowNull: true,
    },
    instrumentUid: {
        type: DataTypes.STRING,
        allowNull: false,
    },
    highestPrice: {
        type: DataTypes.DOUBLE,
        allowNull: false,
    },
    lastPrice: {
        type: DataTypes.DOUBLE,
        allowNull: false,
    },
}, {
    tableName: 'position_states',
    sequelize,
    timestamps: true,
    indexes: [
        {
            unique: true,
            fields: ['accountId', 'instrumentUid']
        }
    ]
});

export default PositionStateModel;
