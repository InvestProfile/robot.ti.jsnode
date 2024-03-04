
import { getEnv } from '../config/env.config';
import { createSdk } from 'tinkoff-sdk-grpc-js';

const envVariables = getEnv();

export default class InstrumentsService {
    static async getShares() {
        if (envVariables.INVEST_TOKEN) {
            const {instruments} = createSdk(envVariables.INVEST_TOKEN);
            return await instruments.shares({})
        }
    }
}
