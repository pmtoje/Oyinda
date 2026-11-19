-- More than one portal user per business: invited by a user with user-management rights.
ALTER TABLE customer_user
  ADD COLUMN permissions text[] NOT NULL DEFAULT '{SUBMIT_REQUESTS,RESPOND_TO_OFFERS,MANAGE_USERS}',
  ADD COLUMN invited_by uuid REFERENCES customer_user(id),
  ADD CONSTRAINT customer_user_permissions CHECK (permissions <@ ARRAY['SUBMIT_REQUESTS','RESPOND_TO_OFFERS','MANAGE_USERS']::text[]);

CREATE TABLE customer_user_invite (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id     uuid NOT NULL REFERENCES customer(id),
  email           text NOT NULL,
  full_name       text NOT NULL,
  role_in_company text NOT NULL,
  permissions     text[] NOT NULL CHECK (permissions <@ ARRAY['SUBMIT_REQUESTS','RESPOND_TO_OFFERS','MANAGE_USERS']::text[]),
  token_hash      text NOT NULL UNIQUE,
  phone           text,
  otp_challenge_id uuid REFERENCES otp_challenge(id),
  expires_at      timestamptz NOT NULL,
  invited_by      uuid NOT NULL REFERENCES customer_user(id),
  accepted_at     timestamptz,
  accepted_user_id uuid REFERENCES customer_user(id),
  revoked_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX customer_user_invite_open ON customer_user_invite(lower(email)) WHERE accepted_at IS NULL AND revoked_at IS NULL;
