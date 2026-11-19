-- SWR (27-10-2026) / PRD alignment.

-- Baseline configuration releases: records which baseline revision has been reconciled into this environment.
CREATE TABLE baseline_release (
  code        text PRIMARY KEY,
  applied_at  timestamptz NOT NULL DEFAULT now(),
  summary     jsonb NOT NULL
);

-- SWR onboarding: username = company e-mail on the CBA; password per the Bank's policy; e-mail verification link.
ALTER TABLE customer_user
  ADD COLUMN password_hash text,
  ADD COLUMN password_changed_at timestamptz,
  ADD COLUMN failed_password_count integer NOT NULL DEFAULT 0,
  ADD COLUMN role_in_company text;

CREATE TABLE email_verification (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_user_id uuid NOT NULL REFERENCES customer_user(id),
  token_hash       text NOT NULL UNIQUE,
  expires_at       timestamptz NOT NULL,
  consumed_at      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE onboarding_journey
  ADD COLUMN applicant_name text,
  ADD COLUMN applicant_role text,
  ADD COLUMN email_otp_challenge_id uuid REFERENCES otp_challenge(id);

-- PRD: block / unblock customers. Blocking takes effect at once; unblocking needs a checker.
CREATE TABLE customer_block_request (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id   uuid NOT NULL REFERENCES customer(id),
  action        text NOT NULL CHECK (action IN ('BLOCK','UNBLOCK')),
  reason        text NOT NULL,
  status        text NOT NULL CHECK (status IN ('APPLIED','PENDING','APPROVED','REJECTED')),
  requested_by  uuid NOT NULL REFERENCES app_user(id),
  decided_by    uuid REFERENCES app_user(id),
  decided_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (decided_by IS NULL OR decided_by <> requested_by)
);
CREATE UNIQUE INDEX customer_block_one_pending ON customer_block_request(customer_id) WHERE status = 'PENDING';

-- AD sync: reporting line (used to route Team Lead / RBE tasks to the officer's own line).
ALTER TABLE app_user ADD COLUMN manager_id uuid REFERENCES app_user(id);

-- Committee decision recorded by Credit Operations from signed minutes (PRD).
ALTER TABLE workflow_action DROP CONSTRAINT workflow_action_action_check;
ALTER TABLE workflow_action ADD CONSTRAINT workflow_action_action_check CHECK (action IN ('SUBMIT','RESUBMIT','CLAIM','RELEASE','REASSIGN','APPROVE','RECOMMEND','DECLINE','RETURN','REQUEST_CLARIFICATION','COMMENT','VOTE','COMPLETE','ROUTE','ESCALATE','SKIP','CANCEL','RECORD_DECISION'));
