-- TOTP replay prevention and staff session metadata
ALTER TABLE app_user ADD COLUMN mfa_last_step bigint;
ALTER TABLE app_user ADD COLUMN mfa_pending_secret_enc text;
