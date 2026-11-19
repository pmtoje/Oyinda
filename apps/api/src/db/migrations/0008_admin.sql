-- Maker-checker for privileged access changes
CREATE TABLE access_change_request (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  target_user_id uuid NOT NULL REFERENCES app_user(id),
  change        text NOT NULL CHECK (change IN ('GRANT_ROLE','REVOKE_ROLE')),
  role_code     text NOT NULL REFERENCES role(code),
  reason        text NOT NULL,
  status        text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','REJECTED')),
  maker_id      uuid NOT NULL REFERENCES app_user(id),
  checker_id    uuid REFERENCES app_user(id),
  decided_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (checker_id IS NULL OR checker_id <> maker_id)
);
