import { startVirtualObservationScheduler, VirtualObservationRuntime } from './shadow-composition';
import type { ObservationLease } from './observation-persistence';
import type { ObservationExperimentSettings } from './observation-persistence';

interface PreparedWorkerRuntime {
    readonly runtime: VirtualObservationRuntime;
    readonly lease: ObservationLease;
}

interface WorkerDependencies {
    readonly authenticate: () => Promise<void>;
    readonly close: () => Promise<void>;
    readonly prepareRuntime: (experimentId: string, leaseTtlMs: number, settings: ObservationExperimentSettings, maxBatchSize: number) => Promise<PreparedWorkerRuntime>;
}

interface WorkerEnvironment {
    readonly ROBOT_VIRTUAL_OBSERVATION_ENABLED?: string;
    readonly ROBOT_VIRTUAL_OBSERVATION_INTERVAL_MS?: string;
    readonly ROBOT_VIRTUAL_OBSERVATION_EXPERIMENT_ID?: string;
    readonly ROBOT_VIRTUAL_OBSERVATION_LEASE_TTL_MS?: string;
    readonly ROBOT_VIRTUAL_STARTING_CASH_KOPECKS?: string;
    readonly ROBOT_VIRTUAL_FEE_BPS?: string;
    readonly ROBOT_VIRTUAL_SLIPPAGE_BPS?: string;
    readonly ROBOT_VIRTUAL_QUOTE_MAX_AGE_MS?: string;
    readonly ROBOT_VIRTUAL_BENCHMARK_ID?: string;
    readonly ROBOT_VIRTUAL_OBSERVATION_MAX_BATCH_SIZE?: string;
}

const loadSequelizeDependencies = async (): Promise<WorkerDependencies> => {
    const [{ prepareSequelizeVirtualObservationRuntime }, { default: sequelize }] = await Promise.all([
        import('../services/virtual-observation-runtime.service'),
        import('../config/database')
    ]);
    return {
        authenticate: () => sequelize.authenticate(),
        close: () => sequelize.close(),
        prepareRuntime: prepareSequelizeVirtualObservationRuntime
    };
};

export const runVirtualObservationWorker = async (
    env: WorkerEnvironment,
    loadDependencies: () => Promise<WorkerDependencies> = loadSequelizeDependencies
) => {
    const enabled = ['1', 'true', 'yes', 'on'].includes(
        String(env.ROBOT_VIRTUAL_OBSERVATION_ENABLED ?? '').trim().toLowerCase()
    );
    // The disabled worker exits before loading Sequelize, models, or persistence adapters.
    if (!enabled) return;
    const intervalMs = Number(env.ROBOT_VIRTUAL_OBSERVATION_INTERVAL_MS ?? 15 * 60 * 1000);
    const experimentId = String(env.ROBOT_VIRTUAL_OBSERVATION_EXPERIMENT_ID ?? '').trim();
    if (!experimentId) throw new Error('enabled observation worker requires ROBOT_VIRTUAL_OBSERVATION_EXPERIMENT_ID');
    const leaseTtlMs = Number(env.ROBOT_VIRTUAL_OBSERVATION_LEASE_TTL_MS ?? intervalMs * 3);
    if (!Number.isSafeInteger(leaseTtlMs) || leaseTtlMs <= intervalMs) {
        throw new Error('observation worker lease TTL must be an integer greater than the tick interval');
    }
    const integer = (name: string, value: string | undefined, fallback: number, minimum: number, maximum: number) => {
        const parsed = value === undefined ? fallback : Number(value);
        if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
            throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
        }
        return parsed;
    };
    const startingCashRaw = env.ROBOT_VIRTUAL_STARTING_CASH_KOPECKS ?? '100000000';
    if (!/^[1-9]\d*$/.test(startingCashRaw)) throw new Error('ROBOT_VIRTUAL_STARTING_CASH_KOPECKS must be a positive integer');
    const settings: ObservationExperimentSettings = {
        startingCashKopecks: BigInt(startingCashRaw),
        executionPolicy: {
            feeBasisPoints: integer('ROBOT_VIRTUAL_FEE_BPS', env.ROBOT_VIRTUAL_FEE_BPS, 10, 0, 10_000),
            slippageBasisPoints: integer('ROBOT_VIRTUAL_SLIPPAGE_BPS', env.ROBOT_VIRTUAL_SLIPPAGE_BPS, 10, 1, 10_000),
            maxQuoteAgeMs: integer('ROBOT_VIRTUAL_QUOTE_MAX_AGE_MS', env.ROBOT_VIRTUAL_QUOTE_MAX_AGE_MS, 5_000, 1, 600_000)
        },
        ...(env.ROBOT_VIRTUAL_BENCHMARK_ID?.trim() ? { benchmarkId: env.ROBOT_VIRTUAL_BENCHMARK_ID.trim() } : {})
    };
    const maxBatchSize = integer('ROBOT_VIRTUAL_OBSERVATION_MAX_BATCH_SIZE',
        env.ROBOT_VIRTUAL_OBSERVATION_MAX_BATCH_SIZE, 100, 1, 1_000);
    const dependencies = await loadDependencies();
    await dependencies.authenticate();
    const prepared = await dependencies.prepareRuntime(experimentId, leaseTtlMs, settings, maxBatchSize);
    const scheduler = startVirtualObservationScheduler({ enabled: true, intervalMs },
        () => prepared.runtime);
    let shuttingDown = false;
    const renewal = setInterval(() => {
        void prepared.lease.renew().then(renewed => {
            if (!renewed) return fail(new Error('virtual observation worker lost its database lease'));
        }).catch(fail);
    }, Math.max(1000, Math.floor(leaseTtlMs / 3)));
    const shutdown = async () => {
        if (shuttingDown) return;
        shuttingDown = true;
        scheduler.stop();
        clearInterval(renewal);
        await prepared.lease.release();
        await dependencies.close();
    };
    const fail = (error: unknown) => {
        console.error('Virtual observation worker stopped:', error);
        process.exitCode = 1;
        void shutdown();
    };
    process.once('SIGINT', () => void shutdown());
    process.once('SIGTERM', () => void shutdown());
};

if (require.main === module) {
    void runVirtualObservationWorker(process.env).catch(error => {
        console.error('Virtual observation worker failed:', error);
        process.exitCode = 1;
    });
}
