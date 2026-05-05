import { Model, DataTypes } from 'sequelize';
import sequelize from '../config/database';

export class PortfolioSnapshotModel extends Model {
    public id!: number;
    public accountId!: string;
    public accountAlias!: string;
    public accountMode!: string;
    public cashRub!: number;
    public totalRub!: number;
    public positionsCount!: number;
}

PortfolioSnapshotModel.init({
    id: {
        type: DataTypes.INTEGER,
        autoIncrement: true,
        primaryKey: true,
    },
    accountId: {
        type: DataTypes.STRING,
        allowNull: false,
    },
    accountAlias: {
        type: DataTypes.STRING,
        allowNull: true,
    },
    accountMode: {
        type: DataTypes.STRING,
        allowNull: false,
    },
    cashRub: {
        type: DataTypes.DOUBLE,
        allowNull: true,
    },
    totalRub: {
        type: DataTypes.DOUBLE,
        allowNull: true,
    },
    positionsCount: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
    },
}, {
    tableName: 'portfolio_snapshots',
    sequelize,
    timestamps: true,
    indexes: [
        {
            fields: ['accountId', 'createdAt']
        }
    ]
});

export default PortfolioSnapshotModel;
