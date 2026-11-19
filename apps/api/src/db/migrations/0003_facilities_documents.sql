-- Facility origination, eligibility (FIPG) and document management

CREATE TABLE facility_request (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  facility_ref        text NOT NULL UNIQUE CHECK (facility_ref ~ '^GZ-FAC-[0-9]{4}-[0-9]{6}$'),
  customer_id         uuid NOT NULL REFERENCES customer(id),
  product_code        text NOT NULL,
  product_config_id   uuid NOT NULL REFERENCES config_item(id),
  origin              text NOT NULL CHECK (origin IN ('CUSTOMER','RM')),
  status              text NOT NULL DEFAULT 'DRAFT' CHECK (status IN (
                        'DRAFT','SUBMITTED','IN_REVIEW','RETURNED','APPROVED','DECLINED','WITHDRAWN',
                        'OFFER_ISSUED','IN_NEGOTIATION','OFFER_ACCEPTED','OFFER_REJECTED',
                        'FULFILMENT','READY_FOR_ACTIVATION','ACTIVE','CLOSED','CANCELLED')),
  currency            text NOT NULL DEFAULT 'NGN' CHECK (currency ~ '^[A-Z]{3}$'),
  amount_minor        bigint CHECK (amount_minor IS NULL OR amount_minor > 0),
  tenor_months        integer CHECK (tenor_months IS NULL OR (tenor_months > 0 AND tenor_months <= 360)),
  purpose             text,
  payment_structure   text,
  payment_frequency   text CHECK (payment_frequency IS NULL OR payment_frequency IN ('MONTHLY','QUARTERLY','SEMI_ANNUAL','ANNUAL','BULLET')),
  source_of_payment   text,
  supplier_name       text,
  underlying_asset    text,
  project_details     text,
  proposed_security   text,
  product_fields      jsonb NOT NULL DEFAULT '{}'::jsonb,   -- product-specific answers, validated against product config version
  is_contingent       boolean NOT NULL DEFAULT false,
  current_step        text NOT NULL DEFAULT 'PRODUCT',
  completed_steps     text[] NOT NULL DEFAULT '{}',
  initiated_by_type   text NOT NULL CHECK (initiated_by_type IN ('CUSTOMER','STAFF')),
  initiated_by_id     uuid NOT NULL,
  idempotency_key     text NOT NULL,
  profile_version     integer,
  submitted_at        timestamptz,
  decided_at          timestamptz,
  row_version         integer NOT NULL DEFAULT 1,
  is_demo             boolean NOT NULL DEFAULT false,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (customer_id, idempotency_key)
);
CREATE INDEX facility_request_customer ON facility_request(customer_id, created_at DESC);
CREATE INDEX facility_request_status ON facility_request(status);
CREATE TRIGGER facility_request_touch BEFORE UPDATE ON facility_request FOR EACH ROW EXECUTE FUNCTION gz_touch_updated_at();

CREATE TABLE facility_status_history (
  id            bigserial PRIMARY KEY,
  facility_id   uuid NOT NULL REFERENCES facility_request(id),
  from_status   text,
  to_status     text NOT NULL,
  actor_type    text NOT NULL,
  actor_id      uuid,
  reason        text,
  customer_visible_note text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX facility_status_history_facility ON facility_status_history(facility_id, created_at);
CREATE TRIGGER facility_status_history_immutable BEFORE UPDATE OR DELETE ON facility_status_history FOR EACH ROW EXECUTE FUNCTION gz_forbid_mutation();

-- Items flagged when an application is returned, so the customer sees exactly what needs attention
CREATE TABLE rework_item (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  facility_id     uuid NOT NULL REFERENCES facility_request(id),
  task_id         uuid,
  section         text NOT NULL,
  target_ref      text,
  message         text NOT NULL,
  raised_by       uuid NOT NULL REFERENCES app_user(id),
  raised_at       timestamptz NOT NULL DEFAULT now(),
  customer_response text,
  resolved_at     timestamptz,
  resolved_by_type text,
  resolved_by_id  uuid
);
CREATE INDEX rework_item_facility ON rework_item(facility_id) WHERE resolved_at IS NULL;

-- ---------------------------------------------------------------------------
-- FIPG eligibility evaluations (results are immutable; re-evaluation creates a new run)
-- ---------------------------------------------------------------------------
CREATE TABLE eligibility_evaluation (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  facility_id     uuid NOT NULL REFERENCES facility_request(id),
  outcome         text NOT NULL CHECK (outcome IN ('ELIGIBLE','INELIGIBLE','REFER','EXCEPTION_REQUIRED')),
  facts           jsonb NOT NULL,
  evaluated_by_type text NOT NULL,
  evaluated_by_id uuid,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER eligibility_evaluation_immutable BEFORE UPDATE OR DELETE ON eligibility_evaluation FOR EACH ROW EXECUTE FUNCTION gz_forbid_mutation();

CREATE TABLE eligibility_result (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  evaluation_id   uuid NOT NULL REFERENCES eligibility_evaluation(id),
  rule_config_id  uuid NOT NULL REFERENCES config_item(id),
  rule_key        text NOT NULL,
  rule_version    integer NOT NULL,
  applicable      boolean NOT NULL,
  passed          boolean,
  severity        text NOT NULL,
  action          text NOT NULL,
  actual_value    text,
  required_value  text,
  customer_message text,
  internal_message text NOT NULL
);
CREATE TRIGGER eligibility_result_immutable BEFORE UPDATE OR DELETE ON eligibility_result FOR EACH ROW EXECUTE FUNCTION gz_forbid_mutation();

-- ---------------------------------------------------------------------------
-- Documents
-- ---------------------------------------------------------------------------
CREATE TABLE document (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id       uuid NOT NULL REFERENCES customer(id),
  facility_id       uuid REFERENCES facility_request(id),
  requirement_key   text,                 -- document requirement config key, if generated from requirements
  doc_type          text NOT NULL,
  title             text NOT NULL,
  status            text NOT NULL DEFAULT 'REQUIRED' CHECK (status IN ('REQUIRED','UPLOADED','UNDER_REVIEW','VERIFIED','REJECTED','EXPIRED','SUPERSEDED')),
  mandatory         boolean NOT NULL DEFAULT true,
  customer_visible  boolean NOT NULL DEFAULT true,
  current_version_id uuid,
  expiry_date       date,
  reviewed_by       uuid REFERENCES app_user(id),
  reviewed_at       timestamptz,
  rejection_reason  text,
  deleted_at        timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX document_facility ON document(facility_id) WHERE deleted_at IS NULL;
CREATE INDEX document_customer ON document(customer_id) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX document_requirement_unique ON document(facility_id, requirement_key) WHERE requirement_key IS NOT NULL AND deleted_at IS NULL;
CREATE TRIGGER document_touch BEFORE UPDATE ON document FOR EACH ROW EXECUTE FUNCTION gz_touch_updated_at();

CREATE TABLE document_version (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id       uuid NOT NULL REFERENCES document(id),
  version_no        integer NOT NULL,
  original_filename text NOT NULL,
  storage_key       text NOT NULL UNIQUE,     -- random, non-guessable
  size_bytes        bigint NOT NULL CHECK (size_bytes > 0),
  sha256            text NOT NULL,
  declared_mime     text,
  detected_mime     text NOT NULL,
  enc_wrapped_key   text NOT NULL,
  enc_iv            text NOT NULL,
  enc_tag           text NOT NULL,
  enc_key_id        text NOT NULL,
  scan_status       text NOT NULL DEFAULT 'PENDING' CHECK (scan_status IN ('PENDING','CLEAN','INFECTED','ERROR')),
  scan_engine       text,
  scanned_at        timestamptz,
  metadata          jsonb NOT NULL DEFAULT '{}'::jsonb,
  uploaded_by_type  text NOT NULL,
  uploaded_by_id    uuid NOT NULL,
  uploaded_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_id, version_no)
);
CREATE INDEX document_version_sha ON document_version(sha256);
ALTER TABLE document ADD CONSTRAINT document_current_version_fk FOREIGN KEY (current_version_id) REFERENCES document_version(id);

-- Only scan results may change on a version; content is immutable.
CREATE OR REPLACE FUNCTION gz_document_version_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'GZ_IMMUTABLE: document versions cannot be deleted' USING ERRCODE='restrict_violation'; END IF;
  IF NEW.sha256 <> OLD.sha256 OR NEW.storage_key <> OLD.storage_key OR NEW.size_bytes <> OLD.size_bytes
     OR NEW.document_id <> OLD.document_id OR NEW.version_no <> OLD.version_no OR NEW.enc_wrapped_key <> OLD.enc_wrapped_key THEN
    RAISE EXCEPTION 'GZ_IMMUTABLE: document version content cannot change' USING ERRCODE='restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER document_version_guard BEFORE UPDATE OR DELETE ON document_version FOR EACH ROW EXECUTE FUNCTION gz_document_version_guard();

CREATE TABLE document_event (
  id            bigserial PRIMARY KEY,
  document_id   uuid NOT NULL REFERENCES document(id),
  version_id    uuid REFERENCES document_version(id),
  event         text NOT NULL,
  actor_type    text NOT NULL,
  actor_id      uuid,
  note          text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER document_event_immutable BEFORE UPDATE OR DELETE ON document_event FOR EACH ROW EXECUTE FUNCTION gz_forbid_mutation();

-- Single-use, short-lived download grants (in addition to session authorisation)
CREATE TABLE document_access_grant (
  token_hash    text PRIMARY KEY,
  version_id    uuid NOT NULL REFERENCES document_version(id),
  subject_type  text NOT NULL,
  subject_id    uuid NOT NULL,
  disposition   text NOT NULL CHECK (disposition IN ('inline','attachment')),
  expires_at    timestamptz NOT NULL,
  used_at       timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
