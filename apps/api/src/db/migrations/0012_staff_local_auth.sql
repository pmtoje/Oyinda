-- Interim staff sign-in (Gazelle password + authenticator) until Active Directory authentication is available.
-- Passwords are only ever set by the staff member through a single-use link sent to their work e-mail.
ALTER TABLE app_user
  ADD COLUMN password_hash text,
  ADD COLUMN password_changed_at timestamptz;

CREATE TABLE staff_credential_token (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES app_user(id),
  purpose     text NOT NULL CHECK (purpose IN ('ACTIVATE','RESET')),
  token_hash  text NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  consumed_at timestamptz,
  created_by  uuid REFERENCES app_user(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX staff_credential_token_user ON staff_credential_token(user_id, created_at DESC);

CREATE TABLE staff_password_history (
  id          bigserial PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES app_user(id),
  password_hash text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX staff_password_history_user ON staff_password_history(user_id, created_at DESC);
