-- Generated documents, approved terms, offers, negotiation, conditions, servicing, monitoring, AI

CREATE TABLE generated_document (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  facility_id       uuid NOT NULL REFERENCES facility_request(id),
  kind              text NOT NULL CHECK (kind IN ('CREDIT_MEMO','TERM_SHEET','OFFER_LETTER','EXECUTIVE_SUMMARY')),
  version_no        integer NOT NULL,
  template_config_id uuid REFERENCES config_item(id),
  content           jsonb NOT NULL,
  rendered_document_id uuid REFERENCES document(id),
  rendered_version_id uuid REFERENCES document_version(id),
  based_on_version  integer,
  edit_reason       text,
  generated_by_type text NOT NULL,
  generated_by_id   uuid,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (facility_id, kind, version_no)
);
CREATE TRIGGER generated_document_immutable BEFORE UPDATE OR DELETE ON generated_document FOR EACH ROW EXECUTE FUNCTION gz_forbid_mutation();

-- Approved terms: never overwritten; renegotiation produces a new version.
CREATE TABLE approved_terms (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  facility_id       uuid NOT NULL REFERENCES facility_request(id),
  version_no        integer NOT NULL,
  source            text NOT NULL CHECK (source IN ('CREDIT_APPROVAL','NEGOTIATION_APPROVAL')),
  source_action_id  uuid REFERENCES workflow_action(id),
  product_code      text NOT NULL,
  currency          text NOT NULL,
  amount_minor      bigint NOT NULL CHECK (amount_minor > 0),
  tenor_months      integer NOT NULL CHECK (tenor_months > 0),
  profit_rate_pct   numeric(9,4) NOT NULL CHECK (profit_rate_pct >= 0),
  management_fee_pct numeric(9,4) NOT NULL DEFAULT 0,
  payment_frequency text NOT NULL,
  moratorium_months integer NOT NULL DEFAULT 0,
  security_summary  text NOT NULL,
  conditions        jsonb NOT NULL,
  approved_by_names text[] NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (facility_id, version_no)
);
CREATE TRIGGER approved_terms_immutable BEFORE UPDATE OR DELETE ON approved_terms FOR EACH ROW EXECUTE FUNCTION gz_forbid_mutation();

CREATE TABLE offer_letter (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  facility_id       uuid NOT NULL REFERENCES facility_request(id),
  terms_id          uuid NOT NULL REFERENCES approved_terms(id),
  generated_document_id uuid NOT NULL REFERENCES generated_document(id),
  status            text NOT NULL CHECK (status IN ('PENDING_CHECK','ISSUED','ACCEPTED','REJECTED','NEGOTIATING','SUPERSEDED','EXPIRED','RETURNED_TO_MAKER')),
  maker_id          uuid NOT NULL REFERENCES app_user(id),
  checker_id        uuid REFERENCES app_user(id),
  checked_at        timestamptz,
  issued_at         timestamptz,
  expires_at        timestamptz,
  responded_by      uuid REFERENCES customer_user(id),
  responded_at      timestamptz,
  response_note     text,
  acceptance_ip     inet,
  row_version       integer NOT NULL DEFAULT 1,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (checker_id IS NULL OR checker_id <> maker_id)
);
CREATE UNIQUE INDEX offer_letter_one_live ON offer_letter(facility_id) WHERE status IN ('PENDING_CHECK','ISSUED','NEGOTIATING');

CREATE TABLE negotiation_request (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  facility_id       uuid NOT NULL REFERENCES facility_request(id),
  offer_id          uuid NOT NULL REFERENCES offer_letter(id),
  requested_by      uuid NOT NULL REFERENCES customer_user(id),
  requested_amount_minor bigint,
  requested_tenor_months integer,
  requested_profit_rate_pct numeric(9,4),
  requested_other   text,
  justification     text NOT NULL,
  status            text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','APPROVED','DECLINED')),
  reviewer_id       uuid REFERENCES app_user(id),
  decision_note     text,
  resulting_terms_id uuid REFERENCES approved_terms(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  decided_at        timestamptz
);

CREATE TABLE condition_item (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  facility_id       uuid NOT NULL REFERENCES facility_request(id),
  terms_id          uuid NOT NULL REFERENCES approved_terms(id),
  code              text NOT NULL,
  description       text NOT NULL,
  category          text NOT NULL CHECK (category IN ('PRECEDENT','SUBSEQUENT','COVENANT')),
  owner_team        text NOT NULL CHECK (owner_team IN ('LEGAL','SHARIAH','CREDIT_OPS','CUSTOMER','RM')),
  mandatory         boolean NOT NULL DEFAULT true,
  status            text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','SATISFIED','WAIVED','NOT_APPLICABLE')),
  evidence_document_id uuid REFERENCES document(id),
  frequency         text,
  next_due_date     date,
  actioned_by       uuid REFERENCES app_user(id),
  actioned_at       timestamptz,
  waiver_approved_by uuid REFERENCES app_user(id),
  comment           text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (facility_id, terms_id, code)
);

CREATE TABLE facility_account (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  facility_id       uuid NOT NULL UNIQUE REFERENCES facility_request(id),
  terms_id          uuid NOT NULL REFERENCES approved_terms(id),
  cba_reference     text,
  cba_mode          text NOT NULL CHECK (cba_mode IN ('MOCK','LIVE')),
  currency          text NOT NULL,
  approved_minor    bigint NOT NULL,
  utilised_minor    bigint NOT NULL DEFAULT 0 CHECK (utilised_minor >= 0),
  outstanding_minor bigint NOT NULL DEFAULT 0 CHECK (outstanding_minor >= 0),
  profit_rate_pct   numeric(9,4) NOT NULL,
  tenor_months      integer NOT NULL,
  start_date        date NOT NULL,
  maturity_date     date NOT NULL,
  next_review_date  date,
  status            text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','MATURED','CLOSED','WATCHLIST')),
  activated_by      uuid NOT NULL REFERENCES app_user(id),
  activated_at      timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (utilised_minor <= approved_minor)
);
CREATE TRIGGER facility_account_touch BEFORE UPDATE ON facility_account FOR EACH ROW EXECUTE FUNCTION gz_touch_updated_at();

CREATE TABLE disbursement (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id        uuid NOT NULL REFERENCES facility_account(id),
  facility_id       uuid NOT NULL REFERENCES facility_request(id),
  amount_minor      bigint NOT NULL CHECK (amount_minor > 0),
  beneficiary_account text NOT NULL,
  beneficiary_name  text NOT NULL,
  narrative         text NOT NULL,
  status            text NOT NULL DEFAULT 'PENDING_APPROVAL' CHECK (status IN ('PENDING_APPROVAL','APPROVED','POSTED','FAILED','REJECTED')),
  idempotency_key   text NOT NULL UNIQUE,
  maker_id          uuid NOT NULL REFERENCES app_user(id),
  checker_id        uuid REFERENCES app_user(id),
  cba_reference     text,
  failure_reason    text,
  requested_at      timestamptz NOT NULL DEFAULT now(),
  approved_at       timestamptz,
  posted_at         timestamptz,
  CHECK (checker_id IS NULL OR checker_id <> maker_id)
);

CREATE TABLE payment_schedule_item (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id        uuid NOT NULL REFERENCES facility_account(id),
  seq               integer NOT NULL,
  due_date          date NOT NULL,
  principal_minor   bigint NOT NULL,
  profit_minor      bigint NOT NULL,
  total_minor       bigint NOT NULL,
  paid_minor        bigint NOT NULL DEFAULT 0,
  status            text NOT NULL DEFAULT 'DUE' CHECK (status IN ('DUE','PAID','PARTIAL','OVERDUE')),
  paid_at           timestamptz,
  UNIQUE (account_id, seq)
);

CREATE TABLE facility_payment (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id        uuid NOT NULL REFERENCES facility_account(id),
  amount_minor      bigint NOT NULL CHECK (amount_minor > 0),
  value_date        date NOT NULL,
  reference         text NOT NULL UNIQUE,
  source            text NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER facility_payment_immutable BEFORE UPDATE OR DELETE ON facility_payment FOR EACH ROW EXECUTE FUNCTION gz_forbid_mutation();

CREATE TABLE monitoring_item (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  facility_id       uuid NOT NULL REFERENCES facility_request(id),
  account_id        uuid REFERENCES facility_account(id),
  kind              text NOT NULL CHECK (kind IN ('MATURITY','SECURITY_EXPIRY','REVIEW_DUE','COVENANT_DUE','PAYMENT_OVERDUE','FINANCIALS_REFRESH','EXCEPTION','RENEWAL')),
  ref_id            uuid,
  due_date          date NOT NULL,
  status            text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','RESOLVED')),
  severity          text NOT NULL DEFAULT 'INFO' CHECK (severity IN ('INFO','WARNING','CRITICAL')),
  detail            text NOT NULL,
  resolved_by       uuid REFERENCES app_user(id),
  resolved_at       timestamptz,
  resolution_note   text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (facility_id, kind, ref_id, due_date)
);

-- AI assistance: every interaction is logged with model, sources and human review state
CREATE TABLE ai_interaction (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  use_case          text NOT NULL,
  facility_id       uuid REFERENCES facility_request(id),
  actor_id          uuid REFERENCES app_user(id),
  provider          text NOT NULL,
  model             text NOT NULL,
  model_version     text NOT NULL,
  prompt_template   text NOT NULL,
  prompt_sha256     text NOT NULL,
  sources           jsonb NOT NULL,
  injection_flags   jsonb NOT NULL DEFAULT '[]'::jsonb,
  output            jsonb NOT NULL,
  validation        jsonb NOT NULL,
  review_status     text NOT NULL DEFAULT 'PENDING_REVIEW' CHECK (review_status IN ('PENDING_REVIEW','ACCEPTED','REJECTED','EDITED')),
  reviewed_by       uuid REFERENCES app_user(id),
  reviewed_at       timestamptz,
  review_note       text,
  latency_ms        integer,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ai_interaction_facility ON ai_interaction(facility_id, created_at DESC);
