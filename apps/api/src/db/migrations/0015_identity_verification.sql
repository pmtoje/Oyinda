-- Promoter identity verification (Credit360 prompt §13): BVN and NIN checks with explicit states, consent,
-- comparison with bank records, discrepancy review (maker-checker) and audit.
-- Raw identifiers never appear in URLs, logs or analytics. BVN stays field-encrypted (the bureau check needs it);
-- NIN is held only as a keyed hash and its last four digits (nothing downstream needs the number itself).

ALTER TABLE business_party
  ADD COLUMN date_of_birth date,
  ADD COLUMN nin_hash  text,
  ADD COLUMN nin_last4 text CHECK (nin_last4 IS NULL OR nin_last4 ~ '^[0-9]{4}$');

-- Consent recorded before any provider call (lawful basis; wording versioned).
CREATE TABLE identity_consent (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id     uuid NOT NULL REFERENCES customer(id),
  party_id        uuid NOT NULL REFERENCES business_party(id),
  given_by_type   text NOT NULL CHECK (given_by_type IN ('CUSTOMER','STAFF')),
  given_by_id     uuid NOT NULL,
  wording_version text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX identity_consent_party ON identity_consent(party_id, created_at DESC);

-- One row per check of one identifier. Never updated after completion except to link a review decision.
CREATE TABLE identity_verification (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id       uuid NOT NULL REFERENCES customer(id),
  party_id          uuid NOT NULL REFERENCES business_party(id),
  kind              text NOT NULL CHECK (kind IN ('BVN','NIN')),
  status            text NOT NULL CHECK (status IN ('IN_PROGRESS','VERIFIED','DISCREPANCY','REVIEW_REQUIRED','PROVIDER_UNAVAILABLE','UNSUCCESSFUL')),
  method            text NOT NULL DEFAULT 'PROVIDER' CHECK (method IN ('PROVIDER','REUSED','REVIEW')),
  provider          text,
  provider_mode     text CHECK (provider_mode IN ('SANDBOX','LIVE')),
  provider_ref      text,
  identifier_hash   text NOT NULL,          -- keyed HMAC of the identifier
  identifier_last4  text NOT NULL CHECK (identifier_last4 ~ '^[0-9]{4}$'),
  subject_hash      text NOT NULL,          -- keyed HMAC of the name and date of birth checked: edits make the result stale
  checks            jsonb NOT NULL DEFAULT '[]',   -- [{attribute, against, result}] — results only, no personal data
  bank_record       text CHECK (bank_record IN ('MATCH','MISMATCH','NO_RECORD','NOT_CHECKED')),
  record_enc        text,                   -- encrypted provider attributes (name, date of birth) for authorised review only
  error_code        text,
  consent_id        uuid REFERENCES identity_consent(id),
  requested_by_type text NOT NULL,
  requested_by_id   uuid,
  created_at        timestamptz NOT NULL DEFAULT now(),
  completed_at      timestamptz
);
CREATE INDEX identity_verification_party ON identity_verification(party_id, kind, created_at DESC);
CREATE INDEX identity_verification_customer ON identity_verification(customer_id, created_at DESC);
CREATE INDEX identity_verification_hash ON identity_verification(customer_id, kind, identifier_hash) WHERE status = 'VERIFIED';

-- Discrepancy review: a reviewer proposes (clear or reject) with a reason; a different reviewer decides.
CREATE TABLE identity_review (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id      uuid NOT NULL REFERENCES customer(id),
  party_id         uuid NOT NULL REFERENCES business_party(id),
  verification_ids uuid[] NOT NULL,
  status           text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','PROPOSED','CLEARED','REJECTED','ESCALATED')),
  customer_note    text,
  proposal         text CHECK (proposal IN ('CLEAR','REJECT','ESCALATE')),
  proposal_reason  text,
  proposed_by      uuid REFERENCES app_user(id),
  proposed_at      timestamptz,
  decided_by       uuid REFERENCES app_user(id),
  decision_reason  text,
  decided_at       timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT identity_review_two_people CHECK (decided_by IS NULL OR proposed_by IS NULL OR decided_by <> proposed_by)
);
CREATE INDEX identity_review_open ON identity_review(status, created_at) WHERE status IN ('OPEN','PROPOSED','ESCALATED');
CREATE INDEX identity_review_party ON identity_review(party_id, created_at DESC);
