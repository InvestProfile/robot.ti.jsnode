import sequelize from './config/database';
import { getRobotConfig } from './config/robot.config';
import DatabaseService from './services/database.service';
import { startTradingProcess, TradingProcess } from './modules/common.module';
import { startReadOnlyHttpServer } from './http/readonly-server';
import { Server } from 'http';

let tradingProcess: TradingProcess | undefined;
let httpServer: Server | undefined;
let isShuttingDown = false;

const shutdown = async (signal: string) => {
    if (isShuttingDown) return;
    isShuttingDown = true;

    console.log(`Received ${signal}. Shutting down...`);

    try {
        tradingProcess?.stop();
        httpServer?.close();
        await sequelize.close();
        console.log('Shutdown complete.');
        process.exit(0);
    } catch (error) {
        console.error('Shutdown failed:', error);
        process.exit(1);
    }
};

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

const main = async () => {
    const config = getRobotConfig();

    await DatabaseService.init();
    httpServer = startReadOnlyHttpServer();
    tradingProcess = startTradingProcess(config);
};

void main().catch(error => {
    console.error('Fatal startup error:', error);
    process.exit(1);
});
