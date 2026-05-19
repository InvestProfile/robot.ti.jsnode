import { describe, it } from 'node:test';
import assert from 'node:assert';
import ProfileManagementService from './profile-management.service';

describe('ProfileManagementService - Unit Tests (No Database)', () => {
    describe('parseProfileUrl', () => {
        it('should extract profile key from URL path', () => {
            const result = ProfileManagementService.parseProfileUrl('https://www.tbank.ru/invest/social/profile/test-user-123');
            assert.strictEqual(result.profileKey, 'test-user-123');
            assert.strictEqual(result.source, 't-pulse');
        });

        it('should extract UID from query parameters', () => {
            const result = ProfileManagementService.parseProfileUrl('https://www.tbank.ru/invest/social/profile/test-user?uid=abc123');
            assert.strictEqual(result.profileKey, 'test-user');
            assert.strictEqual(result.profileUid, 'abc123');
        });

        it('should sanitize profile key to lowercase alphanumeric and dashes', () => {
            const result = ProfileManagementService.parseProfileUrl('https://example.com/Test_User@123!');
            assert.strictEqual(result.profileKey, 'test_user123');
        });

        it('should handle URLs with trailing slashes', () => {
            const result = ProfileManagementService.parseProfileUrl('https://example.com/test-user/');
            assert.strictEqual(result.profileKey, 'test-user');
        });

        it('should trim whitespace from URL', () => {
            const result = ProfileManagementService.parseProfileUrl('  https://example.com/test-user  ');
            assert.strictEqual(result.profileKey, 'test-user');
        });

        it('should handle invalid URLs gracefully', () => {
            const result = ProfileManagementService.parseProfileUrl('not-a-url');
            assert.strictEqual(result.profileKey, 'not-a-url');
            assert.strictEqual(result.source, 't-pulse');
        });

        it('should extract UID from id parameter', () => {
            const result = ProfileManagementService.parseProfileUrl('https://example.com/profile?id=xyz789');
            assert.strictEqual(result.profileUid, 'xyz789');
        });

        it('should use hostname as profile key if path is empty', () => {
            const result = ProfileManagementService.parseProfileUrl('https://example.com');
            assert.strictEqual(result.profileKey, 'example.com');
        });
    });

    describe('validateProfileData', () => {
        it('should validate required profile URL', () => {
            const result = ProfileManagementService.validateProfileData({});
            assert.strictEqual(result.valid, false);
            assert.ok(result.errors.some(e => e.includes('Profile URL is required')));
        });

        it('should validate URL format', () => {
            const result = ProfileManagementService.validateProfileData({
                profileUrl: 'not-a-valid-url'
            });
            assert.strictEqual(result.valid, false);
            assert.ok(result.errors.some(e => e.includes('Invalid profile URL format')));
        });

        it('should validate URL protocol', () => {
            const result = ProfileManagementService.validateProfileData({
                profileUrl: 'ftp://example.com/profile'
            });
            assert.strictEqual(result.valid, false);
            assert.ok(result.errors.some(e => e.includes('HTTP or HTTPS protocol')));
        });

        it('should validate confidence range - too low', () => {
            const result = ProfileManagementService.validateProfileData({
                profileUrl: 'https://example.com/test',
                confidence: -1
            });
            assert.strictEqual(result.valid, false);
            assert.ok(result.errors.some(e => e.includes('between 0 and 100')));
        });

        it('should validate confidence range - too high', () => {
            const result = ProfileManagementService.validateProfileData({
                profileUrl: 'https://example.com/test',
                confidence: 101
            });
            assert.strictEqual(result.valid, false);
            assert.ok(result.errors.some(e => e.includes('between 0 and 100')));
        });

        it('should validate confidence range - boundary values', () => {
            const result1 = ProfileManagementService.validateProfileData({
                profileUrl: 'https://example.com/test',
                confidence: 0
            });
            assert.strictEqual(result1.valid, true);

            const result2 = ProfileManagementService.validateProfileData({
                profileUrl: 'https://example.com/test',
                confidence: 100
            });
            assert.strictEqual(result2.valid, true);
        });

        it('should validate activity minimum', () => {
            const result = ProfileManagementService.validateProfileData({
                profileUrl: 'https://example.com/test',
                activity: 0
            });
            assert.strictEqual(result.valid, false);
            assert.ok(result.errors.some(e => e.includes('at least 1')));
        });

        it('should validate activity is integer', () => {
            const result = ProfileManagementService.validateProfileData({
                profileUrl: 'https://example.com/test',
                activity: 1.5
            });
            assert.strictEqual(result.valid, false);
            assert.ok(result.errors.some(e => e.includes('must be an integer')));
        });

        it('should accept valid data', () => {
            const result = ProfileManagementService.validateProfileData({
                profileUrl: 'https://example.com/test',
                confidence: 50,
                activity: 2
            });
            assert.strictEqual(result.valid, true);
            assert.strictEqual(result.errors.length, 0);
        });

        it('should accept valid data with optional fields omitted', () => {
            const result = ProfileManagementService.validateProfileData({
                profileUrl: 'https://example.com/test'
            });
            assert.strictEqual(result.valid, true);
            assert.strictEqual(result.errors.length, 0);
        });

        it('should validate empty URL string', () => {
            const result = ProfileManagementService.validateProfileData({
                profileUrl: '   '
            });
            assert.strictEqual(result.valid, false);
            assert.ok(result.errors.some(e => e.includes('Profile URL is required')));
        });

        it('should validate confidence is a number', () => {
            const result = ProfileManagementService.validateProfileData({
                profileUrl: 'https://example.com/test',
                confidence: NaN
            });
            assert.strictEqual(result.valid, false);
            assert.ok(result.errors.some(e => e.includes('must be a valid number')));
        });

        it('should validate activity is a number', () => {
            const result = ProfileManagementService.validateProfileData({
                profileUrl: 'https://example.com/test',
                activity: NaN
            });
            assert.strictEqual(result.valid, false);
            assert.ok(result.errors.some(e => e.includes('must be a valid number')));
        });

        it('should accumulate multiple validation errors', () => {
            const result = ProfileManagementService.validateProfileData({
                profileUrl: 'not-a-url',
                confidence: 150,
                activity: -1
            });
            assert.strictEqual(result.valid, false);
            assert.ok(result.errors.length >= 3);
        });
    });
});

