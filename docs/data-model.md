# Data Model

PostgreSQL 16; migrations in `apps/api/src/db/migrations` (checksum-verified, never edited after application). Money is stored as **integer minor units** (`bigint`), rates as `numeric`. Primary keys are UUIDs; human references are `GZ-CUS-000001` and `GZ-FAC-2026-000001` (allocated transactionally).

## Domains

| Domain | Tables | Notes |
|---|---|---|
| Organisation | `directorate`, `business_unit`, `sector` | Reference data. |
| Staff & access | `app_user`, `role`, `permission`, `role_permission`, `user_role`, `user_sector`, `user_approval_limit`, `delegation`, `access_change_request` | Limits and delegations are time-bound. |
| Sessions | `auth_session`, `otp_challenge`, `auth_attempt` | Hashes only. |
| Configuration | `config_item` | Versioned, maker-checker, effective-dated; content frozen once submitted (trigger); one open active version per key (partial unique index). |
| Customers | `customer`, `customer_account`, `customer_user`, `onboarding_journey`, `journey_step_event` | Customer identity from CBA. |
| Business profile | `business_profile`, `business_profile_version` (immutable snapshots), `business_party`, `business_bank_relationship`, `business_external_facility`, `business_counterparty` | Parties carry encrypted BVN and PEP/insider flags. |
| Facilities | `facility_request`, `facility_status_history` (immutable), `rework_item` | Product configuration version frozen per facility; `row_version` optimistic lock; `(customer_id, idempotency_key)` unique. |
| Eligibility | `eligibility_evaluation`, `eligibility_result` | Immutable runs referencing the exact rule version. |
| Documents | `document`, `document_version` (content immutable), `document_event` (immutable), `document_access_grant` | Encryption metadata on each version. |
| Financials | `financial_statement`, `financial_line_item`, `financial_analysis` (immutable), `ratio_result` (immutable, references ratio config version) | |
| Bank statements | `bank_statement`, `bank_transaction`, `statement_analysis` (immutable, records FX rate ids), `fx_rate` (immutable) | |
| Credit | `bureau_check`, `exposure_snapshot` (immutable), `collateral`, `risk_assessment` (immutable once submitted), `rarorac_computation`, `es_assessment` | |
| Workflow | `workflow_instance`, `workflow_task`, `workflow_action` (immutable), `task_assignment_history` (immutable), `committee_session`, `committee_vote` (immutable), `sla_event` (immutable), `thread`, `thread_participant`, `thread_message` (immutable), `thread_read` | Route and facts frozen on the instance. |
| Fulfilment | `generated_document` (immutable versions), `approved_terms` (immutable versions), `offer_letter`, `negotiation_request`, `condition_item` | |
| Servicing | `facility_account`, `disbursement` (idempotency key unique; maker ≠ checker), `payment_schedule_item`, `facility_payment` (immutable, unique reference), `monitoring_item` | |
| Platform | `job` (queue + dead letter), `notification`, `notification_delivery`, `mock_outbox` (non-production sink), `ai_interaction`, `audit_log` (hash-chained, immutable) | |

## Reproducibility of decisions

A historical decision can be reconstructed because every decision references the exact configuration version used: facility → product version; eligibility results → rule versions; ratio results → ratio versions; risk assessments → scorecard / rating-model version; workflow instance → definition and authority version, plus frozen facts and route; committee session → frozen rules; terms → source action. Configuration rows are never updated in place once submitted.

## JSON usage

JSON is used only for configuration payloads (validated by zod per kind), frozen snapshots (facts, routes, profile versions, analysis summaries), product-specific application fields (validated against the frozen product version) and audit before/after images. Core banking data (customers, facilities, money, documents, decisions) is relational with foreign keys and constraints.
