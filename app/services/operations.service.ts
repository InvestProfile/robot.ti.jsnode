
import { getEnv } from '../config/env.config';
import { createSdk } from 'tinkoff-sdk-grpc-js';

const envVariables = getEnv();

export default class OperationsService {
    static async getPortfolio(accountId: string) {
        if (envVariables.INVEST_TOKEN) {
            const {operations} = createSdk(envVariables.INVEST_TOKEN);
            return await operations.getPortfolio({accountId})
        }
    }
    static async getPositions(accountId: string) {
        if (envVariables.INVEST_TOKEN) {
            const {operations} = createSdk(envVariables.INVEST_TOKEN);
            return await operations.getPositions({accountId})
        }
    }
}
