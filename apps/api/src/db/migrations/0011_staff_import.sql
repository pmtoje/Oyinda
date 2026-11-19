-- Staff directory loaded from a spreadsheet (interim, until Active Directory synchronisation is integrated).
-- Each upload is validated, previewed and applied only after a second administrator approves it.
CREATE TABLE user_import_batch (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  filename      text NOT NULL,
  file_sha256   text NOT NULL,
  status        text NOT NULL CHECK (status IN ('INVALID','PENDING_APPROVAL','APPLIED','REJECTED','WITHDRAWN')),
  row_count     integer NOT NULL,
  rows          jsonb NOT NULL,     -- parsed rows (no credentials)
  preview       jsonb NOT NULL,     -- per-row actions, changes and errors
  summary       jsonb NOT NULL,
  maker_id      uuid NOT NULL REFERENCES app_user(id),
  checker_id    uuid REFERENCES app_user(id),
  decision_note text,
  decided_at    timestamptz,
  applied_summary jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (checker_id IS NULL OR checker_id <> maker_id)
);
CREATE INDEX user_import_batch_created ON user_import_batch(created_at DESC);
-- Where a staff record came from.
ALTER TABLE app_user ADD COLUMN source text NOT NULL DEFAULT 'MANUAL' CHECK (source IN ('MANUAL','SPREADSHEET','AD_SYNC','SEED'));
ALTER TABLE app_user ADD COLUMN source_batch_id uuid REFERENCES user_import_batch(id);
