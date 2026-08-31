import { startVirtualObservationScheduler, VirtualObservationRuntime } from './shadow-composition';
import type { ObservationLease } from './observation-persistence';

interface PreparedWorkerRuntime {
    readonly runtime: VirtualObservationRuntime;
    readonly lease: ObservationLease;
}

interface WorkerDependencies {
    readonly authenticate: () => Promise<void>;
    readonly close: () => Promise<void>;
    readonly prepareRuntime: (experimentId: string, leaseTtlMs: number) => Promise<PreparedWorkerRuntime>;
}

interface WorkerEnvironment {
    readonly ROBOT_VIRTUAL_OBSERVATION_ENABLED?: string;
    readonly ROBOT_VIRTUAL_OBSERVATION_INTERVAL_MS?: string;
    readonly ROBOT_VIRTUAL_OBSERVATION_EXPERIMENT_ID?: string;
    readonly ROBOT_VIRTUAL_OBSERVATION_LEASE_TTL_MS?: string;
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
    const dependencies = await loadDependencies();
    await dependencies.authenticate();
    const prepared = await dependencies.prepareRuntime(experimentId, leaseTtlMs);
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
