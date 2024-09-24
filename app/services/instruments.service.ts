
import { getEnv } from '../config/env.config';
// import { createSdk } from 'tinkoff-sdk-grpc-js';
import {getSdk} from './get-sdk';

const envVariables = getEnv();

export default class InstrumentsService {
    static async getShares() {
        if (envVariables.INVEST_TOKEN) {
            const {instruments} = getSdk(envVariables.INVEST_TOKEN);
            return await instruments.shares({})
        }
    }
}
