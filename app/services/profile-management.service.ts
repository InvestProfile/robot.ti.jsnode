import SocialProfileModel, { SocialProfileStatus } from '../models/social-profile.model';
import { Op } from 'sequelize';

interface CreateProfileRequest {
    profileUrl: string;
    profileUid?: string;
    displayName?: string;
    confidence?: number;
    activity?: number;
    description?: string;
}

interface UpdateProfileRequest {
    displayName?: string;
    confidence?: number;
    activity?: number;
    description?: string;
    status?: SocialProfileStatus;
}

interface ProfileFilter {
    status?: SocialProfileStatus;
    source?: string;
}

interface ValidationResult {
    valid: boolean;
    errors: string[];
}

interface ParsedProfileUrl {
    profileKey: string;
    profileUid?: string;
    displayName?: string;
    source: string;
}

interface ToggleResult {
    profile: SocialProfileModel;
    previousStatus: SocialProfileStatus;
    newStatus: SocialProfileStatus;
}

export default class ProfileManagementService {
    /**
     * Parse profile URL to extract metadata
     * Extracts profileKey, profileUid (if present), and source
     */
    static parseProfileUrl(url: string): ParsedProfileUrl {
        const trimmedUrl = url.trim();
        
        try {
            const urlObj = new URL(trimmedUrl);
            
            // Extract UID from query parameters if present
            const uidParam = urlObj.searchParams.get('uid') || urlObj.searchParams.get('id');
            
            // Extract profile key from URL path
            const pathParts = urlObj.pathname.split('/').map(part => part.trim()).filter(Boolean);
            const lastPart = pathParts[pathParts.length - 1] || urlObj.hostname;
            
            // Sanitize profile key: lowercase, alphanumeric and dashes only
            const profileKey = lastPart.replace(/[^a-zA-Z0-9_.-]/g, '').toLowerCase();
            
            return {
                profileKey,
                profileUid: uidParam || undefined,
                displayName: lastPart || undefined,
                source: 't-pulse'
            };
        } catch {
            // If URL parsing fails, use the entire string as profile key
            const profileKey = trimmedUrl.replace(/[^a-zA-Z0-9_.-]/g, '').toLowerCase();
            return {
                profileKey,
                source: 't-pulse'
            };
        }
    }

    /**
     * Validate profile data
     * Checks URL format, confidence range, activity minimum
     */
    static validateProfileData(data: Partial<CreateProfileRequest>, options: { requireProfileUrl?: boolean } = { requireProfileUrl: true }): ValidationResult {
        const errors: string[] = [];

        // Validate profile URL
        if (options.requireProfileUrl !== false && (!data.profileUrl || data.profileUrl.trim() === '')) {
            errors.push('Profile URL is required');
        } else if (data.profileUrl !== undefined) {
            const trimmedUrl = data.profileUrl.trim();
            
            // Check if it's a valid URL
            try {
                const urlObj = new URL(trimmedUrl);
                
                // Validate protocol
                if (urlObj.protocol !== 'http:' && urlObj.protocol !== 'https:') {
                    errors.push('Profile URL must use HTTP or HTTPS protocol');
                }
            } catch {
                errors.push('Invalid profile URL format');
            }
        }

        // Validate confidence
        if (data.confidence !== undefined && data.confidence !== null) {
            if (typeof data.confidence !== 'number' || !Number.isFinite(data.confidence)) {
                errors.push('Confidence must be a valid number');
            } else if (data.confidence < 0 || data.confidence > 100) {
                errors.push('Confidence must be between 0 and 100');
            }
        }

        // Validate activity
        if (data.activity !== undefined && data.activity !== null) {
            if (typeof data.activity !== 'number' || !Number.isFinite(data.activity)) {
                errors.push('Activity must be a valid number');
            } else if (data.activity < 1) {
                errors.push('Activity must be at least 1');
            } else if (data.activity !== Math.trunc(data.activity)) {
                errors.push('Activity must be an integer');
            }
        }

        return {
            valid: errors.length === 0,
            errors
        };
    }

    /**
     * Create a new profile from URL
     * Parses URL, validates data, and creates database record
     */
    static async createProfile(data: CreateProfileRequest): Promise<SocialProfileModel> {
        // Validate input data
        const validation = this.validateProfileData(data, { requireProfileUrl: false });
        if (!validation.valid) {
            throw new Error(`Validation failed: ${validation.errors.join(', ')}`);
        }

        // Parse profile URL
        const parsed = this.parseProfileUrl(data.profileUrl);
        const profileUid = data.profileUid || parsed.profileUid;
        const normalizedProfileUrl = data.profileUrl.trim();
        
        // Check for duplicate identity. URL-only profiles start with a slug key and
        // later discover profileUid, so we also guard by URL and optional UID here.
        const existing = await SocialProfileModel.findOne({
            where: {
                [Op.or]: [
                    { profileKey: parsed.profileKey },
                    { profileUrl: normalizedProfileUrl },
                    ...(profileUid ? [{ profileUid }] : [])
                ]
            }
        });

        if (existing) {
            throw new Error(`Profile '${parsed.displayName ?? parsed.profileKey}' already exists`);
        }

        // Create profile with defaults
        const profile = await SocialProfileModel.create({
            source: parsed.source,
            profileKey: parsed.profileKey,
            profileUid: profileUid || null,
            profileUrl: normalizedProfileUrl,
            displayName: data.displayName || parsed.displayName || parsed.profileKey,
            confidence: data.confidence !== undefined ? data.confidence : null,
            activity: data.activity !== undefined ? Math.trunc(data.activity) : 1,
            description: data.description || null,
            minReturnPercent: 100, // Default from design
            status: 'configured',
            lastCheckedAt: null,
            lastError: null,
            rawPayload: null,
            // Statistics fields default to null/0
            followersCount: null,
            followingCount: null,
            monthOperationsCount: null,
            portfolioLowerRub: null,
            portfolioUpperRub: null,
            autoConfidence: null,
            effectiveConfidence: null,
            recentSignalsCount: 0,
            recentBuySignalsCount: 0,
            recentSellSignalsCount: 0,
            scoreReason: null,
            scoreUpdatedAt: null,
            lastReturnPercent: null
        });

        return profile;
    }

    /**
     * Update existing profile fields
     * Supports partial updates, validates input
     */
    static async updateProfile(profileKey: string, data: UpdateProfileRequest): Promise<SocialProfileModel> {
        // Find profile
        const profile = await SocialProfileModel.findOne({
            where: { profileKey }
        });

        if (!profile) {
            throw new Error(`Profile '${profileKey}' not found`);
        }

        // Validate update data
        const validation = this.validateProfileData(data);
        if (!validation.valid) {
            throw new Error(`Validation failed: ${validation.errors.join(', ')}`);
        }

        // Build update object with only provided fields
        const updateData: Partial<{
            displayName: string | null;
            confidence: number | null;
            activity: number;
            description: string | null;
            status: SocialProfileStatus;
        }> = {};

        if (data.displayName !== undefined) {
            updateData.displayName = data.displayName || null;
        }

        if (data.confidence !== undefined) {
            updateData.confidence = data.confidence !== null ? data.confidence : null;
        }

        if (data.activity !== undefined) {
            updateData.activity = Math.trunc(data.activity);
        }

        if (data.description !== undefined) {
            updateData.description = data.description || null;
        }

        if (data.status !== undefined) {
            updateData.status = data.status;
        }

        // Update profile
        await profile.update(updateData);

        return profile;
    }

    /**
     * Toggle profile between active and disabled
     * Active profiles (any status except 'disabled') -> 'disabled'
     * Disabled profiles -> 'configured'
     */
    static async toggleProfile(profileKey: string): Promise<ToggleResult> {
        // Find profile
        const profile = await SocialProfileModel.findOne({
            where: { profileKey }
        });

        if (!profile) {
            throw new Error(`Profile '${profileKey}' not found`);
        }

        const previousStatus = profile.status;
        const newStatus: SocialProfileStatus = previousStatus === 'disabled' ? 'configured' : 'disabled';

        // Update status
        await profile.update({ status: newStatus });

        return {
            profile,
            previousStatus,
            newStatus
        };
    }

    /**
     * Delete profile permanently
     * Returns true if deleted, false if not found
     */
    static async deleteProfile(profileKey: string): Promise<boolean> {
        // Find profile
        const profile = await SocialProfileModel.findOne({
            where: { profileKey }
        });

        if (!profile) {
            throw new Error(`Profile '${profileKey}' not found`);
        }

        // Delete profile (signals are not cascade deleted)
        await profile.destroy();

        return true;
    }

    /**
     * List all profiles with optional filtering
     * Returns profiles ordered by most recently updated
     */
    static async listProfiles(filter?: ProfileFilter): Promise<SocialProfileModel[]> {
        const whereClause: any = {};

        if (filter?.status) {
            whereClause.status = filter.status;
        }

        if (filter?.source) {
            whereClause.source = filter.source;
        }

        const profiles = await SocialProfileModel.findAll({
            where: whereClause,
            order: [['updatedAt', 'DESC']],
            limit: 500
        });

        return profiles;
    }
}
