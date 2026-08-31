import type { MarketMarkCollectionResult } from './tinvest-market-mark-collector';
import type { MarketMarkCollectorRuntimeOptions } from '../services/market-mark-collector-runtime.service';

export interface MarketMarkCollectorWorkerEnvironment {
    readonly ROBOT_MARK_COLLECTOR_ENABLED?: string;
    readonly ROBOT_MARK_COLLECTOR_INTERVAL_MS?: string;
    readonly ROBOT_MARK_COLLECTOR_LEASE_NAME?: string;
    readonly ROBOT_MARK_COLLECTOR_OWNER_ID?: string;
    readonly ROBOT_MARK_COLLECTOR_LEASE_TTL_MS?: string;
    readonly ROBOT_MARK_COLLECTOR_BATCH_SIZE?: string;
    readonly ROBOT_MARK_COLLECTOR_MAX_ATTEMPTS?: string;
    readonly ROBOT_MARK_COLLECTOR_INITIAL_BACKOFF_MS?: string;
    readonly ROBOT_MARK_COLLECTOR_MAX_BACKOFF_MS?: string;
}

export interface PreparedMarketMarkCollectorWorker {
    readonly collectOnce: () => Promise<MarketMarkCollectionResult>;
    readonly close: () => Promise<void>;
}

export interface MarketMarkCollectorWorkerDependencies {
    readonly prepare: (options: MarketMarkCollectorRuntimeOptions) => Promise<PreparedMarketMarkCollectorWorker>;
}

export interface MarketMarkCollectorWorkerController {
    readonly stop: () => Promise<void>;
}

const enabled = (value: string | undefined): boolean =>
    ['1', 'true', 'yes', 'on'].includes(String(value ?? '').trim().toLowerCase());

const integer = (name: string, raw: string | undefined, fallback: number, minimum: number, maximum: number): number => {
    const value = raw === undefined ? fallback : Number(raw);
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
        throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
    }
    return value;
};

const required = (name: string, value: string | undefined): string => {
    const normalized = String(value ?? '').trim();
    if (!normalized) throw new Error(`${name} is required when market mark collector is enabled`);
    return normalized;
};

export const runMarketMarkCollectorWorker = async (
    env: MarketMarkCollectorWorkerEnvironment,
    loadDependencies: () => Promise<MarketMarkCollectorWorkerDependencies>
): Promise<MarketMarkCollectorWorkerController | undefined> => {
    if (!enabled(env.ROBOT_MARK_COLLECTOR_ENABLED)) return undefined;

    const intervalMs = integer('ROBOT_MARK_COLLECTOR_INTERVAL_MS', env.ROBOT_MARK_COLLECTOR_INTERVAL_MS,
        60_000, 1_000, 24 * 60 * 60 * 1_000);
    const leaseTtlMs = integer('ROBOT_MARK_COLLECTOR_LEASE_TTL_MS', env.ROBOT_MARK_COLLECTOR_LEASE_TTL_MS,
        Math.max(5_000, intervalMs * 2), 2_000, 24 * 60 * 60 * 1_000);
    if (leaseTtlMs <= intervalMs) throw new Error('ROBOT_MARK_COLLECTOR_LEASE_TTL_MS must exceed the collection interval');
    const batchSize = integer('ROBOT_MARK_COLLECTOR_BATCH_SIZE', env.ROBOT_MARK_COLLECTOR_BATCH_SIZE, 50, 1, 100);
    const maxAttempts = integer('ROBOT_MARK_COLLECTOR_MAX_ATTEMPTS', env.ROBOT_MARK_COLLECTOR_MAX_ATTEMPTS, 3, 1, 10);
    const initialBackoffMs = integer('ROBOT_MARK_COLLECTOR_INITIAL_BACKOFF_MS',
        env.ROBOT_MARK_COLLECTOR_INITIAL_BACKOFF_MS, 100, 1, 10_000);
    const maxBackoffMs = integer('ROBOT_MARK_COLLECTOR_MAX_BACKOFF_MS',
        env.ROBOT_MARK_COLLECTOR_MAX_BACKOFF_MS, 2_000, 1, 60_000);
    if (initialBackoffMs > maxBackoffMs) {
        throw new Error('ROBOT_MARK_COLLECTOR_INITIAL_BACKOFF_MS cannot exceed ROBOT_MARK_COLLECTOR_MAX_BACKOFF_MS');
    }
    const options: MarketMarkCollectorRuntimeOptions = Object.freeze({
        leaseName: required('ROBOT_MARK_COLLECTOR_LEASE_NAME', env.ROBOT_MARK_COLLECTOR_LEASE_NAME),
        ...(env.ROBOT_MARK_COLLECTOR_OWNER_ID?.trim() ? { ownerId: env.ROBOT_MARK_COLLECTOR_OWNER_ID.trim() } : {}),
        leaseTtlMs, batchSize, maxAttempts, initialBackoffMs, maxBackoffMs
    });

    const dependencies = await loadDependencies();
    const prepared = await dependencies.prepare(options);
    let stopping = false;
    let inFlight: Promise<void> | undefined;
    let closePromise: Promise<void> | undefined;
    const timer = setInterval(() => collect(), intervalMs);
    const closePrepared = (): Promise<void> => {
        closePromise ??= Promise.resolve().then(() => prepared.close());
        return closePromise;
    };

    const failClosed = (message: string, error: unknown): void => {
        process.exitCode = 1;
        stopping = true;
        clearInterval(timer);
        console.error(message, error);
    };

    const closeAfterFailure = (): void => {
        void closePrepared().catch(error => {
            failClosed('Market mark collector cleanup failed:', error);
        });
    };

    const collect = (): void => {
        if (stopping || inFlight) return;
        inFlight = Promise.resolve()
            .then(() => prepared.collectOnce())
            .then(() => undefined)
            .catch(error => {
                failClosed('Market mark collector stopped:', error);
            })
            .finally(() => {
                inFlight = undefined;
                if (stopping) closeAfterFailure();
            });
    };
    collect();

    const stop = async (): Promise<void> => {
        if (!stopping) stopping = true;
        clearInterval(timer);
        await inFlight;
        try {
            await closePrepared();
        } catch (error) {
            failClosed('Market mark collector cleanup failed:', error);
            throw error;
        }
    };
    return Object.freeze({ stop });
};
