-- Financial statements, bank statements, FX, bureau, exposure, collateral, risk, RARORAC, E&S

-- ---------------------------------------------------------------------------
-- FX rates (auditable, insert-only)
-- ---------------------------------------------------------------------------
CREATE TABLE fx_rate (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  base_ccy      text NOT NULL CHECK (base_ccy ~ '^[A-Z]{3}$'),
  quote_ccy     text NOT NULL CHECK (quote_ccy ~ '^[A-Z]{3}$'),
  rate          numeric(20,8) NOT NULL CHECK (rate > 0),
  rate_date     date NOT NULL,
  source        text NOT NULL,
  entered_by    uuid REFERENCES app_user(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (base_ccy, quote_ccy, rate_date, source)
);
CREATE TRIGGER fx_rate_immutable BEFORE UPDATE OR DELETE ON fx_rate FOR EACH ROW EXECUTE FUNCTION gz_forbid_mutation();

-- ---------------------------------------------------------------------------
-- Financial statements
-- ---------------------------------------------------------------------------
CREATE TABLE financial_statement (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id       uuid NOT NULL REFERENCES customer(id),
  statement_type    text NOT NULL CHECK (statement_type IN ('AUDITED','MANAGEMENT','PROJECTED')),
  period_start      date NOT NULL,
  period_end        date NOT NULL,
  months            integer NOT NULL CHECK (months BETWEEN 1 AND 24),
  currency          text NOT NULL DEFAULT 'NGN',
  auditor           text,
  audit_opinion     text CHECK (audit_opinion IS NULL OR audit_opinion IN ('UNQUALIFIED','QUALIFIED','ADVERSE','DISCLAIMER')),
  source_document_id uuid REFERENCES document(id),
  entry_method      text NOT NULL DEFAULT 'MANUAL' CHECK (entry_method IN ('MANUAL','AI_ASSISTED','IMPORT')),
  status            text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','SUBMITTED','VALIDATED','REJECTED')),
  entered_by_type   text NOT NULL,
  entered_by_id     uuid NOT NULL,
  validated_by      uuid REFERENCES app_user(id),
  validated_at      timestamptz,
  deleted_at        timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (period_end > period_start)
);
CREATE UNIQUE INDEX financial_statement_period ON financial_statement(customer_id, statement_type, period_end) WHERE deleted_at IS NULL;
CREATE TRIGGER financial_statement_touch BEFORE UPDATE ON financial_statement FOR EACH ROW EXECUTE FUNCTION gz_touch_updated_at();

CREATE TABLE financial_line_item (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  statement_id     uuid NOT NULL REFERENCES financial_statement(id) ON DELETE CASCADE,
  line_code        text NOT NULL,
  amount_minor     bigint NOT NULL,
  uncertain        boolean NOT NULL DEFAULT false,
  uncertain_reason text,
  source_ref       text,
  UNIQUE (statement_id, line_code)
);

-- A frozen analysis run (ratios + formula versions used)
CREATE TABLE financial_analysis (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  facility_id      uuid NOT NULL REFERENCES facility_request(id),
  statement_ids    uuid[] NOT NULL,
  ratio_config_ids uuid[] NOT NULL,
  summary          jsonb NOT NULL,
  total_score      numeric(10,4),
  run_by           uuid REFERENCES app_user(id),
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER financial_analysis_immutable BEFORE UPDATE OR DELETE ON financial_analysis FOR EACH ROW EXECUTE FUNCTION gz_forbid_mutation();

CREATE TABLE ratio_result (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  analysis_id      uuid NOT NULL REFERENCES financial_analysis(id),
  statement_id     uuid NOT NULL REFERENCES financial_statement(id),
  ratio_key        text NOT NULL,
  ratio_config_id  uuid NOT NULL REFERENCES config_item(id),
  value            numeric(24,8),
  error            text,
  band             text,
  score            numeric(10,4),
  weight           numeric(10,4),
  implication      text
);
CREATE TRIGGER ratio_result_immutable BEFORE UPDATE OR DELETE ON ratio_result FOR EACH ROW EXECUTE FUNCTION gz_forbid_mutation();

-- ---------------------------------------------------------------------------
-- Bank statements
-- ---------------------------------------------------------------------------
CREATE TABLE bank_statement (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id       uuid NOT NULL REFERENCES customer(id),
  facility_id       uuid REFERENCES facility_request(id),
  document_version_id uuid NOT NULL REFERENCES document_version(id),
  bank_name         text NOT NULL,
  is_alternative_bank boolean NOT NULL DEFAULT false,
  account_number    text NOT NULL CHECK (account_number ~ '^[0-9]{10}$'),
  currency          text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  period_start      date NOT NULL,
  period_end        date NOT NULL,
  status            text NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED','PROCESSING','PARSED','NEEDS_REVIEW','VALIDATED','FAILED','DUPLICATE','REJECTED')),
  file_sha256       text NOT NULL,
  detected_account_number text,
  opening_balance_minor bigint,
  closing_balance_minor bigint,
  transaction_count integer,
  uncertain_count   integer NOT NULL DEFAULT 0,
  issues            jsonb NOT NULL DEFAULT '[]'::jsonb,
  parser            text,
  validated_by      uuid REFERENCES app_user(id),
  validated_at      timestamptz,
  uploaded_by_type  text NOT NULL,
  uploaded_by_id    uuid NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (period_end >= period_start)
);
CREATE INDEX bank_statement_customer ON bank_statement(customer_id, account_number);
CREATE TRIGGER bank_statement_touch BEFORE UPDATE ON bank_statement FOR EACH ROW EXECUTE FUNCTION gz_touch_updated_at();

CREATE TABLE bank_transaction (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  statement_id     uuid NOT NULL REFERENCES bank_statement(id) ON DELETE CASCADE,
  line_no          integer NOT NULL,
  txn_date         date,
  value_date       date,
  description_raw  text NOT NULL,
  description_norm text NOT NULL,
  category         text,
  debit_minor      bigint NOT NULL DEFAULT 0 CHECK (debit_minor >= 0),
  credit_minor     bigint NOT NULL DEFAULT 0 CHECK (credit_minor >= 0),
  balance_minor    bigint,
  uncertain        boolean NOT NULL DEFAULT false,
  uncertain_reason text,
  txn_fingerprint  text NOT NULL,
  corrected_by     uuid REFERENCES app_user(id),
  corrected_at     timestamptz,
  UNIQUE (statement_id, line_no)
);
CREATE INDEX bank_transaction_fp ON bank_transaction(txn_fingerprint);

CREATE TABLE statement_analysis (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  facility_id      uuid NOT NULL REFERENCES facility_request(id),
  statement_ids    uuid[] NOT NULL,
  fx_rate_ids      uuid[] NOT NULL DEFAULT '{}',
  reporting_ccy    text NOT NULL DEFAULT 'NGN',
  summary          jsonb NOT NULL,
  monthly          jsonb NOT NULL,
  issues           jsonb NOT NULL,
  run_by_type      text NOT NULL,
  run_by_id        uuid,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER statement_analysis_immutable BEFORE UPDATE OR DELETE ON statement_analysis FOR EACH ROW EXECUTE FUNCTION gz_forbid_mutation();

-- ---------------------------------------------------------------------------
-- Credit bureau checks
-- ---------------------------------------------------------------------------
CREATE TABLE bureau_check (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  facility_id       uuid NOT NULL REFERENCES facility_request(id),
  customer_id       uuid NOT NULL REFERENCES customer(id),
  subject_kind      text NOT NULL CHECK (subject_kind IN ('BUSINESS','INDIVIDUAL')),
  party_id          uuid REFERENCES business_party(id),
  subject_name      text NOT NULL,
  identifier_type   text NOT NULL CHECK (identifier_type IN ('RC','TIN','BVN')),
  identifier_masked text NOT NULL,
  provider          text NOT NULL,
  mode              text NOT NULL CHECK (mode IN ('MOCK','LIVE')),
  status            text NOT NULL CHECK (status IN ('PENDING','COMPLETED','NO_HIT','FAILED')),
  provider_request_ref text,
  report_reference  text,
  score             integer,
  total_facilities  integer,
  total_outstanding_minor bigint,
  delinquent_facilities integer,
  worst_classification text,
  summary           jsonb,
  error             text,
  requested_by      uuid NOT NULL REFERENCES app_user(id),
  requested_at      timestamptz NOT NULL DEFAULT now(),
  responded_at      timestamptz
);
CREATE INDEX bureau_check_facility ON bureau_check(facility_id);

-- ---------------------------------------------------------------------------
-- Exposure snapshots (backend-computed; immutable)
-- ---------------------------------------------------------------------------
CREATE TABLE exposure_snapshot (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  facility_id           uuid NOT NULL REFERENCES facility_request(id),
  source_mode           text NOT NULL CHECK (source_mode IN ('MOCK','LIVE')),
  direct_exposure_minor bigint NOT NULL,
  contingent_exposure_minor bigint NOT NULL,
  group_exposure_minor  bigint NOT NULL,
  proposed_minor        bigint NOT NULL,
  aggregate_minor       bigint NOT NULL,
  sol_limit_minor       bigint NOT NULL,
  sol_config_id         uuid NOT NULL REFERENCES config_item(id),
  sol_breached          boolean NOT NULL,
  headroom_minor        bigint NOT NULL,
  sector_code           text,
  sector_exposure_minor bigint,
  sector_limit_minor    bigint,
  sector_breached       boolean NOT NULL DEFAULT false,
  lines                 jsonb NOT NULL,
  computed_by_type      text NOT NULL,
  computed_by_id        uuid,
  created_at            timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER exposure_snapshot_immutable BEFORE UPDATE OR DELETE ON exposure_snapshot FOR EACH ROW EXECUTE FUNCTION gz_forbid_mutation();

-- ---------------------------------------------------------------------------
-- Collateral
-- ---------------------------------------------------------------------------
CREATE TABLE collateral (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id       uuid NOT NULL REFERENCES customer(id),
  facility_id       uuid NOT NULL REFERENCES facility_request(id),
  type_key          text NOT NULL,
  type_config_id    uuid NOT NULL REFERENCES config_item(id),
  owner_name        text NOT NULL,
  description       text NOT NULL,
  currency          text NOT NULL DEFAULT 'NGN',
  market_value_minor bigint NOT NULL CHECK (market_value_minor >= 0),
  valuation_date    date,
  valuation_source  text,
  haircut_pct       numeric(5,2) NOT NULL CHECK (haircut_pct BETWEEN 0 AND 100),
  haircut_override_reason text,
  eligible_value_minor bigint NOT NULL CHECK (eligible_value_minor >= 0),
  fx_rate_id        uuid REFERENCES fx_rate(id),
  eligible_value_ngn_minor bigint NOT NULL,
  expiry_date       date,
  perfection_status text NOT NULL DEFAULT 'NOT_STARTED' CHECK (perfection_status IN ('NOT_STARTED','IN_PROGRESS','PERFECTED','NOT_REQUIRED')),
  document_ids      uuid[] NOT NULL DEFAULT '{}',
  created_by_type   text NOT NULL,
  created_by_id     uuid NOT NULL,
  deleted_at        timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX collateral_facility ON collateral(facility_id) WHERE deleted_at IS NULL;
CREATE TRIGGER collateral_touch BEFORE UPDATE ON collateral FOR EACH ROW EXECUTE FUNCTION gz_touch_updated_at();

-- ---------------------------------------------------------------------------
-- Risk assessments (ORR / FRR / industry / collateral / combined). Submitted assessments are immutable.
-- ---------------------------------------------------------------------------
CREATE TABLE risk_assessment (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  facility_id       uuid NOT NULL REFERENCES facility_request(id),
  kind              text NOT NULL CHECK (kind IN ('ORR','FRR','INDUSTRY','COLLATERAL','COMBINED')),
  scorecard_config_id uuid NOT NULL REFERENCES config_item(id),
  status            text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','SUBMITTED','SUPERSEDED')),
  raw_score         numeric(12,4),
  normalised_score  numeric(12,4),
  grade             text,
  grade_description text,
  inputs            jsonb NOT NULL DEFAULT '{}'::jsonb,
  breakdown         jsonb NOT NULL DEFAULT '[]'::jsonb,
  assessed_by       uuid NOT NULL REFERENCES app_user(id),
  submitted_at      timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX risk_assessment_facility ON risk_assessment(facility_id, kind);
CREATE OR REPLACE FUNCTION gz_risk_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND OLD.status <> 'DRAFT' THEN RAISE EXCEPTION 'GZ_IMMUTABLE: submitted assessment' USING ERRCODE='restrict_violation'; END IF;
  IF TG_OP = 'UPDATE' AND OLD.status = 'SUBMITTED' AND NOT (NEW.status = 'SUPERSEDED' AND NEW.inputs = OLD.inputs AND NEW.grade IS NOT DISTINCT FROM OLD.grade AND NEW.raw_score IS NOT DISTINCT FROM OLD.raw_score) THEN
    RAISE EXCEPTION 'GZ_IMMUTABLE: submitted assessment can only be superseded' USING ERRCODE='restrict_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.status = 'SUPERSEDED' THEN RAISE EXCEPTION 'GZ_IMMUTABLE: superseded assessment' USING ERRCODE='restrict_violation'; END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER risk_assessment_guard BEFORE UPDATE OR DELETE ON risk_assessment FOR EACH ROW EXECUTE FUNCTION gz_risk_guard();

-- ---------------------------------------------------------------------------
-- RARORAC computations (via Risk Asset & Pricing Portal adapter)
-- ---------------------------------------------------------------------------
CREATE TABLE rarorac_computation (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  facility_id       uuid NOT NULL REFERENCES facility_request(id),
  mode              text NOT NULL CHECK (mode IN ('MOCK','LIVE')),
  provider          text NOT NULL,
  request           jsonb NOT NULL,
  response          jsonb,
  status            text NOT NULL CHECK (status IN ('COMPLETED','FAILED')),
  pricing_rate_pct  numeric(9,4),
  rarorac_pct       numeric(9,4),
  hurdle_pct        numeric(9,4),
  threshold_config_id uuid REFERENCES config_item(id),
  within_threshold  boolean,
  exception_required boolean NOT NULL DEFAULT false,
  justification     text,
  justified_by      uuid REFERENCES app_user(id),
  justified_at      timestamptz,
  provider_ref      text,
  error             text,
  requested_by      uuid NOT NULL REFERENCES app_user(id),
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX rarorac_facility ON rarorac_computation(facility_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Environmental & Social assessment
-- ---------------------------------------------------------------------------
CREATE TABLE es_assessment (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  facility_id       uuid NOT NULL REFERENCES facility_request(id),
  trigger_config_id uuid REFERENCES config_item(id),
  trigger_reasons   jsonb NOT NULL DEFAULT '[]'::jsonb,
  status            text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','IN_PROGRESS','SUBMITTED','SUPERSEDED')),
  category          text CHECK (category IS NULL OR category IN ('A','B','C')),
  answers           jsonb NOT NULL DEFAULT '{}'::jsonb,
  findings          text,
  recommendation    text CHECK (recommendation IS NULL OR recommendation IN ('PROCEED','PROCEED_WITH_CONDITIONS','DO_NOT_PROCEED')),
  conditions        text[] NOT NULL DEFAULT '{}',
  analyst_id        uuid REFERENCES app_user(id),
  submitted_at      timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX es_assessment_open ON es_assessment(facility_id) WHERE status IN ('PENDING','IN_PROGRESS','SUBMITTED');
CREATE TRIGGER es_assessment_touch BEFORE UPDATE ON es_assessment FOR EACH ROW EXECUTE FUNCTION gz_touch_updated_at();
