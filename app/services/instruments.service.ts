
import { getEnv } from '../config/env.config';
// import { createSdk } from 'tinkoff-sdk-grpc-js';
import {getSdk} from './get-sdk';
import TInvestApiCacheService from './tinvest-api-cache.service';
import { InstrumentIdType } from 'tinkoff-sdk-grpc-js/dist/generated/instruments';

const envVariables = getEnv();

export default class InstrumentsService {
    static async getShares() {
        if (envVariables.INVEST_TOKEN) {
            const {instruments} = getSdk(envVariables.INVEST_TOKEN);
            return await TInvestApiCacheService.cached(
                'instruments:shares',
                60 * 60 * 1000,
                () => instruments.shares({})
            );
        }
    }

    static async getConsensusForecasts(limit = 100, pageNumber = 0) {
        if (envVariables.INVEST_TOKEN) {
            const {instruments} = getSdk(envVariables.INVEST_TOKEN);
            return await TInvestApiCacheService.cached(
                `instruments:consensus:${limit}:${pageNumber}`,
                6 * 60 * 60 * 1000,
                () => instruments.getConsensusForecasts({
                    paging: {
                        limit,
                        pageNumber
                    }
                })
            );
        }
    }

    static async getForecastBy(instrumentId: string) {
        if (envVariables.INVEST_TOKEN) {
            const {instruments} = getSdk(envVariables.INVEST_TOKEN);
            return await TInvestApiCacheService.cached(
                `instruments:forecast:${instrumentId}`,
                6 * 60 * 60 * 1000,
                () => instruments.getForecastBy({ instrumentId })
            );
        }
    }

    static async getInstrumentByUid(instrumentUid: string) {
        if (envVariables.INVEST_TOKEN && instrumentUid) {
            const {instruments} = getSdk(envVariables.INVEST_TOKEN);
            return await TInvestApiCacheService.cached(
                `instruments:by-uid:${instrumentUid}`,
                6 * 60 * 60 * 1000,
                () => instruments.getInstrumentBy({
                    idType: InstrumentIdType.INSTRUMENT_ID_TYPE_UID,
                    id: instrumentUid
                })
            );
        }
    }

    static async getInstrumentByFigi(figi: string) {
        if (envVariables.INVEST_TOKEN && figi) {
            const {instruments} = getSdk(envVariables.INVEST_TOKEN);
            return await TInvestApiCacheService.cached(
                `instruments:by-figi:${figi}`,
                6 * 60 * 60 * 1000,
                () => instruments.getInstrumentBy({
                    idType: InstrumentIdType.INSTRUMENT_ID_TYPE_FIGI,
                    id: figi
                })
            );
        }
    }
}
