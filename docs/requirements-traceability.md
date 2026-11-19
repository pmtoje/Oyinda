# Requirements Traceability

`MBP-n` = master build prompt phase. Status: **Done** (implemented, tested, documented) · **Partial** (works; a named gap remains) · **Blocked** (needs an external dependency; interface plus labelled mock in place).
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
| MBP-16 | E&S trigger (configurable), concurrent with credit analysis | `es_trigger`, PARALLEL stage | `journey.test.ts` | Done (sector group pending OQ-05) |
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
| MBP-54–56 | Unit, integration, E2E, negative tests, workflow matrix | `apps/api/test`, `apps/web/e2e` | 135 API tests, 6 browser journeys | Done |
| MBP-78 | Final security assessment | `security.test.ts`, `pnpm audit` | 12 attack-class tests | Done (external pen test pending) |
| MBP-57–58 | UX QA, accessibility | see `production-readiness.md` | e2e + manual review | Done (formal WCAG audit recommended) |
| MBP-59–60 | Observability, admin system health | `metrics.ts`, `/api/admin/health` | `platform.test.ts` | Done (OTel exporter: Partial) |
| MBP-61 | Data quality and reconciliation | `/api/admin/data-quality` | `platform.test.ts` | Done |
| MBP-62–63 | Relational design, constraints, immutable decisions | migrations | `auth.test.ts`, `journey.test.ts` | Done |
| MBP-64 | No fake functionality; mocks labelled | banner, `MOCK` tags, production refusal | — | Done |
| MBP-77 | Final end-to-end scenario | `journey.test.ts` (Phase 77 block) | passes | Done |
