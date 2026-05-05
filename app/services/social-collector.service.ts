import { getEnv } from '../config/env.config';
import SocialProfileModel from '../models/social-profile.model';
import SocialSignalService from './social-signal.service';

interface ConfiguredProfile {
    source: string;
    profileKey: string;
    profileUrl: string;
}

const parseNumber = (value: string | undefined, defaultValue: number) => {
    if (value === undefined || value.trim() === '') return defaultValue;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : defaultValue;
};

const normalizeProfileUrl = (value: string) => value.trim();

const getProfileKey = (profileUrl: string) => {
    try {
        const url = new URL(profileUrl);
        const parts = url.pathname.split('/').map(part => part.trim()).filter(Boolean);
        const key = parts[parts.length - 1] || url.hostname;

        return key.replace(/[^a-zA-Z0-9_.-]/g, '').toLowerCase();
    } catch {
        return profileUrl.replace(/[^a-zA-Z0-9_.-]/g, '').toLowerCase();
    }
};

const parseProfileUrls = (value: string | undefined): ConfiguredProfile[] => {
    if (!value) return [];

    const seen = new Set<string>();

    return value
        .split(/[\n,]+/)
        .map(normalizeProfileUrl)
        .filter(Boolean)
        .map(profileUrl => ({
            source: 't-pulse',
            profileKey: getProfileKey(profileUrl),
            profileUrl
        }))
        .filter(profile => {
            if (!profile.profileKey || seen.has(profile.profileKey)) return false;
            seen.add(profile.profileKey);
            return true;
        });
};

export default class SocialCollectorService {
    static getConfig() {
        const env = getEnv();

        return {
            profiles: parseProfileUrls(env.ROBOT_SOCIAL_PROFILE_URLS),
            minReturnPercent: parseNumber(env.ROBOT_SOCIAL_MIN_RETURN_PERCENT, 100),
            intervalMs: Math.max(60_000, parseNumber(env.ROBOT_SOCIAL_COLLECTOR_INTERVAL_MS, 15 * 60 * 1000)),
            hasAuthCookie: Boolean(env.ROBOT_SOCIAL_AUTH_COOKIE?.trim())
        };
    }

    static async syncProfiles() {
        const config = this.getConfig();
        let created = 0;
        let updated = 0;

        for (const profile of config.profiles) {
            const [record, wasCreated] = await SocialProfileModel.findOrCreate({
                where: { profileKey: profile.profileKey },
                defaults: {
                    source: profile.source,
                    profileKey: profile.profileKey,
                    profileUrl: profile.profileUrl,
                    minReturnPercent: config.minReturnPercent,
                    status: 'configured'
                }
            });

            if (wasCreated) {
                created += 1;
                continue;
            }

            await record.update({
                source: profile.source,
                profileUrl: profile.profileUrl,
                minReturnPercent: config.minReturnPercent
            });
            updated += 1;
        }

        return {
            configured: config.profiles.length,
            created,
            updated
        };
    }

    static async collectOnce() {
        const config = this.getConfig();
        const sync = await this.syncProfiles();
        const profiles = await SocialProfileModel.findAll({
            order: [['updatedAt', 'DESC']],
            limit: 500
        });
        let checked = 0;
        let errors = 0;

        for (const profile of profiles) {
            if (!config.profiles.some(item => item.profileKey === profile.profileKey)) continue;

            checked += 1;

            if (!config.hasAuthCookie) {
                await profile.update({
                    status: 'pending-auth',
                    lastCheckedAt: new Date(),
                    lastError: 'ROBOT_SOCIAL_AUTH_COOKIE is empty. Add browser cookie/header before parsing Pulse.'
                });
                continue;
            }

            await profile.update({
                status: 'configured',
                lastCheckedAt: new Date(),
                lastError: 'Pulse adapter is not connected yet. Profile is configured and isolated collector is alive.'
            });
        }

        const latestSignals = await SocialSignalService.list(20);

        return {
            ok: errors === 0,
            generatedAt: new Date().toISOString(),
            config: {
                configuredProfiles: config.profiles.length,
                minReturnPercent: config.minReturnPercent,
                intervalMs: config.intervalMs,
                hasAuthCookie: config.hasAuthCookie
            },
            sync,
            checked,
            errors,
            profiles: profiles.map(profile => profile.toJSON()),
            signalsSummary: latestSignals.summary
        };
    }

    static async status() {
        const config = this.getConfig();
        const profiles = await SocialProfileModel.findAll({
            order: [['updatedAt', 'DESC']],
            limit: 500
        });
        const signals = await SocialSignalService.summary();
        const staleCutoff = Date.now() - config.intervalMs * 2;
        const configuredKeys = new Set(config.profiles.map(profile => profile.profileKey));
        const activeProfiles = profiles.filter(profile => configuredKeys.has(profile.profileKey));
        const stale = activeProfiles.filter(profile => !profile.lastCheckedAt || new Date(profile.lastCheckedAt).getTime() < staleCutoff).length;

        return {
            ok: activeProfiles.length > 0 && stale === 0,
            generatedAt: new Date().toISOString(),
            config: {
                configuredProfiles: config.profiles.length,
                minReturnPercent: config.minReturnPercent,
                intervalMs: config.intervalMs,
                hasAuthCookie: config.hasAuthCookie
            },
            health: {
                activeProfiles: activeProfiles.length,
                staleProfiles: stale,
                pendingAuth: activeProfiles.filter(profile => profile.status === 'pending-auth').length,
                errors: activeProfiles.filter(profile => profile.status === 'error').length
            },
            profiles: activeProfiles.map(profile => profile.toJSON()),
            signals
        };
    }
}
