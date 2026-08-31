import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    createManagedReadonlySdkClient,
    loadMarketMarkCollectorDependencies,
    runMarketMarkCollectorEntrypoint,
    verifyMarketMarkCollectorSchema,
    type MarketMarkCollectorCompositionModules
} from './market-mark-collector.report';

const options = {
    leaseName: 'qualified-marks', ownerId: 'worker-1', leaseTtlMs: 5_000,
    batchSize: 10, maxAttempts: 2, initialBackoffMs: 10, maxBackoffMs: 100
};

describe('market mark collector production composition', () => {
    it('wraps the SDK into an exact read-only surface at the fixed production endpoint', async () => {
        const calls: unknown[][] = [];
        let disconnected = 0;
        const client = createManagedReadonlySdkClient(((...args: unknown[]) => {
            calls.push(args);
            return {
                marketData: {
                    getTradingStatuses: async (request: { instrumentId: string[] }) => ({ tradingStatuses: [request] }),
                    getOrderBook: async (request: { instrumentId: string; depth: number }) => ({ instrumentUid: request.instrumentId })
                },
                disconnect: async () => { disconnected += 1; }
            };
        }) as never, 'readonly-test-token');
        assert.deepEqual(Object.keys(client).sort(), ['close', 'getOrderBook', 'getTradingStatuses']);
        assert.deepEqual(calls[0], ['readonly-test-token', 'robot.ti.market-mark-collector', undefined,
            { apiUrl: 'invest-public-api.tbank.ru:443' }]);
        await client.close();
        assert.equal(disconnected, 1);
    });

    it('requires only the dedicated token before loading modules and never falls back to INVEST_TOKEN', async () => {
        let loads = 0;
        await assert.rejects(loadMarketMarkCollectorDependencies(
            { TINVEST_READONLY_TOKEN: undefined } as never,
            async () => { loads += 1; return {} as never; }
        ), /TINVEST_READONLY_TOKEN/);
        assert.equal(loads, 0);
        await assert.rejects(loadMarketMarkCollectorDependencies(
            { TINVEST_READONLY_TOKEN: ' dedicated ' } as never,
            async () => { loads += 1; return {} as never; }
        ), /canonical/);
        assert.equal(loads, 0);
    });

    it('authenticates and verifies schema before constructing the SDK and closes both resources once', async () => {
        const order: string[] = [];
        const database = {
            authenticate: async () => { order.push('database-authenticate'); },
            close: async () => { order.push('database-close'); }
        };
        const modules: MarketMarkCollectorCompositionModules = {
            createDatabase: () => database as never,
            verifyMigrations: async () => { order.push('verify-migrations'); },
            verifyCollectorSchema: async () => { order.push('verify-collector-schema'); },
            createSdk: (() => {
                order.push('create-sdk');
                return {
                    marketData: { getTradingStatuses: async () => ({}), getOrderBook: async () => ({}) },
                    disconnect: async () => { order.push('sdk-close'); }
                };
            }) as never,
            prepareRuntime: (_database, createClient) => {
                const client = createClient();
                order.push('prepare-runtime');
                return {
                    collectOnce: async () => ({ acquired: true, requested: 0, received: 0,
                        inserted: 0, duplicates: 0, batches: 0 }),
                    close: () => client.close()
                };
            }
        };
        const dependencies = await loadMarketMarkCollectorDependencies(
            { TINVEST_READONLY_TOKEN: 'readonly-test-token' }, async () => modules);
        const prepared = await dependencies.prepare(options);
        assert.deepEqual(order, ['database-authenticate', 'verify-migrations', 'verify-collector-schema', 'create-sdk', 'prepare-runtime']);
        await prepared.close();
        await prepared.close();
        assert.deepEqual(order.slice(-2), ['sdk-close', 'database-close']);
        assert.equal(order.filter(item => item === 'sdk-close').length, 1);
        assert.equal(order.filter(item => item === 'database-close').length, 1);
    });

    it('closes the database when setup fails before SDK creation', async () => {
        let databaseCloses = 0;
        let sdkCreates = 0;
        const modules: MarketMarkCollectorCompositionModules = {
            createDatabase: () => ({
                authenticate: async () => undefined,
                close: async () => { databaseCloses += 1; }
            }) as never,
            verifyMigrations: async () => { throw new Error('schema missing'); },
            verifyCollectorSchema: async () => undefined,
            createSdk: (() => { sdkCreates += 1; throw new Error('must not create'); }) as never,
            prepareRuntime: (() => { throw new Error('must not prepare'); }) as never
        };
        const dependencies = await loadMarketMarkCollectorDependencies(
            { TINVEST_READONLY_TOKEN: 'readonly-test-token' }, async () => modules);
        await assert.rejects(dependencies.prepare(options), /schema missing/);
        assert.equal(databaseCloses, 1);
        assert.equal(sdkCreates, 0);
    });

    it('does not load dependencies when disabled', async () => {
        let loads = 0;
        const result = await runMarketMarkCollectorEntrypoint({}, async () => {
            loads += 1;
            throw new Error('must not load');
        });
        assert.equal(result, undefined);
        assert.equal(loads, 0);
    });

    it('fails closed when required collector tables or columns are physically missing', async () => {
        let sql = '';
        const database = {
            query: async (statement: string) => {
                sql = statement;
                return [{ table_name: 'virtual_market_marks', column_name: 'collector_fence' }];
            }
        };
        await assert.rejects(verifyMarketMarkCollectorSchema(database as never),
            /virtual_market_marks.collector_fence/);
        assert.match(sql, /information_schema.columns/);
        assert.match(sql, /shadow_source_events/);
    });

    it('preserves the primary setup failure and reports cleanup failure after SDK creation', async () => {
        const previousExitCode = process.exitCode;
        const originalError = console.error;
        const messages: string[] = [];
        console.error = (...args: unknown[]) => { messages.push(String(args[0])); };
        try {
            const modules: MarketMarkCollectorCompositionModules = {
                createDatabase: () => ({
                    authenticate: async () => undefined,
                    close: async () => { throw new Error('database close failed'); }
                }) as never,
                verifyMigrations: async () => undefined,
                verifyCollectorSchema: async () => undefined,
                createSdk: (() => ({
                    marketData: { getTradingStatuses: async () => ({}), getOrderBook: async () => ({}) },
                    disconnect: async () => { throw new Error('sdk close failed'); }
                })) as never,
                prepareRuntime: (() => { throw new Error('primary setup failure'); }) as never
            };
            const dependencies = await loadMarketMarkCollectorDependencies(
                { TINVEST_READONLY_TOKEN: 'readonly-test-token' }, async () => modules);
            await assert.rejects(dependencies.prepare(options), /primary setup failure/);
            assert.equal(process.exitCode, 1);
            assert.deepEqual(messages, [
                'Market mark collector setup cleanup failed; resources may remain open.'
            ]);
        } finally {
            console.error = originalError;
            process.exitCode = previousExitCode;
        }
    });
});
