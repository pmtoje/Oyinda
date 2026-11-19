# Production Readiness

Assessment of the current build against MBP Phase 72. **PASS** means implemented and verified by automated tests in this repository. **CONDITIONAL** means the platform side is complete, but go-live depends on an external dependency or a bank process listed next to it. Nothing is marked PASS on the strength of UI alone.

| Area | Verdict | Evidence | Condition for go-live |
|---|---|---|---|
| Security | CONDITIONAL | 149 API tests incl. `auth`, `security`, `platform` suites; OWASP controls in `security-model.md`; `pnpm audit` clean | Independent penetration test by Group InfoSec; WAF at the API Gateway |
| Functional requirements | CONDITIONAL | `requirements-traceability.md` (MBP, SWR and PRD sections); conflicts in `requirements-decisions.md` D-21 to D-48 | Business sign-off of the SWR/PRD decisions and the open questions OQ-17 to OQ-30; SWR item 7 pilot test before production (SWR TC-7) |
| Workflow | PASS | SWR routes (RM–TL–RBE–DH–[E&S ∥ CA]–TL CA–HCR–CRO–ED–MD–MIC–BRMC–Board), PRD approval grid per workflow type with combination and concurrence levels, aggregate-exposure authority, insider/PEP full chain, committee signature rules, decision recorded from minutes, per-stage decline behaviour, returns, SWR SLAs and PRD escalation, segregation of duties (`journey`, `committee`, `engines`) | Credit Risk confirmation of OQ-18 and OQ-29 |
| Financial calculations | PASS | Ratios, annualisation, statement turnover, FX, exposure with CCF, collateral haircuts, RARORAC threshold, payment schedules (`engines`, `journey`) | Ratio bands and weights confirmed by Credit Risk |
| Access control | PASS | RBAC + object-level checks + 404 for inaccessible records; matrix tests at API level; browser route guards | — |
| Audit | PASS | Hash-chained, trigger-protected audit log; immutable decision tables; verification in the UI | Off-site log shipping to the SIEM |
| Performance | CONDITIONAL | Long-running work (statement parsing, document scanning, notifications) is asynchronous; indexed queries; route latency metrics. API journeys run in milliseconds per call locally | Load test at expected volumes on production-like infrastructure |
| Accessibility | CONDITIONAL | Semantic HTML, labelled controls (tested), visible focus (tested), skip links, keyboard dialogs, reduced motion, contrast-checked palette | Formal WCAG 2.2 AA audit with assistive technology |
| Error handling | PASS | Safe error envelope with reference; no stack traces (tested); idempotent retries; dead-letter queue | — |
| Staff directory | CONDITIONAL | Staff directory loaded by spreadsheet with maker-checker until AD synchronisation (D-49) | Staff sign-in still needs the AD adapter, or an approved interim (OQ-31) |
| Integration readiness (adapters) | CONDITIONAL | Adapter interfaces for CBA, AD, bureau, identity, RARORAC, messaging, AV, AI; ClamAV live adapter implemented; production refuses mock mode | Live adapters against the Bank API Gateway (OQ-10, OQ-12) |
| Data protection | PASS | Field encryption (BVN, MFA), envelope-encrypted documents, masking, customer-safe projections, NDPA consent capture | DPO sign-off on retention periods |
| Disaster recovery | CONDITIONAL | Stateless API, PITR-ready PostgreSQL, idempotent jobs; runbook | DR test with RPO/RTO agreed by IT Risk |
| Monitoring | PASS | Health and readiness endpoints, Prometheus metrics, System health dashboard, data-quality checks | Wire to the Bank's monitoring stack |
| Documentation | PASS | `docs/` set; README; runbook | — |

## Test inventory (last run)

* API (Vitest, real PostgreSQL): **149 tests** — auth & OTP security, kernel, engines (financial, statements, XLSX, FX, authority, committee, SLA, FIPG, scorecards, exposure), origination, documents, full Phase 77 journey, committee & negotiation, platform (config maker-checker, privileged access, access-control matrix, AI guard, reports, notifications, health), baseline-release reconciliation, customer block/unblock, user export, statement spooling owner check, SWR onboarding (password policy, generic start response, welcome link, single business registration, single session), CAM term sheet, offer sign-off, security assessment (IDOR, ID manipulation, mass assignment, SQLi, XSS, path traversal, SSRF, workflow manipulation, replay, session separation, oversized upload, secret leakage). Stable across shuffled file orders.
* Browser (Playwright, isolated DB): **7 journeys** — staff directory import with second-administrator approval, SWR onboarding (account + name + role, wrong-code retry, account name after OTP, password pop-up, welcome link, CBA details on the dashboard), offer acceptance, analyst claim and prerequisites, executive decision view, customer → staff route guard, accessibility basics.

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
