# Requirements Traceability

> **Product name:** this platform is now **Credit360 by AltBank** (product owner direction, 24-Nov-2026). "Gazelle" below is its original working name, kept where it traces to the source PRD/BRD/SWR and to earlier decisions.

`MBP-n` = master build prompt phase; `SWR-n` = item n of the 27-Oct-2026 SWR process table (TC-n = technology control n); `PRD` = PRD/BRD section. Status: **Done** (implemented, tested, documented) · **Partial** (works; a named gap remains) · **Blocked** (needs an external dependency; interface plus labelled mock in place).
Tests live in `apps/api/test/*.test.ts` (API, unit and journey) and `apps/web/e2e/*.spec.ts` (browser).

| Req | Requirement | Implementation | Tests | Status |
|---|---|---|---|---|
| MBP-0 | Architecture, docs, modular design | `docs/architecture-assessment.md`, module layout | — | Done |
| MBP-1 | Bespoke design system, shells | `apps/web/src/styles/*`, `components/ui.tsx`, `Shells.tsx` | browser e2e | Done (brand tokens pending OQ-09) |
| MBP-2 | Customer OTP (6-digit, never in responses, no bypass, server-side), lockout, rate limiting, sessions, device list | `modules/identity/*` | `auth.test.ts` | Done |
| MBP-2 | Staff AD + MFA, RBAC, privileged logging | `identity/routes.ts`, `rbac.ts`, `integrations/live.ts` | `auth.test.ts`, `platform.test.ts` | Done (live LDAPS adapter: Blocked on AD details) |
| MBP-3 | Onboarding (account → OTP → profile → terms → privacy → dashboard); account-opening redirect | `identity/routes.ts`, `pages/public/*` | `auth.test.ts`, e2e | Done |
| MBP-3 | Customer dashboard | `pages/portal/Dashboard.tsx` | e2e | Done |
| MBP-4 | Master business profile (company, ownership, management, banking, value chain, risk declarations), persisted and reused | `modules/profile/routes.ts`, `business_profile_version` | `origination.test.ts` | Done |
| MBP-5 | Configurable FIPG engine with explanations, customer-safe messages | `fipg/service.ts`, `fipg_rule` config | `engines.test.ts`, `origination.test.ts` | Done |
| MBP-6 | Islamic products (Murabaha, Ijarah, Istisna, Salam, Qard, Musharaka, Mudaraba, Direct Investment, Common Stock, Wakalah Bil Istithmar, Kafalah contingents), configurable | `product` config (16 products) | `origination.test.ts` | Done |
| MBP-7 | Facility origination, dynamic product forms, `GZ-FAC-YYYY-NNNNNN` | `facilities/routes.ts`, `validation.ts`, `lib/ids.ts` | `origination.test.ts` | Done |
| MBP-8 | Document engine: dynamic requirements, versions, preview/download, verify/reject, expiry, AV, MIME, size, encryption, signed URLs | `documents/*` | `origination.test.ts` | Done (ClamAV live adapter implemented; dev uses EICAR-only mock) |
| MBP-9 | Financial statements (3 years audited, management accounts with true periods), configurable ratios | `analysis/financial-*` | `engines.test.ts`, `journey.test.ts` | Done |
| MBP-10 | Bank statement analysis (multi-bank/account/currency, parsing, duplicates, missing months, overlaps, wallet share, FX audit, uncertain flags) | `analysis/statement-*` | `engines.test.ts`, `journey.test.ts` | Partial: CSV/XLSX parsed; PDF/image need the OCR adapter (flagged honestly) |
| MBP-11 | Credit bureau via adapter (RC/TIN/BVN), stored metadata, masked identifiers | `analysis/credit-routes.ts`, `integrations` | `journey.test.ts` | Blocked on approved bureau APIs (mock in place) |
| MBP-12 | Exposure (customer, group, pipeline, contingent CCF), SOL and sector limits enforced server-side | `computeExposure`, `risk-engine.ts`, authority override | `engines.test.ts`, `journey.test.ts` | Done (CBA live: Blocked) |
| MBP-13 | Collateral: Shariah-aligned types, haircuts, eligible value, coverage, perfection, expiry | `collateral_type` config, credit routes | `journey.test.ts` | Done |
| MBP-14 | ORR / FRR / industry / collateral / combined; configurable and versioned; history preserved | `risk-engine.ts`, `scorecard`, `rating_model` | `engines.test.ts`, `journey.test.ts`, `platform.test.ts` | Done |
| MBP-15 | RARORAC via adapter, thresholds, exception justification, MOCK labelled | `rarorac_threshold`, `MockRarorac` | `journey.test.ts` | Blocked on the pricing portal (mock labelled everywhere) |
| MBP-16 | E&S trigger (configurable), concurrent with credit analysis | `es_trigger`, PARALLEL stage | `committee.test.ts`, `journey.test.ts` | Done |
| MBP-17–18 | Configurable workflow engine; customer- and RM-initiated routes | `workflow/*`, `workflow_definition` | `journey.test.ts`, `committee.test.ts` | Done |
| MBP-19 | Actions by authority (no Approve above limit) | `actionsFor` | `journey.test.ts` | Done |
| MBP-20 | Committees: quorum, votes, required roles, serial/parallel | `committeeDecision` | `engines.test.ts`, `committee.test.ts` | Done |
| MBP-21 | Insider → Board, PEP route, cash-backed, contingents, product paper, exceptions | authority overrides, `policy_cash_backed`, products | `engines.test.ts` | Done |
| MBP-22 | Task claiming, optimistic locking, reassignment, delegation | `claimTask`, `reassignTask`, `delegation` | `journey.test.ts` | Done |
| MBP-23 | SLA: due, warning, breach, escalation (CRO, EXCO), business calendar | `sla.ts`, `sweep.ts` | `engines.test.ts`, `journey.test.ts` | Done |
| MBP-24 | Clarification threads (sender, recipient, time, read status, attachments) | `threads/*` | `journey.test.ts` | Done |
| MBP-25 | Credit analyst workspace | `pages/work/FacilityWorkspace.tsx` | e2e | Done |
| MBP-26 | Automated credit memo + executive summary | `docgen/service.ts` | `journey.test.ts` | Done |
| MBP-27 | Combined term sheet in Word, versioned, editable with reason | `generateTermSheet`, `docx.ts` | `journey.test.ts` | Done |
| MBP-28 | Executive decision interface | `pages/work/Decision.tsx`, `decision-view` | `journey.test.ts`, e2e | Done |
| MBP-29 | Offer letter templates, maker-checker, accept/reject/negotiate | `offers/*`, `template` config | `journey.test.ts` | Done |
| MBP-30 | Negotiation without modifying approved terms; versioned terms | `decideNegotiation` | `committee.test.ts` | Done |
| MBP-31 | Legal / Shariah / Credit Ops; CP checklist blocks activation | FULFILMENT workflow, `condition_item` | `journey.test.ts` | Done |
| MBP-32 | Activation, facility record, schedule | `activateFacility`, `schedule.ts` | `journey.test.ts` | Done |
| MBP-33 | Monitoring: payments, maturity, reviews, covenants, security expiry, FS refresh | `monitoringSweep` | `journey.test.ts` | Done (renewal / top-up start as new requests) |
| MBP-34–37 | Admin control centre, users, configuration engine, versioning, maker-checker | `admin/routes.ts`, `config/*`, `pages/admin/*` | `platform.test.ts` | Done |
| MBP-38–39 | SLM dashboard, drop-off analytics, filters, downloads | `reports/routes.ts`, report pages | `platform.test.ts` | Done |
| MBP-40–41 | Event-driven notifications (configurable channels), notification centre | `notifications/*` | `platform.test.ts` | Done (SMS/email gateways: Blocked; mock outbox) |
| MBP-42–44 | AI assistance: human-reviewed, explainable, sourced, injection-defended, logged | `modules/ai/*` | `platform.test.ts` | Done (private model endpoint: Blocked on OQ-12; deterministic local provider in use) |
| MBP-45–48 | OWASP controls, data protection, access-control tests, tamper-resistant audit | see `security-model.md` | `auth.test.ts`, `origination.test.ts`, `platform.test.ts` | Done |
| MBP-49–50 | Async long-running jobs, retries, idempotency, dead letters | `jobs/queue.ts`, `worker.ts` | `journey.test.ts` | Done |
| MBP-51 | Adapter integration architecture | `integrations/*` | all | Done |
| MBP-52 | Environment separation, no secrets in source | `config/env.ts`, `.env.example` | — | Done |
| MBP-53 | Demo seed data (ABC Manufacturing; Murabaha, Ijarah, APG; all roles) labelled DEMO | `seed/*` | seed run | Done |
| MBP-54–56 | Unit, integration, E2E, negative tests, workflow matrix | `apps/api/test`, `apps/web/e2e` | 168 API tests, 10 browser journeys | Done |
| MBP-78 | Final security assessment | `security.test.ts`, `pnpm audit` | 12 attack-class tests | Done (external pen test pending) |
| MBP-57–58 | UX QA, accessibility | see `production-readiness.md` | e2e + manual review | Done (formal WCAG audit recommended) |
| MBP-59–60 | Observability, admin system health | `metrics.ts`, `/api/admin/health` | `platform.test.ts` | Done (OTel exporter: Partial) |
| MBP-61 | Data quality and reconciliation | `/api/admin/data-quality` | `platform.test.ts` | Done |
| MBP-62–63 | Relational design, constraints, immutable decisions | migrations | `auth.test.ts`, `journey.test.ts` | Done |
| MBP-64 | No fake functionality; mocks labelled | banner, `MOCK` tags, production refusal | — | Done |
| MBP-77 | Final end-to-end scenario | `journey.test.ts` (Phase 77 block) | passes | Done |

## SWR (27-Oct-2026) and PRD/BRD

| Req | Requirement | Implementation | Tests | Status |
|---|---|---|---|---|
| SWR-1 | Onboarding: account number, name and role; CBA validation; OTP to CBA phone **and** e-mail; account name shown; username = CBA e-mail; password per policy with pop-up; T&C and privacy; welcome e-mail with verification link; dashboard shows account name, number, sector, branch, TIN, RC | `identity/routes.ts`, `identity/password.ts`, `password_policy`, `pages/public/Onboarding.tsx`, `VerifyEmail.tsx`, `portal/Dashboard.tsx` | `auth.test.ts`, e2e Journey 1 | Done (D-22, D-23, D-24) |
| SWR-2 | Spool bank statements from CBA, or upload | `cba.getStatement`, `/bank-statements/spool`, `SpoolStatement.tsx` | `security.test.ts` | Done (live API: Blocked, OQ-25) |
| SWR-2 | FIPG stops the process when minimum criteria are unmet | `fipg/service.ts` (blocking on INELIGIBLE) | `origination.test.ts` | Done |
| SWR-2 | Credit checks: BVN for promoters, RC and TIN for the business | bureau routes | `journey.test.ts` | Blocked on bureau APIs (mock) |
| SWR-2 | 3 years audited + management accounts with stated period; figures with commas | financial engine, `money()` | `engines.test.ts` | Done |
| SWR-2 | Concise credit memo; credit approval memo with CPs | `generateMemo`, CAM term sheet | `journey.test.ts` | Done |
| SWR-2 | AD sync of roles and reporting lines | Interim: staff directory by spreadsheet with maker-checker (`admin/user-import*.ts`, `StaffImport.tsx`); line-manager routing of the Team Lead review | `platform.test.ts`, `journey.test.ts`, e2e | Done as interim (D-49, D-50); AD sync deferred by the product owner |
| SWR-2 | RARORAC validation with exception justification | `rarorac_threshold`, justify route | `journey.test.ts` | Done (portal: Blocked) |
| SWR-2 | Next-step pop-ups | E&S checklist banner, password dialog, dashboard actions | e2e | Done |
| SWR-3 | Islamic facility types, no special characters | `product` config, schema rule | `origination.test.ts` | Done (D-36) |
| SWR-4 | 13 collateral types; clean-up of test types | `collateral_type`, `BASELINE_RETIRED`, `reconcileBaseline` | `platform.test.ts` | Done (D-37) |
| SWR-5 | Terminology: facility and payment (incl. T&C and privacy) | templates, labels, legal terms | `journey.test.ts` (offer text) | Done |
| SWR-6 | Concise memo with financial and statement analysis | `buildMemoContent` | `journey.test.ts` | Done |
| SWR-7 | Customer and RM routes, SWR SLAs, E&S ∥ credit, validator/checker removed, DH added | `workflow_definition`, `sla_policy` | `journey.test.ts`, `committee.test.ts` | Done (D-26, D-34) |
| SWR-9 | Name "Gazelle by Alternative Bank" | shells, documents, e-mails | e2e | Done |
| SWR-10 | E&S checklist prompt for ≥ ₦100m HEART / O&G / Mining / Aviation | `es_trigger` checklist, RM `es.checklist`, workspace banner | `committee.test.ts` | Done (D-35) |
| SWR-11 | SLM profile and reports by facility type and period | `reports/routes.ts` | `platform.test.ts` | Done |
| SWR §2 output | Statement table: months, debit, credit, closing balances, wallet share (%), FCY converted | `statement-analysis.ts`, `financials.tsx` | `journey.test.ts` | Done (D-43) |
| SWR TC-2, 5, 6 | Generic identity responses; rate limiting; statement owner check | onboarding start, `AUTH_LIMIT`, spool route | `auth.test.ts`, `security.test.ts` | Done |
| SWR TC-11, 12 | 6-digit OTP never returned; AD + MFA for admins | `otp.ts`, staff login | `auth.test.ts` | Done |
| SWR TC-13 | Requests within authorised limits | aggregate-exposure authority amount | `committee.test.ts` | Done (D-33) |
| SWR TC-17, 22; master prompt (session timeout) | Configurable session timeout with advance warning, stay-signed-in, passive polling, unsaved-entry restore; restrict concurrent logins | `session_policy` config, `identity/session.ts`, `lib/session-timeout.tsx`, `lib/unsaved.ts`, `enforceSingleSession` | `session-policy.test.ts`, `auth.test.ts`, `e2e/session-timeout.spec.ts` | Done (D-38, D-39, D-54) |
| PRD | Approval grid by workflow type; combination and concurrence; insider / PEP to Board; aggregate exposure | `approval_authority` ×4, `resolveChain` | `engines.test.ts`, `journey.test.ts`, `committee.test.ts` | Done (D-27–D-30, D-33) |
| PRD | Committee signatures (MIC 3 NED + 2 ED incl. MD; BRMC chair + 2 NED; Board chairman); single access to record decision | `committee` config, `requiredRoleCounts`, `RECORD_DECISION` | `engines.test.ts`, `committee.test.ts` | Done (D-31) |
| PRD | Decline behaviour per stage | `onDecline` | `journey.test.ts` | Done (D-32) |
| PRD | Cash-backed ≥ 110% | `policy_cash_backed` | `engines.test.ts` | Done (D-25) |
| PRD | Combined term sheet in CAM format, Word, auto-generated and updated, names and timestamps, all names at the bottom, view / edit / download | `docgen/cam.ts`, `termsheet.refresh` job, `memo.tsx` | `journey.test.ts` | Done (D-40) |
| PRD | Offer letter sign-off bands; maker-checker | `offer_signoff`, `signOffer` | `journey.test.ts`, `committee.test.ts` | Done (D-41) |
| PRD | Block / unblock customers (checker to unblock); export users to Excel; single admin session | admin routes, `Users.tsx` | `platform.test.ts`, `auth.test.ts` | Done (D-47, D-39) |
| PRD | Product paper workflows | — | — | Open (OQ-28) |
| SWR TC-12 (interim) | Staff sign-in without AD: Gazelle password + MFA | `identity/staff-credentials.ts`, staff login, `StaffSetPassword.tsx`, `StaffForgotPassword.tsx`, `staff:activation-link` | `staff-local-auth.test.ts`, `e2e/local-auth.spec.ts` | Done as an approved interim (D-51) |
| PO 19-Nov | More than one portal user per business, per-user rights | `profile/portal-users.ts`, `requireCustomerRight`, `portal/Users.tsx`, `AcceptInvite.tsx` | `portal-users.test.ts`, e2e | Done (D-52) |
| PO 19-Nov | Facility efficiency ratio set on management / Board direction | `facility_efficiency_ratio` config, `analysis/efficiency.ts`, CAM §25, `EfficiencyRatioEditor` | `platform.test.ts` | Done (D-53) |
| Master prompt — E2E scenarios (PEP, insider, SOL breach, cash-backed) | Each driven through the live workflow from customer submission to the resolved approval chain; chain asserted against the approved authority matrix | `workflow/engine.ts`, `workflow/authority.ts`, `facilities/facts.ts` | `scenarios.test.ts`, `engines.test.ts` | Done |
| Master prompt — work queue | Search, SLA / stage / product filters, sortable columns (aria-sort), priority labels, view kept in the URL | `pages/work/Tasks.tsx` | `e2e/queue.spec.ts` | Done |
| Credit360 §13 — promoter BVN + NIN verification | Consent; server-side BVN and NIN checks; comparison with the entered details, the other record and the bank record; explicit states; duplicate prevention; daily limits; stale on edit; two-person discrepancy review; submission gate; masking and encryption; sandbox labelled | `identity/verification.ts`, `identity/verification-routes.ts`, migration `0015`, `portal/parts/Identity.tsx`, `work/IdentityReviews.tsx` | `identity-verification.test.ts`, `e2e/identity.spec.ts` | Done (sandbox provider; live providers pending C-04) |
| Credit360 §1–3, §7 — product identity, brand tokens, light and dark | Credit360 by AltBank everywhere visible; provisional charcoal / gold / cream tokens; Plus Jakarta Sans; typographic lockup pending the logo file | `packages/shared/src/brand.ts`, `styles/tokens.css`, `components/Shells.tsx`, `docgen/docx.ts` | `e2e/visual.spec.ts` | Partial (logo file and approved colour codes pending C-01, C-02) |
