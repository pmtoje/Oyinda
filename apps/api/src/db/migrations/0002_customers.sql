-- Customers, portal users, onboarding and the reusable master Business Profile

CREATE TABLE customer (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_ref           text NOT NULL UNIQUE,                 -- GZ-CUS-000001
  cba_customer_id        text NOT NULL UNIQUE,                 -- core banking customer id (source of truth for identity)
  legal_name             text NOT NULL,
  customer_category      text NOT NULL DEFAULT 'CORPORATE' CHECK (customer_category IN ('CORPORATE','COMMERCIAL','INSTITUTIONAL','SME','PUBLIC_SECTOR')),
  relationship_manager_id uuid REFERENCES app_user(id),
  business_unit_code     text REFERENCES business_unit(code),
  status                 text NOT NULL DEFAULT 'ONBOARDING' CHECK (status IN ('ONBOARDING','ACTIVE','SUSPENDED','EXITED')),
  is_demo                boolean NOT NULL DEFAULT false,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER customer_touch BEFORE UPDATE ON customer FOR EACH ROW EXECUTE FUNCTION gz_touch_updated_at();
CREATE INDEX customer_rm ON customer(relationship_manager_id);

CREATE TABLE customer_account (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id     uuid NOT NULL REFERENCES customer(id),
  account_number  text NOT NULL UNIQUE CHECK (account_number ~ '^[0-9]{10}$'),
  account_name    text NOT NULL,
  currency        text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  product_name    text,
  is_primary      boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE customer_user (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id           uuid NOT NULL REFERENCES customer(id),
  full_name             text NOT NULL,
  email                 text NOT NULL,
  phone                 text NOT NULL,
  designation           text,
  portal_role           text NOT NULL DEFAULT 'PRIMARY' CHECK (portal_role IN ('PRIMARY','DELEGATE')),
  email_verified_at     timestamptz,
  phone_verified_at     timestamptz,
  status                text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','LOCKED','DISABLED')),
  failed_otp_count      integer NOT NULL DEFAULT 0,
  locked_until          timestamptz,
  terms_version         text,
  terms_accepted_at     timestamptz,
  privacy_consent_version text,
  privacy_consent_at    timestamptz,
  last_login_at         timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (customer_id, email)
);
CREATE UNIQUE INDEX customer_user_email ON customer_user(lower(email));
CREATE TRIGGER customer_user_touch BEFORE UPDATE ON customer_user FOR EACH ROW EXECUTE FUNCTION gz_touch_updated_at();

-- Pre-authentication onboarding journey state (server-held; the client only holds an opaque id)
CREATE TABLE onboarding_journey (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash         text NOT NULL UNIQUE,
  account_number_hash text NOT NULL,
  cba_customer_id    text,
  step               text NOT NULL CHECK (step IN ('ACCOUNT_VERIFIED','OTP_VERIFIED','PROFILE_CONFIRMED','COMPLETED','ABANDONED')),
  otp_challenge_id   uuid REFERENCES otp_challenge(id),
  cba_snapshot       jsonb,           -- what the core banking system returned (never client data)
  ip                 inet,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  expires_at         timestamptz NOT NULL,
  completed_customer_user_id uuid REFERENCES customer_user(id)
);
CREATE TRIGGER onboarding_journey_touch BEFORE UPDATE ON onboarding_journey FOR EACH ROW EXECUTE FUNCTION gz_touch_updated_at();

CREATE TABLE journey_step_event (
  id           bigserial PRIMARY KEY,
  journey      text NOT NULL CHECK (journey IN ('ONBOARDING','FACILITY_APPLICATION')),
  journey_id   uuid NOT NULL,
  customer_id  uuid,
  step         text NOT NULL,
  event        text NOT NULL CHECK (event IN ('ENTERED','COMPLETED','ERROR')),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX journey_step_event_lookup ON journey_step_event(journey, journey_id, created_at);

-- ---------------------------------------------------------------------------
-- Master Business Profile (one per customer, versioned snapshots)
-- ---------------------------------------------------------------------------
CREATE TABLE business_profile (
  customer_id          uuid PRIMARY KEY REFERENCES customer(id),
  registered_name      text NOT NULL,
  trading_name         text,
  rc_number            text UNIQUE CHECK (rc_number IS NULL OR rc_number ~ '^(RC|BN|IT)?[0-9]{1,10}$'),
  tin                  text CHECK (tin IS NULL OR tin ~ '^[0-9]{8}-?[0-9]{4}$'),
  incorporation_date   date,
  business_type        text CHECK (business_type IS NULL OR business_type IN ('LIMITED_LIABILITY','PUBLIC_LIMITED','PARTNERSHIP','SOLE_PROPRIETORSHIP','INCORPORATED_TRUSTEES','GOVERNMENT_AGENCY')),
  address_line         text,
  city                 text,
  state                text,
  country              text NOT NULL DEFAULT 'NG',
  sector_code          text REFERENCES sector(code),
  industry             text,
  business_description text,
  products_services    text,
  value_chain          text,
  geographic_footprint text,
  employee_count       integer CHECK (employee_count IS NULL OR employee_count >= 0),
  has_litigation       boolean,
  litigation_details   text,
  has_regulatory_matters boolean,
  regulatory_details   text,
  sector_risk_notes    text,
  version              integer NOT NULL DEFAULT 1,
  completeness_pct     integer NOT NULL DEFAULT 0 CHECK (completeness_pct BETWEEN 0 AND 100),
  updated_by_type      text,
  updated_by_id        uuid,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER business_profile_touch BEFORE UPDATE ON business_profile FOR EACH ROW EXECUTE FUNCTION gz_touch_updated_at();

-- Immutable snapshot each time the profile changes (lets a facility pin the profile it was assessed on)
CREATE TABLE business_profile_version (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id   uuid NOT NULL REFERENCES customer(id),
  version       integer NOT NULL,
  snapshot      jsonb NOT NULL,
  changed_by_type text NOT NULL,
  changed_by_id uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (customer_id, version)
);
CREATE TRIGGER business_profile_version_immutable BEFORE UPDATE OR DELETE ON business_profile_version FOR EACH ROW EXECUTE FUNCTION gz_forbid_mutation();

CREATE TABLE business_party (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id      uuid NOT NULL REFERENCES customer(id),
  party_type       text NOT NULL CHECK (party_type IN ('SHAREHOLDER','DIRECTOR','PROMOTER','PRINCIPAL_OFFICER','BOARD_MEMBER','KEY_EXECUTIVE')),
  entity_kind      text NOT NULL DEFAULT 'INDIVIDUAL' CHECK (entity_kind IN ('INDIVIDUAL','CORPORATE')),
  full_name        text NOT NULL,
  designation      text,
  ownership_pct    numeric(5,2) CHECK (ownership_pct IS NULL OR (ownership_pct >= 0 AND ownership_pct <= 100)),
  nationality      text,
  bvn_enc          text,               -- AES-256-GCM, application-level
  bvn_hash         text,               -- keyed HMAC for de-duplication lookups
  bvn_last4        text CHECK (bvn_last4 IS NULL OR bvn_last4 ~ '^[0-9]{4}$'),
  is_pep           boolean NOT NULL DEFAULT false,
  pep_details      text,
  is_insider       boolean NOT NULL DEFAULT false,
  insider_relationship text,
  years_experience integer,
  deleted_at       timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX business_party_customer ON business_party(customer_id) WHERE deleted_at IS NULL;
CREATE TRIGGER business_party_touch BEFORE UPDATE ON business_party FOR EACH ROW EXECUTE FUNCTION gz_touch_updated_at();

CREATE TABLE business_bank_relationship (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id      uuid NOT NULL REFERENCES customer(id),
  bank_name        text NOT NULL,
  account_number_last4 text CHECK (account_number_last4 IS NULL OR account_number_last4 ~ '^[0-9]{4}$'),
  account_type     text,
  currency         text NOT NULL DEFAULT 'NGN',
  relationship_since date,
  deleted_at       timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE business_external_facility (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id      uuid NOT NULL REFERENCES customer(id),
  lender           text NOT NULL,
  facility_type    text NOT NULL,
  currency         text NOT NULL DEFAULT 'NGN',
  amount_minor     bigint NOT NULL CHECK (amount_minor >= 0),
  outstanding_minor bigint NOT NULL CHECK (outstanding_minor >= 0),
  maturity_date    date,
  performing       boolean NOT NULL DEFAULT true,
  deleted_at       timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE business_counterparty (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id      uuid NOT NULL REFERENCES customer(id),
  kind             text NOT NULL CHECK (kind IN ('SUPPLIER','CUSTOMER')),
  name             text NOT NULL,
  share_pct        numeric(5,2) CHECK (share_pct IS NULL OR (share_pct >= 0 AND share_pct <= 100)),
  relationship_years integer,
  deleted_at       timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now()
);
