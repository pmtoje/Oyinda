# Operations Runbook

> **Product name:** this platform is now **Credit360 by AltBank** (product owner direction, 24-Nov-2026). "Gazelle" below is its original working name, kept where it traces to the source PRD/BRD/SWR and to earlier decisions.

## Processes

| Process | Command | Scale |
|---|---|---|
| API | `node --import tsx apps/api/src/server.ts` (or the container image), with `WEB_DIST_DIR` set to serve the built web app | Stateless; N replicas behind the Bank API Gateway / load balancer |
| Worker | `pnpm --filter @gazelle/api worker` | N replicas. Jobs use `SKIP LOCKED`; sweeps take advisory locks |
| Migrations | Applied at API start-up (checksum-verified; edited migrations refuse to apply) | One-way, forward-only |

## Configuration

All configuration is environment-driven (`apps/api/src/config/env.ts`, validated at start-up). Secrets (`HMAC_KEY`, `DATA_KEY`, AD bind credentials, gateway credentials) come from the Bank's secrets manager. **Rotating `DATA_KEY`** requires re-wrapping data keys: `DATA_KEY_ID` is recorded on every document version and field ciphertext to support a dual-key rotation window.

### Interim staff sign-in (until Active Directory)

1. Obtain the Information Security approval and set `STAFF_AUTH_MODE=local` and `STAFF_LOCAL_AUTH_APPROVAL_REF=<approval reference>`; restart the API. Production refuses `local` without the reference. `AD_MODE` may stay `mock` because the directory is not used for sign-in in this mode.
2. Load staff from the spreadsheet (Admin → Users & access → Import from spreadsheet) or create them by hand. Every new active user receives a single-use activation link (72 hours) at their work e-mail.
3. Bootstrap the first administrators, before anyone can sign in, with `pnpm --filter @gazelle/api staff:activation-link <username>` (two administrators are needed for maker-checker). The link goes only to the user's e-mail on record.
4. Staff set their own password from the link and enrol the authenticator at first sign-in. Forgotten passwords: the sign-in page sends a one-hour reset link. An administrator can send a reset link, which also withdraws the current password and signs the user out.
5. Policy (`password_policy/STAFF_INTERIM`, maker-checker): 14+ characters with mixed character types, no name/username/e-mail, 90-day expiry, last 5 not reusable, lock after 5 failures for 30 minutes. An expired password cannot sign in; a reset link is sent automatically.
6. When AD authentication is ready: set `STAFF_AUTH_MODE=directory` and `AD_MODE=live`. Gazelle passwords stop working immediately (the password routes return 404); authenticator enrolments are kept.

## Health & monitoring

* `GET /health/live`, `GET /health/ready` (unauthenticated, minimal).
* `GET /internal/metrics` (Prometheus format; `system.health` permission).
* Control centre → **System health**: DB latency and migrations, integration modes, job queues, dead letters (with retry), SLA breach counts, notification delivery failures, AI usage, audit-chain integrity, route latencies.
* Control centre → **Data quality**: duplicates, missing periods, invalid amounts, orphaned tasks, reconciliation breaks.

Alert on: readiness failures; dead-letter count > 0; notification deliveries FAILED; audit chain `ok=false` (security incident); SLA breaches above threshold; HTTP 5xx rate.

## Incident playbooks

| Symptom | Action |
|---|---|
| Dead-letter jobs | Inspect `last_error` in System health. Fix the cause (e.g. integration outage), then retry. Jobs are idempotent. |
| Integration outage (CBA / bureau / RARORAC) | Requests fail closed with a clear message and are logged. Nothing is fabricated. Retry once restored; booking and disbursement use idempotency keys, so retries cannot double-post. |
| Audit chain broken | Treat as a security incident: preserve the database, identify `brokenAt`, and escalate to Information Security. |
| Stuck task (worker crashed) | `reclaimStale` returns RUNNING jobs after 15 minutes. For workflow, use *Reassign* (audited). |
| Wrong configuration activated | Activate a corrected new version (maker-checker). Historical decisions remain bound to the version they used. |

## Backup & disaster recovery

PostgreSQL PITR (WAL archiving) with an RPO of 5 minutes and an RTO of 1 hour (targets to confirm with IT Risk). The encrypted object store is replicated alongside it; restoring a document requires the database row (wrapped key) and the object. Verify restores quarterly, including `verifyAuditChain` on the restored copy.
