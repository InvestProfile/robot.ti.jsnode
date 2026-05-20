
import { getEnv } from '../config/env.config';
// import { createSdk } from 'tinkoff-sdk-grpc-js';
import {getSdk} from './get-sdk';
import TInvestApiCacheService from './tinvest-api-cache.service';

const envVariables = getEnv();
const delay = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds));
const BROKER_REPORT_CACHE_TTL_MS = 15 * 60 * 1000;
const BROKER_REPORT_TIMEOUT_MS = 5 * 1000;

const withTimeout = async <T>(promise: Promise<T>, milliseconds: number, label: string) => {
    let timeout: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`${label} timed out after ${milliseconds}ms`)), milliseconds);
    });

    try {
        return await Promise.race([promise, timeoutPromise]);
    } finally {
        if (timeout) clearTimeout(timeout);
    }
};

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

    static async getBrokerReportRows(accountId: string, from: Date, to: Date) {
        const token = envVariables.INVEST_TOKEN;
        if (!token) return [];

        const cacheKey = [
            'broker-report',
            accountId,
            from.toISOString(),
            to.toISOString()
        ].join(':');

        return await TInvestApiCacheService.cached(cacheKey, BROKER_REPORT_CACHE_TTL_MS, async () => {
            return await withTimeout(
                this.fetchBrokerReportRows(token, accountId, from, to),
                BROKER_REPORT_TIMEOUT_MS,
                'broker report'
            );
        });
    }

    private static async fetchBrokerReportRows(token: string, accountId: string, from: Date, to: Date) {
        const {operations} = getSdk(token);
        const generated = await TInvestApiCacheService.withRetry(() => operations.getBrokerReport({
            generateBrokerReportRequest: {
                accountId,
                from,
                to
            },
            getBrokerReportRequest: undefined
        }));
        const taskId = generated.generateBrokerReportResponse?.taskId;
        if (!taskId) return [];

        const rows: unknown[] = [];
        let page = 0;
        let pagesCount = 1;

        for (let attempt = 0; attempt < 4 && page < pagesCount; attempt += 1) {
            const response = await TInvestApiCacheService.withRetry(() => operations.getBrokerReport({
                generateBrokerReportRequest: undefined,
                getBrokerReportRequest: {
                    taskId,
                    page
                }
            }));
            const report = response.getBrokerReportResponse;

            if (!report) {
                await delay(500);
                continue;
            }

            rows.push(...report.brokerReport);
            pagesCount = Math.max(1, Number(report.pagesCount || 1));
            page += 1;
        }

        return rows;
    }
}
