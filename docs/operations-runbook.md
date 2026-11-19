# Operations Runbook

## Processes

| Process | Command | Scale |
|---|---|---|
| API | `node --import tsx apps/api/src/server.ts` (or the container image), with `WEB_DIST_DIR` set to serve the built web app | Stateless; N replicas behind the Bank API Gateway / load balancer |
| Worker | `pnpm --filter @gazelle/api worker` | N replicas. Jobs use `SKIP LOCKED`; sweeps take advisory locks |
| Migrations | Applied at API start-up (checksum-verified; edited migrations refuse to apply) | One-way, forward-only |

## Configuration

All configuration is environment-driven (`apps/api/src/config/env.ts`, validated at start-up). Secrets (`HMAC_KEY`, `DATA_KEY`, AD bind credentials, gateway credentials) come from the Bank's secrets manager. **Rotating `DATA_KEY`** requires re-wrapping data keys: `DATA_KEY_ID` is recorded on every document version and field ciphertext to support a dual-key rotation window.

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
