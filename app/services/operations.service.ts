
import { getEnv } from '../config/env.config';
import { getSdk } from './get-sdk';

const envVariables = getEnv();

export default class OperationsService {
    static async getPortfolio(accountId: string) {
        if (envVariables.INVEST_TOKEN) {
            const {operations} = getSdk(envVariables.INVEST_TOKEN);
            return await operations.getPortfolio({accountId})
        }
    }
    static async getPositions(accountId: string) {
        if (envVariables.INVEST_TOKEN) {
            const {operations} = getSdk(envVariables.INVEST_TOKEN);
            return await operations.getPositions({accountId})
        }
    }
}
