type CacheEntry<T> = {
    expiresAt: number;
    value: T;
};

const delay = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds));

const isRateLimitError = (error: unknown) => {
    const data = error as { code?: string | number; message?: string };
    const code = String(data?.code ?? '').toLowerCase();
    const message = String(data?.message ?? error ?? '').toLowerCase();

    return code === '8'
        || code === 'resource_exhausted'
        || message.includes('resource_exhausted')
        || message.includes('rate limit')
        || message.includes('too many requests')
        || message.includes('middleware returned void');
};

export default class TInvestApiCacheService {
    private static cache = new Map<string, CacheEntry<unknown>>();
    private static inFlight = new Map<string, Promise<unknown>>();
    private static queue = Promise.resolve();
    private static minDelayMs = 120;

    private static async schedule<T>(task: () => Promise<T>) {
        const run = this.queue
            .catch(() => undefined)
            .then(async () => {
                await delay(this.minDelayMs);
                return task();
            });

        this.queue = run.then(() => undefined, () => undefined);
        return await run;
    }

    static clear(prefix?: string) {
        if (!prefix) {
            this.cache.clear();
            return;
        }

        for (const key of this.cache.keys()) {
            if (key.startsWith(prefix)) this.cache.delete(key);
        }
    }

    static async cached<T>(key: string, ttlMs: number, task: () => Promise<T>) {
        const now = Date.now();
        const cached = this.cache.get(key) as CacheEntry<T> | undefined;
        if (cached && cached.expiresAt > now) return cached.value;

        const active = this.inFlight.get(key) as Promise<T> | undefined;
        if (active) return await active;

        const promise = this.withRetry(task)
            .then(value => {
                this.cache.set(key, {
                    value,
                    expiresAt: Date.now() + ttlMs
                });
                return value;
            })
            .catch(error => {
                if (cached && isRateLimitError(error)) return cached.value;
                throw error;
            })
            .finally(() => {
                this.inFlight.delete(key);
            });

        this.inFlight.set(key, promise);
        return await promise;
    }

    static async withRetry<T>(task: () => Promise<T>, attempts = 3) {
        let lastError: unknown;

        for (let attempt = 0; attempt < attempts; attempt += 1) {
            try {
                return await this.schedule(task);
            } catch (error) {
                lastError = error;
                if (!isRateLimitError(error) || attempt === attempts - 1) break;
                await delay(1_000 * (attempt + 1));
            }
        }

        throw lastError;
    }
}
