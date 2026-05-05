import { RobotConfig } from '../config/robot.config';
import ScanUniverseService from './scan-universe.service';

export default class ScanTargetsService {
    static async resolve(config: RobotConfig, explicitTickers?: string[]) {
        const tickers = explicitTickers
            ?.map(ticker => ticker.trim().toUpperCase())
            .filter(Boolean) ?? [];

        if (tickers.length > 0) {
            return {
                mode: 'explicit' as const,
                tickers
            };
        }

        const universe = await ScanUniverseService.resolveTickers(config);

        return {
            mode: universe.mode,
            tickers: universe.tickers
        };
    }
}
