# Production Readiness

Assessment of the current build against MBP Phase 72. **PASS** means implemented and verified by automated tests in this repository. **CONDITIONAL** means the platform side is complete, but go-live depends on an external dependency or a bank process listed next to it. Nothing is marked PASS on the strength of UI alone.

| Area | Verdict | Evidence | Condition for go-live |
|---|---|---|---|
| Security | CONDITIONAL | 190 API tests (incl. deny-by-default proof over every route) incl. `auth`, `security`, `platform` suites; OWASP controls in `security-model.md`; `pnpm audit` clean | Independent penetration test by Group InfoSec; WAF at the API Gateway |
| Functional requirements | CONDITIONAL | `requirements-traceability.md` (MBP, SWR and PRD sections); conflicts in `requirements-decisions.md` D-21 to D-48 | Business sign-off of the SWR/PRD decisions and the open questions OQ-17 to OQ-30; SWR item 7 pilot test before production (SWR TC-7) |
| Workflow | PASS | SWR routes (RM–TL–RBE–DH–[E&S ∥ CA]–TL CA–HCR–CRO–ED–MD–MIC–BRMC–Board), PRD approval grid per workflow type with combination and concurrence levels, aggregate-exposure authority, insider/PEP full chain, committee signature rules, decision recorded from minutes, per-stage decline behaviour, returns, SWR SLAs and PRD escalation, segregation of duties (`journey`, `committee`, `engines`) | Credit Risk confirmation of OQ-18 and OQ-29 |
| Financial calculations | PASS | Ratios, annualisation, statement turnover, FX, exposure with CCF, collateral haircuts, RARORAC threshold, payment schedules (`engines`, `journey`) | Ratio bands and weights confirmed by Credit Risk |
| Access control | PASS | RBAC + object-level checks + 404 for inaccessible records; matrix tests at API level; browser route guards | — |
| Audit | PASS | Hash-chained, trigger-protected audit log; immutable decision tables; verification in the UI | Off-site log shipping to the SIEM |
| Performance | CONDITIONAL | Long-running work (statement parsing, document scanning, notifications) is asynchronous; indexed queries; route latency metrics. API journeys run in milliseconds per call locally | Load test at expected volumes on production-like infrastructure |
| Accessibility | CONDITIONAL | Semantic HTML, labelled controls (tested), visible focus (tested), skip links, keyboard dialogs, reduced motion, contrast-checked palette | Formal WCAG 2.2 AA audit with assistive technology |
| Error handling | PASS | Safe error envelope with reference; no stack traces (tested); idempotent retries; dead-letter queue | — |
| Staff directory | CONDITIONAL | Staff directory loaded by spreadsheet with maker-checker until AD synchronisation (D-49) | Interim staff sign-in (Gazelle password + MFA) available with an InfoSec approval reference (D-51); AD authentication and sync to follow |
| Integration readiness (adapters) | CONDITIONAL | Adapter interfaces for CBA, AD, bureau, identity, RARORAC, messaging, AV, AI; ClamAV live adapter implemented; production refuses mock mode | Live adapters against the Bank API Gateway (OQ-10, OQ-12) |
| Data protection | PASS | Field encryption (BVN, MFA), envelope-encrypted documents, masking, customer-safe projections, NDPA consent capture | DPO sign-off on retention periods |
| Disaster recovery | CONDITIONAL | Stateless API, PITR-ready PostgreSQL, idempotent jobs; runbook | DR test with RPO/RTO agreed by IT Risk |
| Monitoring | PASS | Health and readiness endpoints, Prometheus metrics, System health dashboard, data-quality checks | Wire to the Bank's monitoring stack |
| Documentation | PASS | `docs/` set; README; runbook | — |

## Test inventory (last run)

* API (Vitest, real PostgreSQL): **190 tests** — deny-by-default access over every `/api` route and API-reference freshness, session policy and per-user rate limit, master-prompt scenarios through the live workflow (PEP, insider, SOL breach, cash-backed), p95 performance budgets, auth & OTP security, kernel, engines (financial, statements, XLSX, FX, authority, committee, SLA, FIPG, scorecards, exposure), origination, documents, full Phase 77 journey, committee & negotiation, platform (config maker-checker, privileged access, access-control matrix, AI guard, reports, notifications, health), portal users and rights (invitation, own-mobile OTP, rights enforcement, last-manager rule), facility efficiency ratio (validation, computation, versions), interim staff sign-in (activation and reset links, policy, history, expiry, lockout, admin reset, production guard), baseline-release reconciliation, customer block/unblock, user export, statement spooling owner check, SWR onboarding (password policy, generic start response, welcome link, single business registration, single session), CAM term sheet, offer sign-off, security assessment (IDOR, ID manipulation, mass assignment, SQLi, XSS, path traversal, SSRF, workflow manipulation, replay, session separation, oversized upload, secret leakage). Stable across shuffled file orders.
* Browser (Playwright, isolated DB): **8 journeys** in directory mode (incl. inviting a colleague to the portal) (`pnpm e2e`) plus **2** in interim local sign-in mode (`pnpm e2e:local`: activation, password policy pop-up, MFA enrolment, admin activation link, generic forgotten-password response) — staff directory import with second-administrator approval, SWR onboarding (account + name + role, wrong-code retry, account name after OTP, password pop-up, welcome link, CBA details on the dashboard), offer acceptance, analyst claim and prerequisites, executive decision view, customer → staff route guard, accessibility basics.
* Browser quality gates: **visual suite** (every major screen, light and dark, 1440/1280/1024/768 px plus 390 px for customer screens; overlap, clipping, overflow, axe WCAG 2.1 AA; extreme data), **session timeout** (warning, stay signed in, expiry, restore typed entries, passive polling), **work queue** (search, filters, sort, priority, URL state), theme persistence across devices. Total: **20** directory-mode + **2** local-mode browser tests.
* CI: `.github/workflows/ci.yml` runs all of the above on every push.

## Phase 79 persona review (summary)

| Persona | Finding | Action taken |
|---|---|---|
| Corporate customer | Always sees "currently with" and "what happens next"; returned items are listed with exactly what is needed | Fixed wrapping references and the mobile two-column collapse; fee-based offers now say "Commission" |
| RM / BM | Portfolio list included only customers with requests | Added the portfolio-scoped `/api/customers` |
| Credit analyst | Too many tabs scrolled off-screen | Tabs wrap; the rail lists every outstanding prerequisite |
| E&S analyst | Works concurrently; questionnaire produces a category | — |
| Executive | Decision readable in under two minutes; roles showed as codes | Role names everywhere |
| Credit Operations | Conditions grouped by team with blocking count; activation refuses with the outstanding list | Evidence slots made idempotent |
| Admin | Approved configuration was shown as raw JSON | Read-only structured views; maker identity by id |
