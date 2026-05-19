# Implementation Plan: Social Profile GUI Management

## Overview

This implementation plan converts the design into discrete coding tasks for building a GUI-based social profile management system. The system will replace manual .env file editing with a web-based CRUD interface, eliminating the need for robot restarts when managing social trading profiles.

The implementation follows a bottom-up approach: starting with the data layer (service), then building the API layer (HTTP endpoints), and finally the presentation layer (React UI). Each major component includes corresponding test tasks to ensure correctness.

## Tasks

- [ ] 1. Create Profile Management Service
  - [ ] 1.1 Implement ProfileManagementService class with core CRUD methods
    - Create `app/services/profile-management.service.ts`
    - Implement `createProfile()` method with URL parsing and validation
    - Implement `updateProfile()` method with partial update support
    - Implement `toggleProfile()` method for enable/disable functionality
    - Implement `deleteProfile()` method
    - Implement `listProfiles()` method with optional filtering
    - Implement `parseProfileUrl()` helper for extracting profileKey and profileUid
    - Implement `validateProfileData()` helper for input validation
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 3.1, 3.2, 4.1, 4.2, 5.1, 7.1, 7.2, 7.6_

  - [ ]* 1.2 Write property tests for ProfileManagementService
    - **Property 1: Profile Creation Stores All Provided Fields**
    - **Property 2: Profile Key Extraction Consistency**
    - **Property 3: Default Values Applied When Fields Omitted**
    - **Property 4: Duplicate Profile Prevention**
    - **Property 6: Confidence Validation Range**
    - **Property 7: Activity Validation Minimum**
    - **Property 11: Partial Update Preservation**
    - **Property 12: Immutable Field Protection**
    - **Property 16: Toggle Status Transition**
    - **Property 21: URL Normalization**
    - **Property 22: URL Protocol Validation**
    - **Property 23: UID Extraction from URL**
    - **Property 29: Disabled Status Value**
    - **Validates: Requirements 1.1, 1.2, 1.3, 1.4, 1.5, 1.7, 1.8, 3.1, 3.3, 4.1, 4.2, 7.1, 7.2, 7.3, 7.4, 7.6, 14.3**

  - [ ]* 1.3 Write unit tests for ProfileManagementService edge cases
    - Test invalid URL formats
    - Test missing required fields
    - Test boundary values for confidence and activity
    - Test profile not found scenarios
    - Test concurrent modification scenarios
    - _Requirements: 1.9, 3.6, 5.3, 7.5_

- [ ] 2. Checkpoint - Verify service layer
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 3. Add Profile Management API Endpoints
  - [ ] 3.1 Implement GET /api/social-profiles endpoint
    - Add route handler in `app/http/readonly-server.ts`
    - Call `ProfileManagementService.listProfiles()`
    - Return profiles with summary (total, active, disabled, error counts)
    - Add authentication check using existing `requireAuth()`
    - _Requirements: 2.1, 2.6, 8.1, 8.2_

  - [ ] 3.2 Implement POST /api/social-profiles endpoint
    - Add route handler for profile creation
    - Parse and validate request body
    - Call `ProfileManagementService.createProfile()`
    - Return created profile or error response
    - Handle validation errors (400), conflicts (409), database errors (503)
    - _Requirements: 1.1, 1.5, 1.6, 8.1, 9.1, 9.3, 9.4_

  - [ ] 3.3 Implement PUT /api/social-profiles/:profileKey endpoint
    - Add route handler for profile updates
    - Parse profileKey from URL params
    - Parse and validate request body
    - Call `ProfileManagementService.updateProfile()`
    - Return updated profile or error response
    - Handle not found (404), validation errors (400)
    - _Requirements: 3.1, 3.2, 3.6, 3.7, 8.1, 9.1, 9.2_

  - [ ] 3.4 Implement POST /api/social-profiles/:profileKey/toggle endpoint
    - Add route handler for toggle operation
    - Parse profileKey from URL params
    - Call `ProfileManagementService.toggleProfile()`
    - Return profile with previous and new status
    - Handle not found (404)
    - _Requirements: 4.1, 4.2, 4.3, 8.1_

  - [ ] 3.5 Implement DELETE /api/social-profiles/:profileKey endpoint
    - Add route handler for profile deletion
    - Parse profileKey from URL params
    - Call `ProfileManagementService.deleteProfile()`
    - Return success confirmation
    - Handle not found (404)
    - _Requirements: 5.1, 5.3, 5.4, 8.1_

  - [ ]* 3.6 Write integration tests for API endpoints
    - Test each endpoint with valid requests
    - Test authentication requirement (401 responses)
    - Test error responses (400, 404, 409, 503)
    - Test request/response formats
    - **Property 5: Profile Creation Response Completeness**
    - **Property 13: Update Response Reflects Changes**
    - **Property 15: Profile Not Found Error**
    - **Property 17: Toggle Response Includes Status Transition**
    - **Property 24: Validation Error Response Format**
    - **Property 25: Not Found Error Includes Profile Key**
    - **Property 26: Conflict Error Includes Existing Key**
    - **Validates: Requirements 1.6, 3.7, 3.6, 4.3, 5.3, 8.1, 8.2, 8.3, 9.1, 9.2, 9.3, 9.4**

- [ ] 4. Checkpoint - Verify API layer
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 5. Modify Social Collector Service
  - [ ] 5.1 Remove .env dependency from SocialCollectorService
    - Remove `parseProfileUrls()` method
    - Remove `syncProfiles()` method
    - Implement `getActiveProfiles()` method to query database for non-disabled profiles
    - Modify `collectOnce()` to use `getActiveProfiles()` instead of .env parsing
    - Add deprecation warning if ROBOT_SOCIAL_PROFILE_URLS is set
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 15.1, 15.2, 15.3_

  - [ ]* 5.2 Write integration tests for modified Social Collector
    - Test that collector reads from database
    - Test that disabled profiles are skipped
    - Test that active profiles (configured, pending-auth, ready, below-threshold, error) are included
    - Test that .env profiles are ignored
    - Test deprecation warning when ROBOT_SOCIAL_PROFILE_URLS is set
    - **Property 20: Active Profile Filtering**
    - **Validates: Requirements 4.4, 4.5, 6.1, 6.2, 6.3, 6.4, 6.5, 15.1, 15.2, 15.3, 15.4, 15.5**

- [ ] 6. Checkpoint - Verify collector integration
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 7. Build React Profile Management UI
  - [ ] 7.1 Create ProfileTable component
    - Add ProfileTable component to `ui/src/main.jsx`
    - Display profiles in table with columns: display name, URL, status, confidence, activity, followers count, signals count
    - Add visual distinction for disabled profiles (different styling)
    - Add action buttons for each profile: Edit, Toggle, Delete
    - Show last checked timestamp
    - Show error messages for profiles with error status
    - _Requirements: 2.2, 2.3, 2.4, 2.5, 4.6_

  - [ ] 7.2 Create AddProfileForm component
    - Add form component with fields: profile URL (required), profile UID (optional), display name (optional), confidence (optional), activity (optional), description (optional)
    - Implement client-side validation: URL not empty, confidence 0-100, activity >= 1
    - Display validation errors inline next to fields
    - Disable submit button when validation errors exist
    - Call POST /api/social-profiles on submit
    - Show loading indicator during submission
    - Display server error messages
    - Clear form after successful submission
    - _Requirements: 12.1, 12.2, 12.3, 12.4, 12.5_

  - [ ] 7.3 Create EditProfileModal component
    - Add modal component with editable fields: display name, confidence, activity, description, status
    - Show read-only fields: profile URL, profile UID, profile key
    - Implement client-side validation (same as AddProfileForm)
    - Call PUT /api/social-profiles/:profileKey on submit
    - Show loading indicator during submission
    - Display server error messages
    - Close modal after successful update
    - _Requirements: 3.1, 3.2, 12.2, 12.3, 12.4, 12.5_

  - [ ] 7.4 Implement SocialProfileManager main component
    - Add SocialProfileManager component to `ui/src/main.jsx`
    - Implement state management for profiles list, loading, editing profile, show add form
    - Implement `loadProfiles()` to fetch from GET /api/social-profiles
    - Implement `handleCreate()` to create profile via AddProfileForm
    - Implement `handleUpdate()` to update profile via EditProfileModal
    - Implement `handleToggle()` with optimistic UI update
    - Implement `handleDelete()` with confirmation dialog and optimistic UI update
    - Handle API errors and revert optimistic updates on failure
    - Refresh profile list after mutations
    - _Requirements: 5.2, 9.5, 9.6, 11.1, 11.2, 11.3, 11.4_

  - [ ] 7.5 Add Social Profiles tab to dashboard
    - Add new tab to tabs array: `{ id: 'social-profiles', label: 'Профили Пульса', icon: Users }`
    - Add 'social-profiles' to endpointGroups mapping
    - Add SocialProfileManager component to tab content rendering
    - Update tab navigation to include social profiles
    - _Requirements: 2.1, 2.2_

  - [ ]* 7.6 Write component tests for UI
    - Test ProfileTable renders all columns
    - Test AddProfileForm validation
    - Test EditProfileModal validation
    - Test SocialProfileManager state management
    - Test optimistic updates and rollback
    - Test error display and clearing
    - **Property 9: Profile List Ordering**
    - **Property 10: Profile List Summary Accuracy**
    - **Property 27: UI Statistics Display Completeness**
    - **Property 28: UI Placeholder for Missing Statistics**
    - **Validates: Requirements 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 9.5, 9.6, 10.1, 10.2, 10.3, 10.4, 10.5, 11.1, 11.2, 11.3, 11.4, 12.1, 12.2, 12.3, 12.4, 12.5**

- [ ] 8. Checkpoint - Verify UI layer
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 9. End-to-End Integration Testing
  - [ ]* 9.1 Write end-to-end integration tests
    - Test complete flow: create profile → verify in database → verify in UI
    - Test complete flow: edit profile → verify changes persisted → verify UI updates
    - Test complete flow: toggle profile → verify status change → verify collector skips disabled
    - Test complete flow: delete profile → verify removal from database → verify UI updates
    - Test that profile changes take effect on next collection cycle without restart
    - Test that signals are preserved when profile is deleted
    - **Property 14: Automatic Timestamp Update**
    - **Property 18: Profile Deletion Removes from Database**
    - **Property 19: Deletion Preserves Related Signals**
    - **Validates: Requirements 3.8, 5.1, 5.5, 6.5, 13.4, 15.4, 15.5**

- [ ] 10. Documentation and Migration
  - [ ] 10.1 Update README with GUI usage instructions
    - Document how to access the Social Profiles tab
    - Document how to add, edit, toggle, and delete profiles
    - Document profile field meanings (confidence, activity, etc.)
    - Document status values and their meanings
    - _Requirements: 13.3_

  - [ ] 10.2 Add deprecation notice for ROBOT_SOCIAL_PROFILE_URLS
    - Update README to mark ROBOT_SOCIAL_PROFILE_URLS as deprecated
    - Document migration path from .env to GUI
    - Provide example migration script
    - _Requirements: 6.3, 13.1, 13.3_

  - [ ] 10.3 Create migration script (optional)
    - Create script to migrate existing .env profiles to database
    - Add instructions for running the migration script
    - _Requirements: 13.3_

- [ ] 11. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties
- Unit tests validate specific examples and edge cases
- Integration tests validate end-to-end flows
- The implementation uses TypeScript for backend and React for frontend
- No database schema changes are required (uses existing SocialProfileModel)
- No robot restart is required for profile changes to take effect
