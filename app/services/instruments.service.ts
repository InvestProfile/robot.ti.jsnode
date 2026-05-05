
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

    static async getConsensusForecasts(limit = 100, pageNumber = 0) {
        if (envVariables.INVEST_TOKEN) {
            const {instruments} = getSdk(envVariables.INVEST_TOKEN);
            return await instruments.getConsensusForecasts({
                paging: {
                    limit,
                    pageNumber
                }
            });
        }
    }

    static async getForecastBy(instrumentId: string) {
        if (envVariables.INVEST_TOKEN) {
            const {instruments} = getSdk(envVariables.INVEST_TOKEN);
            return await instruments.getForecastBy({ instrumentId });
        }
    }
}
