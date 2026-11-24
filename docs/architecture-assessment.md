# Gazelle by Alternative Bank — Architecture Assessment

> **Product name:** this platform is now **Credit360 by AltBank** (product owner direction, 24-Nov-2026). "Gazelle" below is its original working name, kept where it traces to the source PRD/BRD/SWR and to earlier decisions.

_Phase 0 deliverable. Assessed 19-Nov-2026._

## 1. Repository inspection findings

| Item inspected | Finding |
|---|---|
| Source files | None. The repository `pmtoje/Oyinda` had no commits on any branch. |
| Framework / architecture | None present. |
| Routes | None. |
| Database / schema | None. |
| Authentication | None. |
| Components / reusable services | None. |
| Integrations | None. |
| Tests | None. |
| Technical debt | None inherited. |
| Security weaknesses | None inherited. The risk is entirely in what we build. |

Because nothing existed, no existing functionality was removed or refactored.

### Source requirements availability

The build instruction says to treat the **Gazelle PRD/BRD** and the **27-Oct-2026 Standard Work Request (SWR)** as the primary sources. **Neither document was in the repository or attached to the instruction.** Also, about 25 sections of the instruction were embedded images that did not come through (marked `Image` in the text). These include the approval-flow diagrams, the SLA defaults table, the admin module list and the E&S configuration fields.

Consequences:
* The master build prompt is the working source of truth (`MBP-§n` references in the traceability matrix).
* Where a missing image held specific business values (SLA hours, committee limits, exact routing), Gazelle ships **configurable defaults**, clearly marked as defaults. Each one is logged in `open-questions.md` for Credit Risk to confirm. Nothing is hard-coded.

**Update, 19-Nov-2026.** The SWR (27-Oct-2026) and the combined PRD/BRD (with its embedded approval grid, facility-type list, Credit Approval Memo template, offer-letter template and E&S checklist) were supplied and the build was reconciled against them. The SWR is treated as authoritative; every conflict between the SWR, the PRD and earlier defaults is recorded in `requirements-decisions.md` (D-21 to D-48), the remaining questions in `open-questions.md` (OQ-17 to OQ-30), and coverage in the SWR/PRD section of `requirements-traceability.md`. Existing environments pick up the new baseline through baseline release `2026.11-SWR`.

## 2. Target architecture

Modular monolith, API-first, with strict domain modules and adapter-based integrations. A bank-scale credit platform needs strong transactional consistency across workflow, decisions and audit, and that is much easier to guarantee inside one database transaction than across microservices. Module boundaries are drawn so a module can be split out later (for example document processing or notifications) without rewriting it.

```
                ┌──────────────────────── Bank API Gateway (prod) ─────────────────────────┐
 Browser ──TLS──▶  Web (React SPA, static)        API (Fastify, Node 22, TypeScript)        │
 (customer /     │  /portal  customer             ┌─────────────────────────────────────┐   │
  staff /        │  /work    staff workspace      │ HTTP layer: auth, CSRF, rate-limit, │   │
  executive /    │  /admin   control centre       │ zod validation, RBAC, error mapping │   │
  admin)         │                                ├─────────────────────────────────────┤   │
                 │                                │ Domain modules                      │   │
                 │                                │  identity · customers · profile     │   │
                 │                                │  fipg · products · facilities       │   │
                 │                                │  documents · financials · statements│   │
                 │                                │  bureau · exposure · collateral     │   │
                 │                                │  risk(ORR/FRR) · rarorac · es       │   │
                 │                                │  workflow · sla · threads · memo    │   │
                 │                                │  offers · conditions · servicing    │   │
                 │                                │  notifications · reports · ai       │   │
                 │                                │  admin/config · audit · health      │   │
                 │                                ├─────────────────────────────────────┤   │
                 │                                │ Shared kernel: rules engine, formula│   │
                 │                                │ engine, money, ids, crypto, masking │   │
                 │                                ├─────────────────────────────────────┤   │
                 │                                │ Integration adapters (interface +   │   │
                 │                                │ mock + live slot): CBA, identity/   │   │
                 │                                │ OTP, SMS, email, AD/LDAP, bureau,   │   │
                 │                                │ RARORAC portal, AV scan, KMS, AI    │   │
                 │                                └───────────┬───────────────┬─────────┘   │
                 │                                            │               │             │
                 │                        PostgreSQL 16 (system of record)   Encrypted     │
                 │                        + job queue (SKIP LOCKED)          object store  │
                 │                        + hash-chained audit log                         │
                 └──────────────────────────────────────────────────────────────────────────┘
       Worker process (same codebase): SLA sweeps, escalations, statement analysis,
       document scanning, document generation, notifications dispatch, monitoring jobs.
```

### Technology choices

| Concern | Choice | Rationale |
|---|---|---|
| Language | TypeScript (strict) across API, web and shared packages | One type system end to end; shared zod schemas mean the server never trusts the client's shape. |
| API | Fastify 5 | Mature, fast, first-class schema validation, good security plugin ecosystem. |
| Database | PostgreSQL 16, hand-written SQL migrations, `pg` driver | Explicit constraints, triggers for immutability and audit, row locking for task claiming, no ORM magic hiding queries. |
| Jobs | Postgres-backed queue (`FOR UPDATE SKIP LOCKED`) | Transactional enqueue with the business write; retries and dead-letter without new infrastructure. Replaceable with the Bank's broker. |
| Web | React 19 + Vite + React Router + TanStack Query | Mature; a bespoke CSS design system (no utility-class template look). |
| Documents | `docx` (Word generation), ExcelJS (XLSX statement parsing) | Credit Risk requires Word output for the combined term sheet. |
| Tests | Vitest (unit + API integration against real Postgres), Playwright (E2E) | Tests run against the real schema, not mocks of the database. |

### Horizontal scaling

The API is stateless: sessions live in Postgres, and file bytes in the object-store adapter. Run N API replicas behind the gateway. Workers coordinate through `SKIP LOCKED`, so N workers are safe. Read-heavy reporting can move to a read replica.

### Observability

Structured JSON logs (pino) carry a request ID, actor ID and facility ID where known. A Prometheus-format `/internal/metrics` endpoint (staff-authenticated) and an admin system-health dashboard (Phase 59/60) sit on top.

## 3. Key architectural decisions

1. **Configuration over code.** FIPG rules, products, document requirements, ratios, scorecards, E&S triggers, workflow definitions, approval authority, SLA, committees, notifications and templates are versioned rows with effective dates. Every assessment and decision stores the configuration version it used.
2. **One rules language.** A JSON condition language (`all/any/not` with typed fact comparisons) is used by FIPG, E&S triggers, workflow routing, special workflows and document requirements. A separate safe arithmetic formula engine (no `eval`) is used for ratios.
3. **Immutable decisions.** Workflow actions, votes, approved terms, assessment snapshots and audit entries are insert-only, enforced by database triggers. Changes produce new versions.
4. **Backend is the authority.** Approval authority, SOL breaches, CP completeness, task ownership and permitted actions are computed server-side. The UI only reflects them.
5. **Honest integrations.** Every external system sits behind an interface with a mock provider. Mock mode is announced in API responses (`meta.integrationMode`) and shown in a persistent UI banner. Mock data is never presented as live bank data.
