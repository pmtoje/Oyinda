-- Gazelle by Alternative Bank — core platform schema
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- Generic helpers
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION gz_touch_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END $$;

-- Raises on UPDATE/DELETE for insert-only (immutable) tables.
CREATE OR REPLACE FUNCTION gz_forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'GZ_IMMUTABLE: % on % is not permitted; record a new version instead', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END $$;

-- Human-readable reference counters (GZ-FAC-2026-000001 etc.)
CREATE TABLE id_counter (
  scope       text    NOT NULL,
  period      text    NOT NULL,
  value       bigint  NOT NULL DEFAULT 0,
  PRIMARY KEY (scope, period)
);

-- ---------------------------------------------------------------------------
-- Organisation reference data
-- ---------------------------------------------------------------------------
CREATE TABLE directorate (
  code        text PRIMARY KEY,
  name        text NOT NULL,
  active      boolean NOT NULL DEFAULT true
);

CREATE TABLE business_unit (
  code             text PRIMARY KEY,
  name             text NOT NULL,
  directorate_code text NOT NULL REFERENCES directorate(code),
  active           boolean NOT NULL DEFAULT true
);

CREATE TABLE sector (
  code         text PRIMARY KEY,
  name         text NOT NULL,
  parent_code  text REFERENCES sector(code),
  active       boolean NOT NULL DEFAULT true
);

-- ---------------------------------------------------------------------------
-- Staff identity and access
-- ---------------------------------------------------------------------------
CREATE TABLE role (
  code         text PRIMARY KEY,
  name         text NOT NULL,
  description  text NOT NULL DEFAULT '',
  is_privileged boolean NOT NULL DEFAULT false
);

CREATE TABLE permission (
  code         text PRIMARY KEY,
  description  text NOT NULL
);

CREATE TABLE role_permission (
  role_code        text NOT NULL REFERENCES role(code) ON DELETE CASCADE,
  permission_code  text NOT NULL REFERENCES permission(code) ON DELETE CASCADE,
  PRIMARY KEY (role_code, permission_code)
);

CREATE TABLE app_user (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ad_username        text NOT NULL UNIQUE,
  display_name       text NOT NULL,
  email              text NOT NULL UNIQUE,
  phone              text,
  staff_number       text UNIQUE,
  directorate_code   text REFERENCES directorate(code),
  business_unit_code text REFERENCES business_unit(code),
  status             text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE','SUSPENDED')),
  mfa_secret_enc     text,
  mfa_enrolled_at    timestamptz,
  failed_login_count integer NOT NULL DEFAULT 0,
  locked_until       timestamptz,
  last_login_at      timestamptz,
  is_demo            boolean NOT NULL DEFAULT false,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER app_user_touch BEFORE UPDATE ON app_user FOR EACH ROW EXECUTE FUNCTION gz_touch_updated_at();

CREATE TABLE user_role (
  user_id     uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  role_code   text NOT NULL REFERENCES role(code),
  granted_by  uuid REFERENCES app_user(id),
  granted_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, role_code)
);

CREATE TABLE user_sector (
  user_id     uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  sector_code text NOT NULL REFERENCES sector(code),
  PRIMARY KEY (user_id, sector_code)
);

-- Personal approval limit (minor units, NGN). Overrides the level limit downward.
CREATE TABLE user_approval_limit (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  role_code     text NOT NULL REFERENCES role(code),
  limit_minor   bigint NOT NULL CHECK (limit_minor >= 0),
  effective_from timestamptz NOT NULL DEFAULT now(),
  effective_to  timestamptz,
  set_by        uuid REFERENCES app_user(id),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX user_approval_limit_user ON user_approval_limit(user_id, role_code);

-- Delegated authority (time-bound, approved)
CREATE TABLE delegation (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  from_user_id  uuid NOT NULL REFERENCES app_user(id),
  to_user_id    uuid NOT NULL REFERENCES app_user(id),
  role_code     text NOT NULL REFERENCES role(code),
  starts_at     timestamptz NOT NULL,
  ends_at       timestamptz NOT NULL,
  reason        text NOT NULL,
  status        text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','ACTIVE','REVOKED','REJECTED')),
  created_by    uuid NOT NULL REFERENCES app_user(id),
  approved_by   uuid REFERENCES app_user(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at),
  CHECK (from_user_id <> to_user_id)
);

-- ---------------------------------------------------------------------------
-- Sessions, OTP, login attempts (customers and staff)
-- ---------------------------------------------------------------------------
CREATE TABLE auth_session (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash      text NOT NULL UNIQUE,
  csrf_hash       text NOT NULL,
  subject_type    text NOT NULL CHECK (subject_type IN ('CUSTOMER','STAFF')),
  subject_id      uuid NOT NULL,
  mfa_satisfied   boolean NOT NULL DEFAULT false,
  ip              inet,
  user_agent      text,
  device_label    text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  last_seen_at    timestamptz NOT NULL DEFAULT now(),
  idle_expires_at timestamptz NOT NULL,
  absolute_expires_at timestamptz NOT NULL,
  revoked_at      timestamptz,
  revoked_reason  text
);
CREATE INDEX auth_session_subject ON auth_session(subject_type, subject_id) WHERE revoked_at IS NULL;

CREATE TABLE otp_challenge (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purpose         text NOT NULL CHECK (purpose IN ('ONBOARDING','LOGIN','EMAIL_VERIFY','PHONE_VERIFY','STEP_UP')),
  subject_key     text NOT NULL,          -- hashed lookup key (never the raw account number)
  channel         text NOT NULL CHECK (channel IN ('SMS','EMAIL')),
  destination_masked text NOT NULL,
  code_hash       text NOT NULL,
  attempts        integer NOT NULL DEFAULT 0,
  max_attempts    integer NOT NULL,
  expires_at      timestamptz NOT NULL,
  consumed_at     timestamptz,
  invalidated_at  timestamptz,
  created_ip      inet,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX otp_challenge_subject ON otp_challenge(subject_key, purpose, created_at DESC);

CREATE TABLE auth_attempt (
  id           bigserial PRIMARY KEY,
  subject_key  text NOT NULL,
  kind         text NOT NULL,
  ip           inet,
  success      boolean NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auth_attempt_lookup ON auth_attempt(subject_key, kind, created_at DESC);

-- ---------------------------------------------------------------------------
-- Versioned configuration store with maker-checker
-- ---------------------------------------------------------------------------
CREATE TABLE config_item (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind            text NOT NULL,
  key             text NOT NULL,
  version         integer NOT NULL CHECK (version > 0),
  status          text NOT NULL CHECK (status IN ('DRAFT','PENDING_APPROVAL','ACTIVE','RETIRED','REJECTED')),
  title           text NOT NULL,
  payload         jsonb NOT NULL,
  effective_from  timestamptz,
  effective_to    timestamptz,
  change_reason   text NOT NULL,
  created_by      uuid REFERENCES app_user(id),
  submitted_at    timestamptz,
  approved_by     uuid REFERENCES app_user(id),
  approved_at     timestamptz,
  activated_at    timestamptz,
  deactivated_at  timestamptz,
  rejected_reason text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kind, key, version),
  CHECK (approved_by IS NULL OR created_by IS NULL OR approved_by <> created_by)
);
CREATE INDEX config_item_active ON config_item(kind, status, effective_from);
-- Only one ACTIVE version of a key without an end date at a time
CREATE UNIQUE INDEX config_item_one_open_active ON config_item(kind, key) WHERE status = 'ACTIVE' AND effective_to IS NULL;

-- Approved payloads must not change. Status/lifecycle columns may.
CREATE OR REPLACE FUNCTION gz_config_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND OLD.status NOT IN ('DRAFT','REJECTED') THEN
    RAISE EXCEPTION 'GZ_IMMUTABLE: approved configuration cannot be deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.status NOT IN ('DRAFT') AND
     (NEW.payload IS DISTINCT FROM OLD.payload OR NEW.key IS DISTINCT FROM OLD.key OR NEW.kind IS DISTINCT FROM OLD.kind OR NEW.version IS DISTINCT FROM OLD.version) THEN
    RAISE EXCEPTION 'GZ_IMMUTABLE: configuration content is frozen once submitted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER config_item_guard BEFORE UPDATE OR DELETE ON config_item FOR EACH ROW EXECUTE FUNCTION gz_config_guard();

-- ---------------------------------------------------------------------------
-- Background jobs (transactional outbox / queue)
-- ---------------------------------------------------------------------------
CREATE TABLE job (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  queue           text NOT NULL,
  payload         jsonb NOT NULL DEFAULT '{}'::jsonb,
  status          text NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED','RUNNING','DONE','FAILED','DEAD')),
  attempts        integer NOT NULL DEFAULT 0,
  max_attempts    integer NOT NULL DEFAULT 5,
  run_after       timestamptz NOT NULL DEFAULT now(),
  locked_at       timestamptz,
  locked_by       text,
  last_error      text,
  idempotency_key text UNIQUE,
  result          jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  finished_at     timestamptz
);
CREATE INDEX job_ready ON job(queue, run_after) WHERE status IN ('QUEUED','FAILED');

-- ---------------------------------------------------------------------------
-- Notifications
-- ---------------------------------------------------------------------------
CREATE TABLE notification (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient_type  text NOT NULL CHECK (recipient_type IN ('CUSTOMER','STAFF')),
  recipient_id    uuid NOT NULL,
  event_code      text NOT NULL,
  title           text NOT NULL,
  body            text NOT NULL,
  link            text,
  facility_id     uuid,
  task_id         uuid,
  severity        text NOT NULL DEFAULT 'INFO' CHECK (severity IN ('INFO','ACTION','WARNING','CRITICAL')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  read_at         timestamptz
);
CREATE INDEX notification_recipient ON notification(recipient_type, recipient_id, created_at DESC);

CREATE TABLE notification_delivery (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  notification_id uuid NOT NULL REFERENCES notification(id) ON DELETE CASCADE,
  channel         text NOT NULL CHECK (channel IN ('IN_APP','EMAIL','SMS')),
  destination_masked text,
  status          text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','SENT','FAILED','SKIPPED')),
  provider        text,
  provider_ref    text,
  attempts        integer NOT NULL DEFAULT 0,
  last_error      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  sent_at         timestamptz
);

-- Sink for the MOCK email/SMS providers in non-production environments only.
CREATE TABLE mock_outbox (
  id            bigserial PRIMARY KEY,
  channel       text NOT NULL,
  destination   text NOT NULL,
  subject       text,
  body          text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Tamper-resistant, hash-chained audit log
-- ---------------------------------------------------------------------------
CREATE TABLE audit_log (
  id           bigserial PRIMARY KEY,
  occurred_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
  actor_type   text NOT NULL CHECK (actor_type IN ('CUSTOMER','STAFF','SYSTEM','ANONYMOUS')),
  actor_id     uuid,
  actor_label  text,
  action       text NOT NULL,
  entity_type  text NOT NULL,
  entity_id    text,
  facility_id  uuid,
  customer_id  uuid,
  outcome      text NOT NULL DEFAULT 'SUCCESS' CHECK (outcome IN ('SUCCESS','FAILURE','DENIED')),
  ip           inet,
  user_agent   text,
  request_id   text,
  before_data  jsonb,
  after_data   jsonb,
  metadata     jsonb,
  prev_hash    text NOT NULL,
  hash         text NOT NULL
);
CREATE INDEX audit_log_entity ON audit_log(entity_type, entity_id);
CREATE INDEX audit_log_facility ON audit_log(facility_id, occurred_at);
CREATE INDEX audit_log_actor ON audit_log(actor_type, actor_id, occurred_at);

CREATE OR REPLACE FUNCTION gz_audit_chain() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE last_hash text;
BEGIN
  -- Serialise chain extension so concurrent writers cannot fork the chain.
  PERFORM pg_advisory_xact_lock(7340001);
  SELECT hash INTO last_hash FROM audit_log ORDER BY id DESC LIMIT 1;
  NEW.prev_hash := COALESCE(last_hash, 'GENESIS');
  NEW.hash := encode(digest(
      NEW.prev_hash || '|' || NEW.id::text || '|' || to_char(NEW.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') || '|' ||
      NEW.actor_type || '|' || COALESCE(NEW.actor_id::text,'') || '|' || NEW.action || '|' || NEW.entity_type || '|' ||
      COALESCE(NEW.entity_id,'') || '|' || COALESCE(NEW.facility_id::text,'') || '|' || NEW.outcome || '|' ||
      COALESCE(NEW.before_data::text,'') || '|' || COALESCE(NEW.after_data::text,'') || '|' || COALESCE(NEW.metadata::text,''),
    'sha256'), 'hex');
  RETURN NEW;
END $$;
CREATE TRIGGER audit_log_chain BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION gz_audit_chain();
CREATE TRIGGER audit_log_immutable BEFORE UPDATE OR DELETE ON audit_log FOR EACH ROW EXECUTE FUNCTION gz_forbid_mutation();
-- TRUNCATE bypasses row triggers; block it explicitly.
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit_log FOR EACH STATEMENT EXECUTE FUNCTION gz_forbid_mutation();
