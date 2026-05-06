import { createSdk } from 'tinkoff-sdk-grpc-js';
import { getEnv } from '../config/env.config';

let sdk: ReturnType<typeof createSdk> = null as any
const DEFAULT_INVEST_API_URL = 'invest-public-api.tinkoff.ru:443';
const envVariables = getEnv();

export const getSdk = (token: string) => {
        if (!sdk)
            sdk = createSdk(token, 'robot.ti.jsnode', undefined, {
                apiUrl: envVariables.INVEST_API_URL || DEFAULT_INVEST_API_URL
            });
        return sdk;
}
