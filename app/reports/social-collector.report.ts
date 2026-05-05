import sequelize from '../config/database';
import DatabaseService from '../services/database.service';
import SocialCollectorService from '../services/social-collector.service';

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const printResult = (result: Awaited<ReturnType<typeof SocialCollectorService.collectOnce>>) => {
    console.log('Social Collector');
    console.log('================');
    console.log(`Generated: ${result.generatedAt}`);
    console.log(`Configured profiles: ${result.config.configuredProfiles}`);
    console.log(`Min return: ${result.config.minReturnPercent}%`);
    console.log(`Auth cookie: ${result.config.hasAuthCookie ? 'yes' : 'no'}`);
    console.log(`Session ID: ${result.config.hasSessionId ? 'yes' : 'no'}`);
    console.log(`Request delay: ${result.config.requestMinDelayMs}-${result.config.requestMaxDelayMs} ms`);
    console.log(`Limits: instruments=${result.config.instrumentLimit}, operations=${result.config.operationLimit}`);
    console.log(`Sync: configured=${result.sync.configured} created=${result.sync.created} updated=${result.sync.updated}`);
    console.log(`Checked: ${result.checked}`);
    console.log(`Profile scores: profiles=${result.profileScores.profiles}, signals=${result.profileScores.signals}`);
    console.log(`Signals 30d: ${result.signalsSummary.signals}`);
    console.log('');
    console.log('Status        Key                         UID                                   Man  Auto  Eff  Act  Follow  Ops30  Signals  Return   Checked                 Error');
    console.log('------------  --------------------------  ------------------------------------  ---  ----  ---  ---  ------  -----  -------  -------  ----------------------  ----------------------------------------');

    for (const profile of result.profiles) {
        console.log([
            String(profile.status ?? '-').padEnd(12),
            String(profile.profileKey ?? '-').padEnd(26),
            String(profile.profileUid ?? '-').padEnd(36),
            String(profile.confidence ?? '-').padStart(3),
            String(profile.autoConfidence ?? '-').padStart(4),
            String(profile.effectiveConfidence ?? '-').padStart(3),
            String(profile.activity ?? '-').padStart(3),
            String(profile.followersCount ?? '-').padStart(6),
            String(profile.monthOperationsCount ?? '-').padStart(5),
            String(profile.recentSignalsCount ?? 0).padStart(7),
            (typeof profile.lastReturnPercent === 'number' ? profile.lastReturnPercent.toFixed(2) + '%' : '-').padStart(7),
            String(profile.lastCheckedAt ?? '-').padEnd(22),
            profile.lastError ?? '-'
        ].join('  '));
    }
};

const main = async () => {
    const loop = process.argv.includes('--loop');

    await DatabaseService.init();

    do {
        const result = await SocialCollectorService.collectOnce();
        printResult(result);

        if (!loop) break;

        await delay(result.config.intervalMs);
    } while (loop);
};

void main()
    .catch(error => {
        console.error('Social collector failed:', error);
        process.exitCode = 1;
    })
    .finally(async () => {
        if (!process.argv.includes('--loop')) {
            await sequelize.close().catch(() => undefined);
        }
    });
