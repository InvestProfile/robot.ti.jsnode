import { getEnv } from '../config/env.config';
import SocialProfileModel from '../models/social-profile.model';
import SocialProfileScoreService from './social-profile-score.service';
import SocialSignalService from './social-signal.service';
import { Op } from 'sequelize';

interface ConfiguredProfile {
    source: string;
    profileKey: string;
    profileUid?: string;
    profileUrl: string;
    displayName?: string;
    confidence?: number;
    activity: number;
    description?: string;
}

type ProfileStats = {
    followersCount?: number | null;
    followingCount?: number | null;
    monthOperationsCount?: number | null;
    lastReturnPercent?: number | null;
    portfolioLowerRub?: number | null;
    portfolioUpperRub?: number | null;
};

interface ProfileCollectionResult {
    status: 'pending-auth' | 'ready';
    signals: number;
    lastError: string | null;
    profileUid?: string;
    profileStats?: ProfileStats;
}

const PROFILE_UID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

const parseNumber = (value: string | undefined, defaultValue: number) => {
    if (value === undefined || value.trim() === '') return defaultValue;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : defaultValue;
};

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const randomDelay = async (minMs: number, maxMs: number) => {
    const safeMin = Math.max(0, Math.min(minMs, maxMs));
    const safeMax = Math.max(safeMin, maxMs);
    const duration = Math.round(Math.random() * (safeMax - safeMin) + safeMin);

    if (duration > 0) {
        await delay(duration);
    }
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

const normalizeHtmlForJsonSearch = (html: string) => html
    .replace(/\\u0022/g, '"')
    .replace(/\\u002F/g, '/')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, '&');

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const extractProfileUidFromHtml = (html: string, profileKey: string) => {
    const normalizedHtml = normalizeHtmlForJsonSearch(html);
    const normalizedKey = profileKey.trim().toLowerCase();
    if (!normalizedHtml || !normalizedKey) return null;

    const keyPattern = new RegExp(`"${escapeRegExp(normalizedKey)}"`, 'i');
    const fuzzyKeyPattern = new RegExp(escapeRegExp(normalizedKey), 'i');
    const directPatterns = [
        new RegExp(`"(?:nickname|displayName|profileName|slug|login|name)"\\s*:\\s*"${escapeRegExp(normalizedKey)}"[\\s\\S]{0,2000}?"id"\\s*:\\s*"(${PROFILE_UID_PATTERN.source})"`, 'i'),
        new RegExp(`"id"\\s*:\\s*"(${PROFILE_UID_PATTERN.source})"[\\s\\S]{0,2000}?"(?:nickname|displayName|profileName|slug|login|name)"\\s*:\\s*"${escapeRegExp(normalizedKey)}"`, 'i')
    ];

    for (const pattern of directPatterns) {
        const match = normalizedHtml.match(pattern);
        if (match?.[1]) return match[1].toLowerCase();
    }

    const candidates = new Map<string, number>();
    const lowerHtml = normalizedHtml.toLowerCase();
    let searchIndex = 0;

    while (searchIndex < lowerHtml.length) {
        const index = lowerHtml.indexOf(normalizedKey, searchIndex);
        if (index === -1) break;

        const fragment = normalizedHtml.slice(Math.max(0, index - 4_000), Math.min(normalizedHtml.length, index + 4_000));
        const hasStrongKey = keyPattern.test(fragment) || /"nickname"|"displayName"|"profileName"|"slug"|"login"/i.test(fragment);
        const hasFuzzyKey = fuzzyKeyPattern.test(fragment);

        for (const match of fragment.matchAll(PROFILE_UID_PATTERN)) {
            const uid = match[0].toLowerCase();
            const score = (hasStrongKey ? 5 : 0)
                + (hasFuzzyKey ? 2 : 0)
                + (/followersCount|monthOperationsCount|yearRelativeYield|totalAmountRange/i.test(fragment) ? 2 : 0)
                + (/profile|author|social/i.test(fragment) ? 1 : 0);
            candidates.set(uid, Math.max(candidates.get(uid) ?? 0, score));
        }

        searchIndex = index + normalizedKey.length;
    }

    const best = [...candidates.entries()].sort((a, b) => b[1] - a[1])[0];
    return best?.[0] ?? null;
};

const parseProfileToken = (token: string): ConfiguredProfile | undefined => {
    const parts = token.split('|').map(part => part.trim());
    const first = parts[0];
    if (!first) return undefined;

    const looksLikeUrl = /^https?:\/\//i.test(first);
    const profileUrl = looksLikeUrl ? first : (parts[1] ?? '');
    const profileUid = looksLikeUrl ? parts[1] : first;
    const displayName = looksLikeUrl ? undefined : parts[2];
    const confidence = looksLikeUrl ? undefined : parseNumber(parts[3], NaN);
    const activity = looksLikeUrl ? parseNumber(parts[2], 1) : parseNumber(parts[4], 1);
    const description = looksLikeUrl ? parts[3] : parts[5];

    if (!profileUrl) return undefined;

    return {
        source: 't-pulse',
        profileKey: (profileUid || getProfileKey(profileUrl)).replace(/[^a-zA-Z0-9_.-]/g, '').toLowerCase(),
        profileUid: profileUid || undefined,
        profileUrl,
        displayName: displayName || getProfileKey(profileUrl),
        confidence: Number.isFinite(confidence) ? confidence : undefined,
        activity: Math.max(1, Math.trunc(activity || 1)),
        description
    };
};

const parseProfileUrls = (value: string | undefined): ConfiguredProfile[] => {
    if (!value) return [];

    const seen = new Set<string>();

    return value
        .split(/[\n,]+/)
        .map(normalizeProfileUrl)
        .filter(Boolean)
        .map(parseProfileToken)
        .filter((profile): profile is ConfiguredProfile => Boolean(profile))
        .filter(profile => {
            if (!profile.profileKey || seen.has(profile.profileKey)) return false;
            seen.add(profile.profileKey);
            return true;
        });
};

const getActivityQueue = (profiles: ConfiguredProfile[]) => {
    const maxActivity = Math.max(0, ...profiles.map(profile => profile.activity));
    const result: ConfiguredProfile[] = [];

    for (let i = 0; i < maxActivity; i += 1) {
        for (const profile of profiles) {
            if (profile.activity > i) {
                result.push(profile);
            }
        }
    }

    return result;
};

const buildCookieHeader = (authCookie: string | undefined, sessionId: string | undefined) => [
    authCookie?.trim(),
    sessionId?.trim() ? `psid=${sessionId.trim()}` : undefined
].filter(Boolean).join('; ');

const mapAction = (action: string | undefined) => {
    const normalized = String(action ?? '').toLowerCase();
    if (normalized.includes('buy') || normalized.includes('покуп')) return 'buy';
    if (normalized.includes('sell') || normalized.includes('прод')) return 'sell';
    return 'watch';
};

const parseNumericMatch = (source: string, pattern: RegExp) => {
    const match = source.match(pattern);
    if (!match?.[1]) return null;
    const value = Number(match[1]);

    return Number.isFinite(value) ? value : null;
};

const extractProfileStatsFromHtml = (html: string, profileUid: string) => {
    const normalizedHtml = normalizeHtmlForJsonSearch(html);
    const profileIndex = normalizedHtml.lastIndexOf(`"id":"${profileUid}"`);
    if (profileIndex === -1) return {};

    const fragment = normalizedHtml.slice(profileIndex, profileIndex + 5_000);
    return {
        followersCount: parseNumericMatch(fragment, /"followersCount":(\d+)/),
        followingCount: parseNumericMatch(fragment, /"followingCount":(\d+)/),
        monthOperationsCount: parseNumericMatch(fragment, /"monthOperationsCount":(\d+)/),
        lastReturnPercent: parseNumericMatch(fragment, /"yearRelativeYield":(-?\d+(?:\.\d+)?)/),
        portfolioLowerRub: parseNumericMatch(fragment, /"totalAmountRange":\{"lower":(-?\d+(?:\.\d+)?)/),
        portfolioUpperRub: parseNumericMatch(fragment, /"totalAmountRange":\{"lower":-?\d+(?:\.\d+)?,"upper":(-?\d+(?:\.\d+)?)/)
    };
};

let socialProfileEnvWarningPrinted = false;

export default class SocialCollectorService {
    static getConfig() {
        const env = getEnv();
        if (env.ROBOT_SOCIAL_PROFILE_URLS?.trim() && !socialProfileEnvWarningPrinted) {
            console.warn('ROBOT_SOCIAL_PROFILE_URLS is deprecated. Manage Pulse profiles in the web dashboard instead.');
            socialProfileEnvWarningPrinted = true;
        }

        return {
            profiles: parseProfileUrls(env.ROBOT_SOCIAL_PROFILE_URLS),
            minReturnPercent: parseNumber(env.ROBOT_SOCIAL_MIN_RETURN_PERCENT, 100),
            intervalMs: Math.max(60_000, parseNumber(env.ROBOT_SOCIAL_COLLECTOR_INTERVAL_MS, 15 * 60 * 1000)),
            requestMinDelayMs: Math.max(0, parseNumber(env.ROBOT_SOCIAL_REQUEST_MIN_DELAY_MS, 5_000)),
            requestMaxDelayMs: Math.max(0, parseNumber(env.ROBOT_SOCIAL_REQUEST_MAX_DELAY_MS, 10_000)),
            instrumentLimit: Math.max(1, Math.trunc(parseNumber(env.ROBOT_SOCIAL_INSTRUMENT_LIMIT, 100))),
            operationLimit: Math.max(1, Math.trunc(parseNumber(env.ROBOT_SOCIAL_OPERATION_LIMIT, 1))),
            sessionId: env.ROBOT_SOCIAL_SESSION_ID?.trim(),
            authCookie: env.ROBOT_SOCIAL_AUTH_COOKIE?.trim(),
            hasAuthCookie: Boolean(env.ROBOT_SOCIAL_AUTH_COOKIE?.trim()),
            hasSessionId: Boolean(env.ROBOT_SOCIAL_SESSION_ID?.trim())
        };
    }

    private static async requestJson(url: string, cookieHeader: string) {
        const response = await fetch(url, {
            method: 'GET',
            headers: {
                accept: 'application/json',
                'content-type': 'application/json',
                cookie: cookieHeader,
                referer: 'https://www.tbank.ru/invest/social/',
                'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X) AppleWebKit/537.36 T-Invest-Robot-SocialCollector/1.0'
            }
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status} ${response.statusText}`);
        }

        return response.json() as Promise<any>;
    }

    private static async requestText(url: string, cookieHeader: string) {
        const response = await fetch(url, {
            method: 'GET',
            headers: {
                accept: 'text/html,application/xhtml+xml',
                cookie: cookieHeader,
                referer: 'https://www.tbank.ru/invest/social/',
                'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X) AppleWebKit/537.36 T-Invest-Robot-SocialCollector/1.0'
            }
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status} ${response.statusText}`);
        }

        return response.text();
    }

    private static async fetchProfileHtml(profile: ConfiguredProfile, cookieHeader: string, config: ReturnType<typeof SocialCollectorService.getConfig>) {
        if (!profile.profileUrl) return '';

        await randomDelay(config.requestMinDelayMs, config.requestMaxDelayMs);
        return this.requestText(profile.profileUrl, cookieHeader);
    }

    private static async fetchProfileStats(profile: ConfiguredProfile, cookieHeader: string, config: ReturnType<typeof SocialCollectorService.getConfig>) {
        if (!profile.profileUid || !profile.profileUrl) return {};

        const html = await this.fetchProfileHtml(profile, cookieHeader, config);

        return extractProfileStatsFromHtml(html, profile.profileUid);
    }

    private static async resolveProfileUid(profile: ConfiguredProfile, cookieHeader: string, config: ReturnType<typeof SocialCollectorService.getConfig>) {
        if (profile.profileUid) {
            const html = profile.profileUrl ? await this.fetchProfileHtml(profile, cookieHeader, config) : '';
            return {
                profileUid: profile.profileUid,
                profileStats: html ? extractProfileStatsFromHtml(html, profile.profileUid) : {}
            };
        }

        if (!profile.profileUrl) return { profileUid: undefined, profileStats: {} };

        const html = await this.fetchProfileHtml(profile, cookieHeader, config);
        const profileUid = extractProfileUidFromHtml(html, profile.profileKey);

        return {
            profileUid: profileUid ?? undefined,
            profileStats: profileUid ? extractProfileStatsFromHtml(html, profileUid) : {}
        };
    }

    private static async collectProfile(profile: ConfiguredProfile, config: ReturnType<typeof SocialCollectorService.getConfig>): Promise<ProfileCollectionResult> {
        const cookieHeader = buildCookieHeader(config.authCookie, config.sessionId);
        const resolved = await this.resolveProfileUid(profile, cookieHeader, config);
        const profileUid = resolved.profileUid;

        if (!profileUid) {
            return {
                status: 'pending-auth',
                signals: 0,
                lastError: 'Profile UID is missing and could not be discovered from profile URL.',
                profileStats: resolved.profileStats
            };
        }

        if (!config.hasSessionId && !config.hasAuthCookie) {
            return {
                status: 'pending-auth',
                signals: 0,
                lastError: 'ROBOT_SOCIAL_SESSION_ID or ROBOT_SOCIAL_AUTH_COOKIE is empty. Add psid/cookie before parsing Pulse.',
                profileUid,
                profileStats: resolved.profileStats
            };
        }

        const sessionQuery = config.sessionId ? `&sessionId=${encodeURIComponent(config.sessionId)}` : '';
        const today = new Date().toISOString().slice(0, 10);
        const profileStats = Object.keys(resolved.profileStats).length > 0
            ? resolved.profileStats
            : await this.fetchProfileStats({ ...profile, profileUid }, cookieHeader, config);
        const instrumentUrl = `https://www.tbank.ru/api/invest-gw/social/v1/profile/${profileUid}/instrument?limit=${config.instrumentLimit}${sessionQuery}`;

        await randomDelay(config.requestMinDelayMs, config.requestMaxDelayMs);
        const instrumentsResponse = await this.requestJson(instrumentUrl, cookieHeader);
        const instruments = (instrumentsResponse?.payload?.items ?? [])
            .filter((item: any) => item?.statistics?.maxTradeDateTime?.slice(0, 10) === today)
            .filter((item: any) => item?.type === 'share' && item?.currency === 'rub');
        let signals = 0;

        for (const instrument of instruments) {
            if (!instrument?.ticker || !instrument?.classCode) continue;

            await randomDelay(config.requestMinDelayMs, config.requestMaxDelayMs);
            const operationUrl = `https://www.tbank.ru/api/invest-gw/social/v1/profile/${profileUid}/operation/instrument/${instrument.ticker}/${instrument.classCode}?limit=${config.operationLimit}${sessionQuery}`;
            const operationsResponse = await this.requestJson(operationUrl, cookieHeader);
            const operation = operationsResponse?.payload?.items?.[0];
            const action = mapAction(operation?.action);

            if (!operation?.action) continue;

            await SocialSignalService.upsertSignal({
                source: 't-pulse',
                actorKey: profile.profileKey,
                actorName: profile.displayName,
                actorReturnPercent: undefined,
                ticker: instrument.ticker,
                name: instrument.name,
                figi: undefined,
                instrumentUid: undefined,
                action,
                confidence: profile.confidence,
                price: Number(operation.averagePrice ?? operation.price ?? 0) || undefined,
                reason: `Pulse ${operation.action} from ${profile.displayName ?? profile.profileKey}`,
                sourceUrl: profile.profileUrl,
                rawPayload: { instrument, operation },
                observedAt: operation.tradeDateTime ? new Date(operation.tradeDateTime) : new Date()
            });
            signals += 1;
        }

        return {
            status: 'ready',
            signals,
            lastError: null,
            profileUid: profileUid === profile.profileUid ? undefined : profileUid,
            profileStats
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
                    profileUid: profile.profileUid,
                    profileUrl: profile.profileUrl,
                    displayName: profile.displayName,
                    confidence: profile.confidence,
                    activity: profile.activity,
                    description: profile.description,
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
                profileUid: profile.profileUid,
                profileUrl: profile.profileUrl,
                displayName: profile.displayName,
                confidence: profile.confidence,
                activity: profile.activity,
                description: profile.description,
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

    static async getActiveProfiles() {
        const config = this.getConfig();
        const dbProfiles = await SocialProfileModel.findAll({
            where: {
                status: { [Op.ne]: 'disabled' }
            },
            order: [['updatedAt', 'DESC']],
            limit: 500
        }).catch(async () => {
            await SocialProfileModel.sync({ alter: true });
            return SocialProfileModel.findAll({
                where: {
                    status: { [Op.ne]: 'disabled' }
                },
                order: [['updatedAt', 'DESC']],
                limit: 500
            });
        });

        if (dbProfiles.length > 0) {
            return dbProfiles.map(profile => ({
                source: profile.source,
                profileKey: profile.profileKey,
                profileUid: profile.profileUid ?? undefined,
                profileUrl: profile.profileUrl,
                displayName: profile.displayName ?? profile.profileKey,
                confidence: profile.effectiveConfidence ?? profile.confidence ?? undefined,
                activity: Math.max(1, Math.trunc(profile.activity ?? 1)),
                description: profile.description ?? undefined
            }));
        }

        if (config.profiles.length > 0) {
            await this.syncProfiles();
            return config.profiles;
        }

        return [];
    }

    static async collectOnce() {
        const config = this.getConfig();
        const activeProfiles = await this.getActiveProfiles();
        const profiles = await SocialProfileModel.findAll({
            order: [['updatedAt', 'DESC']],
            limit: 500
        });
        let checked = 0;
        let errors = 0;

        const activeQueue = getActivityQueue(activeProfiles);

        for (const configuredProfile of activeQueue) {
            const profile = profiles.find(item => item.profileKey === configuredProfile.profileKey);
            if (!profile) continue;

            checked += 1;

            try {
                const result = await this.collectProfile(configuredProfile, config);
                if (result.profileUid && result.profileUid !== profile.profileUid) {
                    const duplicate = await SocialProfileModel.findOne({
                        where: {
                            profileUid: result.profileUid,
                            profileKey: { [Op.ne]: profile.profileKey }
                        }
                    });

                    if (duplicate) {
                        await profile.update({
                            status: 'disabled',
                            profileUid: result.profileUid,
                            lastCheckedAt: new Date(),
                            lastError: `Duplicate of ${duplicate.profileKey}; disabled automatically.`
                        });
                        continue;
                    }
                }

                await profile.update({
                    status: result.status,
                    profileUid: result.profileUid ?? profile.profileUid,
                    lastCheckedAt: new Date(),
                    lastError: result.lastError,
                    ...result.profileStats
                });
            } catch (error) {
                errors += 1;
                await profile.update({
                    status: 'error',
                    lastCheckedAt: new Date(),
                    lastError: error instanceof Error ? error.message : String(error)
                });
            }
        }

        const profileScores = await SocialProfileScoreService.refresh();
        const latestSignals = await SocialSignalService.list(20);
        const refreshedProfiles = await SocialProfileModel.findAll({
            order: [['updatedAt', 'DESC']],
            limit: 500
        });

        return {
            ok: errors === 0,
            generatedAt: new Date().toISOString(),
            config: {
                configuredProfiles: activeProfiles.length,
                minReturnPercent: config.minReturnPercent,
                intervalMs: config.intervalMs,
                hasAuthCookie: config.hasAuthCookie,
                hasSessionId: config.hasSessionId,
                requestMinDelayMs: config.requestMinDelayMs,
                requestMaxDelayMs: config.requestMaxDelayMs,
                instrumentLimit: config.instrumentLimit,
                operationLimit: config.operationLimit
            },
            sync: {
                configured: activeProfiles.length,
                created: 0,
                updated: 0,
                source: 'database'
            },
            checked,
            errors,
            profileScores,
            profiles: refreshedProfiles.map(profile => profile.toJSON()),
            signalsSummary: latestSignals.summary
        };
    }

    static async status() {
        const config = this.getConfig();
        await SocialProfileScoreService.refresh();
        const configuredProfiles = await this.getActiveProfiles();
        const profiles = await SocialProfileModel.findAll({
            order: [['updatedAt', 'DESC']],
            limit: 500
        });
        const signals = await SocialSignalService.summary();
        const staleCutoff = Date.now() - config.intervalMs * 2;
        const configuredKeys = new Set(configuredProfiles.map(profile => profile.profileKey));
        const activeProfiles = profiles.filter(profile => configuredKeys.has(profile.profileKey));
        const stale = activeProfiles.filter(profile => !profile.lastCheckedAt || new Date(profile.lastCheckedAt).getTime() < staleCutoff).length;

        return {
            ok: activeProfiles.length > 0 && stale === 0,
            generatedAt: new Date().toISOString(),
            config: {
                configuredProfiles: configuredProfiles.length,
                minReturnPercent: config.minReturnPercent,
                intervalMs: config.intervalMs,
                hasAuthCookie: config.hasAuthCookie,
                hasSessionId: config.hasSessionId,
                requestMinDelayMs: config.requestMinDelayMs,
                requestMaxDelayMs: config.requestMaxDelayMs,
                instrumentLimit: config.instrumentLimit,
                operationLimit: config.operationLimit
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
