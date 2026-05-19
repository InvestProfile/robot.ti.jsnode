import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import http from 'http';
import { startReadOnlyHttpServer } from './readonly-server';
import SocialProfileModel from '../models/social-profile.model';
import DatabaseService from '../services/database.service';

// Helper function to make HTTP requests
const makeRequest = (
    method: string,
    path: string,
    body?: any
): Promise<{ statusCode: number; body: any }> => {
    return new Promise((resolve, reject) => {
        const options = {
            hostname: 'localhost',
            port: 3000,
            path,
            method,
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Basic ' + Buffer.from('robot:test').toString('base64')
            }
        };

        const req = http.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => {
                data += chunk;
            });
            res.on('end', () => {
                try {
                    const parsedBody = data ? JSON.parse(data) : {};
                    resolve({ statusCode: res.statusCode || 500, body: parsedBody });
                } catch (error) {
                    reject(error);
                }
            });
        });

        req.on('error', reject);

        if (body) {
            req.write(JSON.stringify(body));
        }

        req.end();
    });
};

if (process.env.RUN_PROFILE_API_INTEGRATION_TESTS === 'true') describe('Social Profile API Endpoints - Integration Tests', () => {
    let server: http.Server | undefined;
    let testProfileKey: string;

    before(async () => {
        // Set up test environment
        process.env.ROBOT_WEB_PASSWORD = 'test';
        process.env.ROBOT_HTTP_PORT = '3000';
        process.env.ROBOT_HTTP_ENABLED = 'true';

        // Initialize database
        await DatabaseService.init();

        // Clean up any existing test profiles
        await SocialProfileModel.destroy({
            where: {
                profileKey: ['test-profile-api', 'test-profile-create', 'test-profile-update']
            }
        });

        // Start server
        server = startReadOnlyHttpServer();

        // Wait for server to be ready
        await new Promise(resolve => setTimeout(resolve, 1000));
    });

    after(async () => {
        // Clean up test profiles
        await SocialProfileModel.destroy({
            where: {
                profileKey: ['test-profile-api', 'test-profile-create', 'test-profile-update']
            }
        });

        // Stop server
        if (server) {
            server.close();
        }
    });

    describe('GET /api/social-profiles', () => {
        it('should return list of profiles with summary', async () => {
            const response = await makeRequest('GET', '/api/social-profiles');

            assert.strictEqual(response.statusCode, 200);
            assert.strictEqual(response.body.ok, true);
            assert.ok(Array.isArray(response.body.profiles));
            assert.ok(response.body.summary);
            assert.ok(typeof response.body.summary.total === 'number');
            assert.ok(typeof response.body.summary.active === 'number');
            assert.ok(typeof response.body.summary.disabled === 'number');
            assert.ok(typeof response.body.summary.error === 'number');
        });

        it('should require authentication', async () => {
            const options = {
                hostname: 'localhost',
                port: 3000,
                path: '/api/social-profiles',
                method: 'GET'
            };

            const response = await new Promise<{ statusCode: number }>((resolve) => {
                const req = http.request(options, (res) => {
                    resolve({ statusCode: res.statusCode || 500 });
                });
                req.end();
            });

            assert.strictEqual(response.statusCode, 401);
        });
    });

    describe('POST /api/social-profiles', () => {
        it('should create a new profile with valid data', async () => {
            const response = await makeRequest('POST', '/api/social-profiles', {
                profileUrl: 'https://example.com/test-profile-create',
                displayName: 'Test Profile',
                confidence: 75,
                activity: 2,
                description: 'Test description'
            });

            assert.strictEqual(response.statusCode, 200);
            assert.strictEqual(response.body.ok, true);
            assert.ok(response.body.profile);
            assert.strictEqual(response.body.profile.profileKey, 'test-profile-create');
            assert.strictEqual(response.body.profile.displayName, 'Test Profile');
            assert.strictEqual(response.body.profile.confidence, 75);
            assert.strictEqual(response.body.profile.activity, 2);
            assert.strictEqual(response.body.profile.description, 'Test description');
            assert.strictEqual(response.body.profile.status, 'configured');

            testProfileKey = response.body.profile.profileKey;
        });

        it('should reject duplicate profile', async () => {
            // Create first profile
            await makeRequest('POST', '/api/social-profiles', {
                profileUrl: 'https://example.com/test-profile-api'
            });

            // Try to create duplicate
            const response = await makeRequest('POST', '/api/social-profiles', {
                profileUrl: 'https://example.com/test-profile-api'
            });

            assert.strictEqual(response.statusCode, 409);
            assert.strictEqual(response.body.ok, false);
            assert.ok(response.body.error.includes('already exists'));
        });

        it('should reject invalid URL', async () => {
            const response = await makeRequest('POST', '/api/social-profiles', {
                profileUrl: 'not-a-valid-url'
            });

            assert.strictEqual(response.statusCode, 400);
            assert.strictEqual(response.body.ok, false);
            assert.ok(response.body.error.includes('Validation failed'));
        });

        it('should reject missing URL', async () => {
            const response = await makeRequest('POST', '/api/social-profiles', {
                displayName: 'Test'
            });

            assert.strictEqual(response.statusCode, 400);
            assert.strictEqual(response.body.ok, false);
        });

        it('should reject invalid confidence value', async () => {
            const response = await makeRequest('POST', '/api/social-profiles', {
                profileUrl: 'https://example.com/test',
                confidence: 150
            });

            assert.strictEqual(response.statusCode, 400);
            assert.strictEqual(response.body.ok, false);
            assert.ok(response.body.error.includes('between 0 and 100'));
        });

        it('should reject invalid activity value', async () => {
            const response = await makeRequest('POST', '/api/social-profiles', {
                profileUrl: 'https://example.com/test',
                activity: 0
            });

            assert.strictEqual(response.statusCode, 400);
            assert.strictEqual(response.body.ok, false);
            assert.ok(response.body.error.includes('at least 1'));
        });
    });

    describe('PUT /api/social-profiles/:profileKey', () => {
        it('should update profile fields', async () => {
            const response = await makeRequest('PUT', `/api/social-profiles/${testProfileKey}`, {
                displayName: 'Updated Name',
                confidence: 90,
                activity: 3,
                description: 'Updated description'
            });

            assert.strictEqual(response.statusCode, 200);
            assert.strictEqual(response.body.ok, true);
            assert.strictEqual(response.body.profile.displayName, 'Updated Name');
            assert.strictEqual(response.body.profile.confidence, 90);
            assert.strictEqual(response.body.profile.activity, 3);
            assert.strictEqual(response.body.profile.description, 'Updated description');
        });

        it('should return 404 for non-existent profile', async () => {
            const response = await makeRequest('PUT', '/api/social-profiles/non-existent-profile', {
                displayName: 'Test'
            });

            assert.strictEqual(response.statusCode, 404);
            assert.strictEqual(response.body.ok, false);
            assert.ok(response.body.error.includes('not found'));
        });

        it('should reject invalid confidence value', async () => {
            const response = await makeRequest('PUT', `/api/social-profiles/${testProfileKey}`, {
                confidence: -10
            });

            assert.strictEqual(response.statusCode, 400);
            assert.strictEqual(response.body.ok, false);
        });
    });

    describe('POST /api/social-profiles/:profileKey/toggle', () => {
        it('should toggle profile from active to disabled', async () => {
            const response = await makeRequest('POST', `/api/social-profiles/${testProfileKey}/toggle`);

            assert.strictEqual(response.statusCode, 200);
            assert.strictEqual(response.body.ok, true);
            assert.strictEqual(response.body.previousStatus, 'configured');
            assert.strictEqual(response.body.newStatus, 'disabled');
            assert.strictEqual(response.body.profile.status, 'disabled');
        });

        it('should toggle profile from disabled to configured', async () => {
            const response = await makeRequest('POST', `/api/social-profiles/${testProfileKey}/toggle`);

            assert.strictEqual(response.statusCode, 200);
            assert.strictEqual(response.body.ok, true);
            assert.strictEqual(response.body.previousStatus, 'disabled');
            assert.strictEqual(response.body.newStatus, 'configured');
            assert.strictEqual(response.body.profile.status, 'configured');
        });

        it('should return 404 for non-existent profile', async () => {
            const response = await makeRequest('POST', '/api/social-profiles/non-existent-profile/toggle');

            assert.strictEqual(response.statusCode, 404);
            assert.strictEqual(response.body.ok, false);
            assert.ok(response.body.error.includes('not found'));
        });
    });

    describe('DELETE /api/social-profiles/:profileKey', () => {
        it('should delete profile', async () => {
            const response = await makeRequest('DELETE', `/api/social-profiles/${testProfileKey}`);

            assert.strictEqual(response.statusCode, 200);
            assert.strictEqual(response.body.ok, true);
            assert.strictEqual(response.body.deleted, true);

            // Verify profile is deleted
            const profile = await SocialProfileModel.findOne({
                where: { profileKey: testProfileKey }
            });
            assert.strictEqual(profile, null);
        });

        it('should return 404 for non-existent profile', async () => {
            const response = await makeRequest('DELETE', '/api/social-profiles/non-existent-profile');

            assert.strictEqual(response.statusCode, 404);
            assert.strictEqual(response.body.ok, false);
            assert.ok(response.body.error.includes('not found'));
        });
    });
});
