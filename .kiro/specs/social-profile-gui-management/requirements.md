# Requirements Document

## Introduction

This document specifies the requirements for a GUI-based social profile management system for the Tinkoff trading robot. The system replaces manual .env file editing with a web-based interface for managing social trading profiles, eliminating the need for docker-compose restarts when modifying profile configurations.

## Glossary

- **Profile_Manager**: The backend service responsible for profile CRUD operations
- **Profile_API**: The RESTful HTTP API for profile management
- **Profile_UI**: The React-based user interface for profile management
- **Social_Collector**: The existing service that collects trading signals from social profiles
- **Profile_Key**: A unique identifier derived from the profile URL
- **Active_Profile**: A profile with status other than 'disabled' that will be processed by Social_Collector
- **Disabled_Profile**: A profile with status 'disabled' that will be skipped by Social_Collector

## Requirements

### Requirement 1: Profile Creation

**User Story:** As a trading robot operator, I want to add new social profiles through a web interface, so that I can expand my signal sources without editing configuration files.

#### Acceptance Criteria

1. WHEN a user submits a valid profile URL, THE Profile_Manager SHALL create a new profile record in the database
2. WHEN a profile URL is provided, THE Profile_Manager SHALL automatically parse and extract the profile key from the URL
3. WHEN optional fields are provided (displayName, confidence, activity, description), THE Profile_Manager SHALL store them with the profile
4. WHEN optional fields are omitted, THE Profile_Manager SHALL use default values (activity=1, status='configured')
5. IF a profile with the same profile key already exists, THEN THE Profile_Manager SHALL return an error and prevent duplicate creation
6. WHEN a profile is created, THE Profile_API SHALL return the complete profile object including auto-generated fields
7. THE Profile_Manager SHALL validate that confidence values are between 0 and 100 if provided
8. THE Profile_Manager SHALL validate that activity values are at least 1
9. WHEN an invalid URL format is provided, THE Profile_Manager SHALL return a descriptive error message

### Requirement 2: Profile Listing

**User Story:** As a trading robot operator, I want to view all configured social profiles in a table, so that I can monitor their status and performance.

#### Acceptance Criteria

1. WHEN the profile list is requested, THE Profile_API SHALL return all profiles ordered by most recently updated
2. THE Profile_UI SHALL display profiles in a table with columns for display name, URL, status, confidence, activity, followers count, and signals count
3. WHEN a profile has status 'disabled', THE Profile_UI SHALL visually distinguish it from active profiles
4. WHEN a profile has status 'error', THE Profile_UI SHALL display the error message
5. THE Profile_UI SHALL show the last checked timestamp for each profile
6. THE Profile_API SHALL include a summary with total, active, disabled, and error profile counts

### Requirement 3: Profile Editing

**User Story:** As a trading robot operator, I want to edit profile fields through the web interface, so that I can adjust signal weights and metadata without restarting the robot.

#### Acceptance Criteria

1. WHEN a user updates a profile, THE Profile_Manager SHALL modify only the specified fields
2. THE Profile_Manager SHALL allow updating displayName, confidence, activity, description, and status fields
3. THE Profile_Manager SHALL prevent modification of profileKey, profileUrl, and profileUid fields
4. WHEN confidence is updated, THE Profile_Manager SHALL validate it is between 0 and 100
5. WHEN activity is updated, THE Profile_Manager SHALL validate it is at least 1
6. IF the profile does not exist, THEN THE Profile_Manager SHALL return a 404 error
7. WHEN a profile is updated, THE Profile_API SHALL return the updated profile object
8. THE Profile_Manager SHALL update the updatedAt timestamp automatically

### Requirement 4: Profile Enable/Disable Toggle

**User Story:** As a trading robot operator, I want to temporarily disable profiles without deleting them, so that I can pause signal collection from underperforming sources.

#### Acceptance Criteria

1. WHEN a user toggles an active profile, THE Profile_Manager SHALL set its status to 'disabled'
2. WHEN a user toggles a disabled profile, THE Profile_Manager SHALL set its status to 'configured'
3. THE Profile_API SHALL return both the previous and new status values after toggle
4. WHEN a profile is disabled, THE Social_Collector SHALL skip it during the next collection cycle
5. WHEN a profile is re-enabled, THE Social_Collector SHALL include it in the next collection cycle
6. THE Profile_UI SHALL provide a clear toggle button or switch for each profile

### Requirement 5: Profile Deletion

**User Story:** As a trading robot operator, I want to permanently delete profiles, so that I can remove profiles that are no longer useful.

#### Acceptance Criteria

1. WHEN a user deletes a profile, THE Profile_Manager SHALL remove it permanently from the database
2. THE Profile_UI SHALL require confirmation before deleting a profile
3. IF the profile does not exist, THEN THE Profile_Manager SHALL return a 404 error
4. WHEN a profile is deleted, THE Profile_API SHALL return a success confirmation
5. THE Profile_Manager SHALL not cascade delete related signals (signals remain for historical analysis)

### Requirement 6: Database as Single Source of Truth

**User Story:** As a trading robot operator, I want profile configuration stored in the database, so that I don't need to edit .env files or restart the robot.

#### Acceptance Criteria

1. THE Social_Collector SHALL read active profiles directly from the database
2. THE Social_Collector SHALL filter profiles to include only those with status other than 'disabled'
3. WHERE ROBOT_SOCIAL_PROFILE_URLS is set in .env, THE system SHALL log a deprecation warning
4. THE Social_Collector SHALL not use ROBOT_SOCIAL_PROFILE_URLS for profile configuration
5. WHEN profiles are modified via the GUI, THE changes SHALL take effect on the next collection cycle without robot restart

### Requirement 7: URL Parsing and Validation

**User Story:** As a trading robot operator, I want the system to automatically extract profile information from URLs, so that I can quickly add profiles with minimal manual input.

#### Acceptance Criteria

1. WHEN a profile URL is provided, THE Profile_Manager SHALL extract the profile key from the URL path
2. WHEN a profile URL contains a UID parameter, THE Profile_Manager SHALL extract and store it
3. THE Profile_Manager SHALL validate that the URL is a valid HTTP or HTTPS URL
4. THE Profile_Manager SHALL normalize URLs by trimming whitespace
5. IF URL parsing fails, THEN THE Profile_Manager SHALL return a descriptive error message
6. THE Profile_Manager SHALL generate a profile key by sanitizing the extracted value (lowercase, alphanumeric and dashes only)

### Requirement 8: API Authentication and Authorization

**User Story:** As a system administrator, I want profile management endpoints to be protected, so that unauthorized users cannot modify trading configuration.

#### Acceptance Criteria

1. THE Profile_API SHALL require HTTP Basic Authentication for all profile management endpoints
2. THE Profile_API SHALL use the same credentials as the existing dashboard (ROBOT_WEB_USERNAME and ROBOT_WEB_PASSWORD)
3. WHEN authentication fails, THE Profile_API SHALL return a 401 Unauthorized response
4. THE Profile_API SHALL not expose sensitive information in error messages

### Requirement 9: Error Handling and User Feedback

**User Story:** As a trading robot operator, I want clear error messages when operations fail, so that I can understand and correct issues.

#### Acceptance Criteria

1. WHEN a validation error occurs, THE Profile_API SHALL return a 400 Bad Request with specific field errors
2. WHEN a profile is not found, THE Profile_API SHALL return a 404 Not Found with the profile key
3. WHEN a duplicate profile is detected, THE Profile_API SHALL return a 409 Conflict with the existing profile key
4. WHEN a database error occurs, THE Profile_API SHALL return a 503 Service Unavailable and log the detailed error
5. THE Profile_UI SHALL display error messages to the user in a prominent, readable format
6. THE Profile_UI SHALL clear error messages when the user retries the operation

### Requirement 10: Profile Statistics Display

**User Story:** As a trading robot operator, I want to see profile statistics in the UI, so that I can evaluate profile performance.

#### Acceptance Criteria

1. THE Profile_UI SHALL display followers count for each profile
2. THE Profile_UI SHALL display recent signals count (total, buy, sell) for each profile
3. THE Profile_UI SHALL display the last return percent for each profile
4. THE Profile_UI SHALL display the last checked timestamp for each profile
5. WHEN statistics are not yet available, THE Profile_UI SHALL display a placeholder (e.g., "—")

### Requirement 11: Optimistic UI Updates

**User Story:** As a trading robot operator, I want the UI to feel responsive, so that I can work efficiently without waiting for server responses.

#### Acceptance Criteria

1. WHEN a user toggles a profile, THE Profile_UI SHALL immediately update the visual state before the API response
2. WHEN a user deletes a profile, THE Profile_UI SHALL immediately remove it from the table before the API response
3. IF an optimistic update fails, THEN THE Profile_UI SHALL revert the change and display an error message
4. THE Profile_UI SHALL show a loading indicator during API requests

### Requirement 12: Form Validation

**User Story:** As a trading robot operator, I want the UI to validate my input before submission, so that I can correct errors immediately.

#### Acceptance Criteria

1. THE Profile_UI SHALL validate that profile URL is not empty before submission
2. THE Profile_UI SHALL validate that confidence is between 0 and 100 if provided
3. THE Profile_UI SHALL validate that activity is at least 1 if provided
4. THE Profile_UI SHALL display validation errors inline next to the relevant field
5. THE Profile_UI SHALL disable the submit button when validation errors exist

### Requirement 13: Backward Compatibility During Migration

**User Story:** As a system administrator, I want the system to support both .env and database configuration during migration, so that I can transition gradually.

#### Acceptance Criteria

1. WHERE ROBOT_SOCIAL_PROFILE_URLS is set, THE system SHALL log a deprecation warning on startup
2. THE system SHALL prioritize database profiles over .env profiles when both exist
3. THE system SHALL provide documentation for migrating .env profiles to the database
4. THE system SHALL not break existing functionality when ROBOT_SOCIAL_PROFILE_URLS is removed

### Requirement 14: No Schema Changes Required

**User Story:** As a system administrator, I want to use the existing database schema, so that I don't need to run migrations or risk data loss.

#### Acceptance Criteria

1. THE Profile_Manager SHALL use the existing SocialProfileModel without schema modifications
2. THE Profile_Manager SHALL use the existing 'status' field to implement enable/disable functionality
3. THE Profile_Manager SHALL use 'disabled' as the status value for disabled profiles
4. THE Profile_Manager SHALL treat all status values except 'disabled' as active profiles

### Requirement 15: Collection Cycle Integration

**User Story:** As a trading robot operator, I want profile changes to take effect automatically, so that I don't need to manually trigger collection.

#### Acceptance Criteria

1. WHEN the Social_Collector runs its collection cycle, THE Social_Collector SHALL query the database for active profiles
2. THE Social_Collector SHALL skip profiles with status 'disabled'
3. THE Social_Collector SHALL include profiles with status 'configured', 'pending-auth', 'ready', 'below-threshold', or 'error'
4. THE Social_Collector SHALL update profile statistics after each collection
5. THE Social_Collector SHALL update the lastCheckedAt timestamp for each processed profile
