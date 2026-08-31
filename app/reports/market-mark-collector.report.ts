import { QueryTypes, type Sequelize } from 'sequelize';
import {
    runMarketMarkCollectorWorker,
    type MarketMarkCollectorWorkerController,
    type MarketMarkCollectorWorkerDependencies,
    type MarketMarkCollectorWorkerEnvironment
} from '../market-observation/market-mark-collector.worker';
import type {
    ManagedReadonlyMarketDataClient,
    MarketMarkCollectorRuntimeOptions
} from '../services/market-mark-collector-runtime.service';

const FIXED_TINVEST_READONLY_API = 'invest-public-api.tbank.ru:443';
const APP_NAME = 'robot.ti.market-mark-collector';

const REQUIRED_COLLECTOR_COLUMNS = Object.freeze([
    ['virtual_market_observation_leases', 'lease_name'],
    ['virtual_market_observation_leases', 'fencing_token'],
    ['virtual_market_marks', 'observation_id'],
    ['virtual_market_marks', 'collector_fence'],
    ['shadow_source_ticks', 'source_tick_id'],
    ['shadow_source_ticks', 'processed_at'],
    ['shadow_source_events', 'source_tick_id'],
    ['shadow_source_events', 'instrument_id'],
    ['virtual_shadow_scenario_states', 'state_json'],
    ['virtual_observation_experiments', 'config_version'],
    ['virtual_observation_experiments', 'benchmark_instrument_uid']
] as const);

export const verifyMarketMarkCollectorSchema = async (database: Sequelize): Promise<void> => {
    const rows = await database.query<{ table_name: string; column_name: string }>(
        `SELECT required.table_name, required.column_name
         FROM (VALUES
            ('virtual_market_observation_leases', 'lease_name'),
            ('virtual_market_observation_leases', 'fencing_token'),
            ('virtual_market_marks', 'observation_id'),
            ('virtual_market_marks', 'collector_fence'),
            ('shadow_source_ticks', 'source_tick_id'),
            ('shadow_source_ticks', 'processed_at'),
            ('shadow_source_events', 'source_tick_id'),
            ('shadow_source_events', 'instrument_id'),
            ('virtual_shadow_scenario_states', 'state_json'),
            ('virtual_observation_experiments', 'config_version'),
            ('virtual_observation_experiments', 'benchmark_instrument_uid')
         ) AS required(table_name, column_name)
         LEFT JOIN information_schema.columns actual
           ON actual.table_schema = current_schema()
          AND actual.table_name = required.table_name
          AND actual.column_name = required.column_name
         WHERE actual.column_name IS NULL
         ORDER BY required.table_name, required.column_name`,
        { type: QueryTypes.SELECT }
    );
    if (rows.length > 0) {
        const missing = rows.map(row => `${row.table_name}.${row.column_name}`).join(', ');
        throw new Error(`market mark collector schema is incomplete: ${missing}`);
    }
    if (REQUIRED_COLLECTOR_COLUMNS.length !== 11) throw new Error('collector schema contract is invalid');
};

interface EntrypointEnvironment extends MarketMarkCollectorWorkerEnvironment {
    readonly TINVEST_READONLY_TOKEN?: string;
}

interface SdkFacade {
    readonly marketData: {
        getTradingStatuses(request: { instrumentId: string[] }): Promise<unknown>;
        getOrderBook(request: { instrumentId: string; depth: number }): Promise<unknown>;
    };
    disconnect(): Promise<void>;
}

export interface MarketMarkCollectorCompositionModules {
    readonly createSdk: (
        token: string,
        appName: string,
        logger: undefined,
        options: { apiUrl: string }
    ) => SdkFacade;
    readonly createDatabase: () => Sequelize;
    readonly verifyMigrations: (database: Sequelize) => Promise<void>;
    readonly verifyCollectorSchema: (database: Sequelize) => Promise<void>;
    readonly prepareRuntime: (
        database: Sequelize,
        createClient: () => ManagedReadonlyMarketDataClient,
        options: MarketMarkCollectorRuntimeOptions
    ) => { collectOnce(): Promise<import('../market-observation/tinvest-market-mark-collector').MarketMarkCollectionResult>;
        close(): Promise<void> };
}

const exactSecret = (value: string | undefined): string => {
    if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
        throw new Error('enabled market mark collector requires canonical TINVEST_READONLY_TOKEN');
    }
    return value;
};

const closeAll = async (closers: readonly (() => Promise<void>)[]): Promise<void> => {
    const failures: unknown[] = [];
    for (const close of closers) {
        try { await close(); } catch (error) { failures.push(error); }
    }
    if (failures.length > 0) throw failures[0];
};

export const createManagedReadonlySdkClient = (
    createSdk: MarketMarkCollectorCompositionModules['createSdk'],
    token: string
): ManagedReadonlyMarketDataClient => {
    const sdk = createSdk(token, APP_NAME, undefined, { apiUrl: FIXED_TINVEST_READONLY_API });
    return Object.freeze({
        getTradingStatuses: (request: { instrumentId: string[] }) => sdk.marketData.getTradingStatuses(request) as never,
        getOrderBook: (request: { instrumentId: string; depth: number }) => sdk.marketData.getOrderBook(request) as never,
        close: () => sdk.disconnect()
    });
};

const loadDefaultModules = async (): Promise<MarketMarkCollectorCompositionModules> => {
    const [{ createSdk }, { createOutboxDatabase }, { verifyObservationMigrations },
        { prepareMarketMarkCollectorRuntime }] = await Promise.all([
        import('tinkoff-sdk-grpc-js'),
        import('../config/outbox-database'),
        import('../paper/observation-persistence'),
        import('../services/market-mark-collector-runtime.service')
    ]);
    return {
        createSdk: createSdk as never,
        createDatabase: createOutboxDatabase,
        verifyMigrations: verifyObservationMigrations,
        verifyCollectorSchema: verifyMarketMarkCollectorSchema,
        prepareRuntime: prepareMarketMarkCollectorRuntime
    };
};

export const loadMarketMarkCollectorDependencies = async (
    env: EntrypointEnvironment,
    loadModules: () => Promise<MarketMarkCollectorCompositionModules> = loadDefaultModules
): Promise<MarketMarkCollectorWorkerDependencies> => {
    const token = exactSecret(env.TINVEST_READONLY_TOKEN);
    const modules = await loadModules();
    return {
        prepare: async options => {
            const database = modules.createDatabase();
            let client: ManagedReadonlyMarketDataClient | undefined;
            try {
                await database.authenticate();
                await modules.verifyMigrations(database);
                await modules.verifyCollectorSchema(database);
                client = createManagedReadonlySdkClient(modules.createSdk, token);
                const runtime = modules.prepareRuntime(database, () => client as ManagedReadonlyMarketDataClient, options);
                let closePromise: Promise<void> | undefined;
                return {
                    collectOnce: () => runtime.collectOnce(),
                    close: () => {
                        closePromise ??= closeAll([() => runtime.close(), () => database.close()]);
                        return closePromise;
                    }
                };
            } catch (error) {
                try {
                    await closeAll([
                        ...(client ? [() => client!.close()] : []),
                        () => database.close()
                    ]);
                } catch {
                    console.error('Market mark collector setup cleanup failed; resources may remain open.');
                    process.exitCode = 1;
                }
                throw error;
            }
        }
    };
};

export const runMarketMarkCollectorEntrypoint = async (
    env: EntrypointEnvironment,
    dependencyLoader: () => Promise<MarketMarkCollectorWorkerDependencies> =
        () => loadMarketMarkCollectorDependencies(env)
): Promise<MarketMarkCollectorWorkerController | undefined> => {
    const controller = await runMarketMarkCollectorWorker(env, dependencyLoader);
    if (!controller) return undefined;
    const stop = () => { void controller.stop().catch(error => {
        console.error('Market mark collector shutdown failed:', error);
        process.exitCode = 1;
    }); };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    return controller;
};

if (require.main === module) {
    void runMarketMarkCollectorEntrypoint(process.env).catch(error => {
        console.error('Market mark collector failed:', error);
        process.exitCode = 1;
    });
}
