
import { getEnv } from '../config/env.config';
import { createSdk } from 'tinkoff-sdk-grpc-js';

const envVariables = getEnv();

export default class MarketDataService {
    static async getStatus(
        figi: string,
        instrumentId: string
    ) {
        if (envVariables.INVEST_TOKEN) {
            const {marketData} = createSdk(envVariables.INVEST_TOKEN);
            return await marketData.getTradingStatus({
                figi,
                instrumentId
            })
        }
    }
}
