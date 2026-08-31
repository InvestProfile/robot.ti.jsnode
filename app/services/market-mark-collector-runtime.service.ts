import { randomUUID } from 'node:crypto';
import type { Sequelize } from 'sequelize';
import { TInvestMarketMarkCollector, type MarketMarkCollectionResult } from '../market-observation/tinvest-market-mark-collector';
import type { CollectorClock } from '../market-observation/tinvest-readonly-market-data.port';
import { PostgresMarketObservationRepository } from '../market-observation/postgres-market-observation.repository';
import { SequelizeMarketMarkUniverseRepository } from './sequelize-market-mark-universe.repository';
import {
    TInvestReadonlyMarketDataAdapter,
    type TInvestReadonlyMarketDataClient
} from './tinvest-readonly-market-data.adapter';

export interface MarketMarkCollectorRuntimeOptions {
    readonly ownerId?: string;
    readonly leaseName: string;
    readonly leaseTtlMs: number;
    readonly batchSize: number;
    readonly maxAttempts: number;
    readonly initialBackoffMs: number;
    readonly maxBackoffMs: number;
}

export interface MarketMarkCollectorRuntime {
    collectOnce(): Promise<MarketMarkCollectionResult>;
    close(): Promise<void>;
}

export interface ManagedReadonlyMarketDataClient extends TInvestReadonlyMarketDataClient {
    close(): Promise<void>;
}

export type ReadonlyMarketDataClientFactory = () => ManagedReadonlyMarketDataClient;

const systemClock: CollectorClock = Object.freeze({
    now: () => new Date(),
    sleep: (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
});

const required = (value: string, field: string): string => {
    const normalized = value.trim();
    if (!normalized) throw new Error(`${field} is required`);
    return normalized;
};

export const prepareMarketMarkCollectorRuntime = (
    database: Sequelize,
    createReadonlyClient: ReadonlyMarketDataClientFactory,
    options: MarketMarkCollectorRuntimeOptions,
    clock: CollectorClock = systemClock
): MarketMarkCollectorRuntime => {
    const leaseName = required(options.leaseName, 'leaseName');
    const ownerId = required(options.ownerId ?? `market-mark-collector:${randomUUID()}`, 'ownerId');
    // The factory is deliberately structural and returns only the two read-only market-data methods.
    const client = createReadonlyClient();
    const marketData = new TInvestReadonlyMarketDataAdapter(client);
    const persistence = new PostgresMarketObservationRepository(database, leaseName);
    const collector = new TInvestMarketMarkCollector(
        marketData,
        persistence,
        new SequelizeMarketMarkUniverseRepository(database),
        persistence,
        clock,
        {
            ownerId,
            leaseTtlMs: options.leaseTtlMs,
            batchSize: options.batchSize,
            maxAttempts: options.maxAttempts,
            initialBackoffMs: options.initialBackoffMs,
            maxBackoffMs: options.maxBackoffMs
        }
    );
    let closePromise: Promise<void> | undefined;
    return Object.freeze({
        collectOnce: () => collector.collectOnce(),
        close: () => {
            closePromise ??= Promise.resolve().then(() => client.close());
            return closePromise;
        }
    });
};
