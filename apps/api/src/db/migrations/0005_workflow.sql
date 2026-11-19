-- Workflow engine: instances, tasks, immutable actions, committees, SLA events, threads

CREATE TABLE workflow_instance (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  facility_id          uuid NOT NULL REFERENCES facility_request(id),
  kind                 text NOT NULL CHECK (kind IN ('CREDIT_APPROVAL','FULFILMENT','NEGOTIATION_REVIEW','OFFER_CHECK','DISBURSEMENT')),
  definition_config_id uuid NOT NULL REFERENCES config_item(id),
  authority_config_id  uuid REFERENCES config_item(id),
  status               text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','COMPLETED','TERMINATED','CANCELLED')),
  outcome              text CHECK (outcome IS NULL OR outcome IN ('APPROVED','DECLINED','COMPLETED','WITHDRAWN','CANCELLED')),
  facts                jsonb NOT NULL,          -- facts the route was computed from (frozen at start / re-route)
  route                jsonb NOT NULL,          -- resolved stage list with reasons
  current_stage_index  integer NOT NULL DEFAULT 0,
  row_version          integer NOT NULL DEFAULT 1,
  started_at           timestamptz NOT NULL DEFAULT now(),
  completed_at         timestamptz
);
CREATE UNIQUE INDEX workflow_instance_one_active ON workflow_instance(facility_id, kind) WHERE status = 'ACTIVE';

CREATE TABLE workflow_task (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  instance_id       uuid NOT NULL REFERENCES workflow_instance(id),
  facility_id       uuid NOT NULL REFERENCES facility_request(id),
  stage_index       integer NOT NULL,
  stage_key         text NOT NULL,
  stage_name        text NOT NULL,
  branch_key        text,                         -- set for parallel branches (e.g. CREDIT_ANALYSIS, ES_REVIEW)
  task_type         text NOT NULL CHECK (task_type IN ('REVIEW','ANALYSIS','APPROVAL','COMMITTEE','FULFILMENT','CUSTOMER_ACTION','CHECK')),
  role_code         text NOT NULL REFERENCES role(code),
  assigned_user_id  uuid REFERENCES app_user(id),
  claimed_by        uuid REFERENCES app_user(id),
  claimed_at        timestamptz,
  status            text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','CLAIMED','COMPLETED','CANCELLED','WAITING')),
  outcome           text,
  permitted_actions text[] NOT NULL,
  authority         jsonb NOT NULL DEFAULT '{}'::jsonb,
  sla_policy_config_id uuid REFERENCES config_item(id),
  sla_started_at    timestamptz NOT NULL DEFAULT now(),
  sla_paused_ms     bigint NOT NULL DEFAULT 0,
  sla_paused_at     timestamptz,
  due_at            timestamptz,
  warn_at           timestamptz,
  warned_at         timestamptz,
  breached_at       timestamptz,
  escalation_level  integer NOT NULL DEFAULT 0,
  row_version       integer NOT NULL DEFAULT 1,
  created_at        timestamptz NOT NULL DEFAULT now(),
  completed_at      timestamptz,
  completed_by      uuid REFERENCES app_user(id)
);
CREATE INDEX workflow_task_queue ON workflow_task(role_code, status) WHERE status IN ('OPEN','CLAIMED');
CREATE INDEX workflow_task_facility ON workflow_task(facility_id, created_at);
CREATE INDEX workflow_task_sla ON workflow_task(due_at) WHERE status IN ('OPEN','CLAIMED');
CREATE UNIQUE INDEX workflow_task_one_open_per_stage ON workflow_task(instance_id, stage_index, COALESCE(branch_key,'')) WHERE status IN ('OPEN','CLAIMED','WAITING');

-- Every decision/action is an immutable event.
CREATE TABLE workflow_action (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  instance_id      uuid NOT NULL REFERENCES workflow_instance(id),
  task_id          uuid REFERENCES workflow_task(id),
  facility_id      uuid NOT NULL REFERENCES facility_request(id),
  actor_type       text NOT NULL CHECK (actor_type IN ('STAFF','CUSTOMER','SYSTEM')),
  actor_id         uuid,
  actor_name       text NOT NULL,
  actor_role       text,
  on_behalf_of     uuid REFERENCES app_user(id),
  action           text NOT NULL CHECK (action IN ('SUBMIT','RESUBMIT','CLAIM','RELEASE','REASSIGN','APPROVE','RECOMMEND','DECLINE','RETURN','REQUEST_CLARIFICATION','COMMENT','VOTE','COMPLETE','ROUTE','ESCALATE','SKIP','CANCEL')),
  comment          text,
  payload          jsonb NOT NULL DEFAULT '{}'::jsonb,
  amount_minor_at_action bigint,
  idempotency_key  text UNIQUE,
  ip               inet,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX workflow_action_facility ON workflow_action(facility_id, created_at);
CREATE TRIGGER workflow_action_immutable BEFORE UPDATE OR DELETE ON workflow_action FOR EACH ROW EXECUTE FUNCTION gz_forbid_mutation();

CREATE TABLE task_assignment_history (
  id            bigserial PRIMARY KEY,
  task_id       uuid NOT NULL REFERENCES workflow_task(id),
  from_user_id  uuid REFERENCES app_user(id),
  to_user_id    uuid REFERENCES app_user(id),
  kind          text NOT NULL CHECK (kind IN ('CLAIM','RELEASE','REASSIGN','AUTO_ASSIGN','DELEGATE')),
  reason        text,
  actor_id      uuid REFERENCES app_user(id),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER task_assignment_history_immutable BEFORE UPDATE OR DELETE ON task_assignment_history FOR EACH ROW EXECUTE FUNCTION gz_forbid_mutation();

-- Committees
CREATE TABLE committee_session (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id          uuid NOT NULL UNIQUE REFERENCES workflow_task(id),
  facility_id      uuid NOT NULL REFERENCES facility_request(id),
  committee_key    text NOT NULL,
  committee_config_id uuid NOT NULL REFERENCES config_item(id),
  rules            jsonb NOT NULL,           -- frozen quorum / vote rules
  members          uuid[] NOT NULL,
  status           text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','DECIDED')),
  decision         text CHECK (decision IS NULL OR decision IN ('APPROVED','DECLINED','RETURNED')),
  decided_at       timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE committee_vote (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id       uuid NOT NULL REFERENCES committee_session(id),
  member_id        uuid NOT NULL REFERENCES app_user(id),
  member_role      text NOT NULL,
  vote             text NOT NULL CHECK (vote IN ('APPROVE','DECLINE','ABSTAIN','RETURN')),
  comment          text,
  sequence_no      integer NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id, member_id)
);
CREATE TRIGGER committee_vote_immutable BEFORE UPDATE OR DELETE ON committee_vote FOR EACH ROW EXECUTE FUNCTION gz_forbid_mutation();

-- SLA events
CREATE TABLE sla_event (
  id               bigserial PRIMARY KEY,
  task_id          uuid NOT NULL REFERENCES workflow_task(id),
  facility_id      uuid NOT NULL REFERENCES facility_request(id),
  kind             text NOT NULL CHECK (kind IN ('STARTED','WARNING','BREACHED','ESCALATED','PAUSED','RESUMED','COMPLETED')),
  level            integer,
  detail           jsonb,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sla_event_task ON sla_event(task_id);
CREATE TRIGGER sla_event_immutable BEFORE UPDATE OR DELETE ON sla_event FOR EACH ROW EXECUTE FUNCTION gz_forbid_mutation();

-- Secure clarification threads
CREATE TABLE thread (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  facility_id      uuid NOT NULL REFERENCES facility_request(id),
  task_id          uuid REFERENCES workflow_task(id),
  subject          text NOT NULL,
  audience         text NOT NULL CHECK (audience IN ('INTERNAL','CUSTOMER')),
  status           text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','RESOLVED')),
  pauses_sla       boolean NOT NULL DEFAULT false,
  created_by_type  text NOT NULL,
  created_by_id    uuid NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  resolved_at      timestamptz
);
CREATE INDEX thread_facility ON thread(facility_id);

CREATE TABLE thread_participant (
  thread_id        uuid NOT NULL REFERENCES thread(id),
  participant_type text NOT NULL CHECK (participant_type IN ('STAFF','CUSTOMER')),
  participant_id   uuid NOT NULL,
  PRIMARY KEY (thread_id, participant_type, participant_id)
);

CREATE TABLE thread_message (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id        uuid NOT NULL REFERENCES thread(id),
  facility_id      uuid NOT NULL REFERENCES facility_request(id),
  sender_type      text NOT NULL,
  sender_id        uuid NOT NULL,
  sender_name      text NOT NULL,
  recipient_type   text,
  recipient_id     uuid,
  body             text NOT NULL CHECK (length(body) BETWEEN 1 AND 10000),
  attachment_document_id uuid REFERENCES document(id),
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX thread_message_thread ON thread_message(thread_id, created_at);
CREATE TRIGGER thread_message_immutable BEFORE UPDATE OR DELETE ON thread_message FOR EACH ROW EXECUTE FUNCTION gz_forbid_mutation();

CREATE TABLE thread_read (
  message_id       uuid NOT NULL REFERENCES thread_message(id),
  reader_type      text NOT NULL,
  reader_id        uuid NOT NULL,
  read_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, reader_type, reader_id)
);
