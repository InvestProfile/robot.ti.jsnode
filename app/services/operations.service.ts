
import { getEnv } from '../config/env.config';
// import { createSdk } from 'tinkoff-sdk-grpc-js';
import {getSdk} from './get-sdk';
import TInvestApiCacheService from './tinvest-api-cache.service';
import { OperationItem, OperationState, OperationType } from 'tinkoff-sdk-grpc-js/dist/generated/operations';

const envVariables = getEnv();
const delay = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds));
const BROKER_REPORT_CACHE_TTL_MS = 15 * 60 * 1000;
const BROKER_REPORT_TIMEOUT_MS = 90 * 1000;
const OPERATIONS_CURSOR_CACHE_TTL_MS = 2 * 60 * 1000;
const OPERATIONS_CURSOR_TIMEOUT_MS = 60 * 1000;

export interface OperationsCursorOptions {
    instrumentId?: string;
    figi?: string;
    operationTypes?: OperationType[];
    state?: OperationState;
    limit?: number;
    withoutCommissions?: boolean;
    withoutTrades?: boolean;
    withoutOvernights?: boolean;
    fallbackToBrokerReport?: boolean;
}

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

const isBrokerReportPending = (error: unknown) => {
    const text = String(error instanceof Error ? error.message : error ?? '').toLowerCase();
    const details = String((error as { details?: unknown })?.details ?? '');

    return details === '30058'
        || text.includes('task not completed')
        || (text.includes('задач') && text.includes('не заверш'));
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

    static async getOperationsByCursorItems(accountId: string, from: Date, to: Date, options: OperationsCursorOptions = {}) {
        const token = envVariables.INVEST_TOKEN;
        if (!token) return [];

        const operationTypes = options.operationTypes ?? [];
        const cacheKey = [
            'operations-cursor',
            accountId,
            options.instrumentId ?? 'all',
            operationTypes.join(',') || 'all',
            options.state ?? 'any',
            from.toISOString(),
            to.toISOString(),
            options.limit ?? 1000,
            options.withoutCommissions ? 'no-commissions' : 'with-commissions',
            options.withoutTrades ? 'no-trades' : 'with-trades'
        ].join(':');

        return await TInvestApiCacheService.cached(cacheKey, OPERATIONS_CURSOR_CACHE_TTL_MS, async () => {
            const {operations} = getSdk(token);
            const items: OperationItem[] = [];
            let cursor = '';

            try {
                do {
                    const response = await withTimeout(
                        TInvestApiCacheService.withRetry(() => operations.getOperationsByCursor({
                            accountId,
                            instrumentId: options.instrumentId,
                            from,
                            to,
                            cursor,
                            limit: Math.min(Math.max(options.limit ?? 1000, 1), 1000),
                            operationTypes,
                            state: options.state,
                            withoutCommissions: options.withoutCommissions,
                            withoutTrades: options.withoutTrades,
                            withoutOvernights: options.withoutOvernights
                        })),
                        OPERATIONS_CURSOR_TIMEOUT_MS,
                        'operations cursor'
                    );

                    items.push(...(response.items ?? []));
                    cursor = response.hasNext ? response.nextCursor : '';
                } while (cursor);
            } catch (error) {
                if (!options.figi || !options.fallbackToBrokerReport) throw error;

                const response = await withTimeout(
                    TInvestApiCacheService.withRetry(() => operations.getOperations({
                        accountId,
                        from,
                        to,
                        state: options.state,
                        figi: options.figi
                    })),
                    OPERATIONS_CURSOR_TIMEOUT_MS,
                    'operations fallback'
                );
                const allowedTypes = new Set(operationTypes);
                items.push(...(response.operations ?? [])
                    .filter(operation => allowedTypes.size === 0 || allowedTypes.has(operation.operationType))
                    .map(operation => ({
                        cursor: '',
                        brokerAccountId: accountId,
                        id: operation.id,
                        parentOperationId: operation.parentOperationId,
                        name: '',
                        date: operation.date,
                        type: operation.operationType,
                        description: operation.type,
                        state: operation.state,
                        instrumentUid: operation.instrumentUid,
                        figi: operation.figi,
                        instrumentType: operation.instrumentType,
                        instrumentKind: 0,
                        positionUid: operation.positionUid,
                        ticker: '',
                        classCode: '',
                        payment: operation.payment,
                        price: operation.price,
                        commission: undefined,
                        yield: undefined,
                        yieldRelative: undefined,
                        accruedInt: undefined,
                        quantity: operation.quantity,
                        quantityRest: operation.quantityRest,
                        quantityDone: Math.max(0, operation.quantity - operation.quantityRest),
                        cancelDateTime: undefined,
                        cancelReason: '',
                        tradesInfo: { trades: operation.trades.map(trade => ({
                            num: trade.tradeId,
                            date: trade.dateTime,
                            quantity: trade.quantity,
                            price: trade.price,
                            yield: undefined,
                            yieldRelative: undefined
                        })) },
                        assetUid: operation.assetUid,
                        childOperations: operation.childOperations
                    })));
            }

            return items;
        });
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

        for (let attempt = 0; attempt < 20 && page < pagesCount; attempt += 1) {
            let response;
            try {
                response = await TInvestApiCacheService.withRetry(() => operations.getBrokerReport({
                    generateBrokerReportRequest: undefined,
                    getBrokerReportRequest: {
                        taskId,
                        page
                    }
                }));
            } catch (error) {
                if (!isBrokerReportPending(error)) throw error;
                await delay(3_000);
                continue;
            }
            const report = response.getBrokerReportResponse;

            if (!report) {
                await delay(3_000);
                continue;
            }

            rows.push(...report.brokerReport);
            pagesCount = Math.max(1, Number(report.pagesCount || 1));
            page += 1;
        }

        return rows;
    }
}
