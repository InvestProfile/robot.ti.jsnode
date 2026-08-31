import {
    applyObservationTick,
    ObservationRunnerState,
    ObservationTick,
    openObservationRunner,
    replayObservationTicks
} from '../virtual/observation-runner';

export interface ObservationTickStore {
    load(experimentId: string): Promise<readonly ObservationTick[]>;
    append(experimentId: string, tick: ObservationTick): Promise<void>;
}

export interface PostRiskVirtualEvidenceSource {
    collect(state: ObservationRunnerState): Promise<ObservationTick>;
}

export interface VirtualObservationRuntime {
    initialize(): Promise<ObservationRunnerState>;
    tick(): Promise<ObservationRunnerState>;
}

export class RestartSafeVirtualObservationRuntime implements VirtualObservationRuntime {
    private state: ObservationRunnerState;
    private initialized = false;
    private running?: Promise<ObservationRunnerState>;

    constructor(
        private readonly experimentId: string,
        private readonly store: ObservationTickStore,
        private readonly source: PostRiskVirtualEvidenceSource
    ) {
        this.state = openObservationRunner(experimentId);
    }

    async initialize(): Promise<ObservationRunnerState> {
        if (!this.initialized) {
            this.state = replayObservationTicks(this.experimentId, await this.store.load(this.experimentId));
            this.initialized = true;
        }
        return this.state;
    }

    async tick(): Promise<ObservationRunnerState> {
        if (this.running) return this.running;
        this.running = this.runTick();
        try {
            return await this.running;
        } finally {
            this.running = undefined;
        }
    }

    private async runTick(): Promise<ObservationRunnerState> {
        const current = await this.initialize();
        const tick = await this.source.collect(current);
        const next = applyObservationTick(current, tick);
        await this.store.append(this.experimentId, tick);
        this.state = next;
        return next;
    }
}

export interface VirtualObservationSchedulerConfig {
    readonly enabled?: boolean;
    readonly intervalMs?: number;
}

export interface VirtualObservationScheduler {
    stop(): void;
}

export interface SchedulerClock {
    setInterval(task: () => void, intervalMs: number): unknown;
    clearInterval(handle: unknown): void;
}

const systemClock: SchedulerClock = {
    setInterval: (task, intervalMs) => setInterval(task, intervalMs),
    clearInterval: handle => clearInterval(handle as NodeJS.Timeout)
};

/** Disabled means no factory call, persistence read, tick, or timer registration. */
export const startVirtualObservationScheduler = (
    config: VirtualObservationSchedulerConfig,
    createRuntime: () => VirtualObservationRuntime,
    clock: SchedulerClock = systemClock,
    onError: (error: unknown) => void = error => console.error('Virtual observation tick failed:', error)
): VirtualObservationScheduler => {
    if (config.enabled !== true) return Object.freeze({ stop: () => undefined });
    const intervalMs = config.intervalMs ?? 0;
    if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) {
        throw new Error('enabled virtual observation runtime requires a positive intervalMs');
    }
    const runtime = createRuntime();
    const run = () => { void runtime.tick().catch(onError); };
    run();
    const handle = clock.setInterval(run, intervalMs);
    return Object.freeze({ stop: () => clock.clearInterval(handle) });
};
