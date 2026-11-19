# Gap assessment — Master Enterprise Product Prompt (§0–§100)

Assessed 19-Nov-2026 against branch `claude/gazelle-platform-build-1iq76a`. Each section of the master prompt is marked:

* **Met**: implemented and covered by automated tests (named).
* **Met (interim)**: implemented with an agreed interim arrangement; the condition is listed.
* **Partial**: the core is in place; what is missing is listed.
* **Open (external)**: blocked on a Bank decision, credential or system. Each one is tracked in `open-questions.md`.

Detail for every requirement is in `requirements-traceability.md`, and conflicts between sources are in `requirements-decisions.md`.

## Summary

| Area | Status |
| --- | --- |
| Product flows (onboarding → facility → assessment → approval → offer → fulfilment → monitoring) | Met |
| Configurability (rules, limits, SLAs, workflow, authority, committees, session timeout, efficiency ratio, templates) | Met: no business rule is hard-coded |
| Security and access control | Met, plus the external conditions in `production-readiness.md` |
| Design system, light and dark themes, zero-collision gates | Met. Brand palette is a placeholder (OQ-09) |
| Testing (unit/API, E2E scenarios 1–10, visual, accessibility, performance, extreme data) | Met. Volume/load testing at Bank scale is open |
| Integrations (CBA/T24, bureau, AD, messaging, AV, RARORAC, AI, OCR) | Adapters and mocks only; live connections open (external) |
| CI/CD | Pipeline defined; first run on GitHub not yet observed |

## Section by section

| § | Topic | Status | Evidence / what remains |
| --- | --- | --- | --- |
| 0–3 | Role, sources, vision, "where am I / what next" | Met | SWR authoritative, conflicts in D-01…D-54. Every portal facility shows *Currently with*, *What happens next* and a step indicator. The staff rail lists outstanding prerequisites. |
| 4–5 | Design benchmark, visual personality | Partial | Restrained, typographic design system (`styles/tokens.css`). A formal design review with the Bank's brand team, and the approved palette and typeface licence (OQ-09), are outstanding. |
| 6–8 | Light + dark mode, colour system | Met | Three-layer tokens (palette → semantic per theme → aliases); no raw colours in components. Light, Dark and Match-device modes, applied before first paint and saved to the account. Tests: `e2e/visual.spec.ts` (both themes, axe colour contrast), theme persistence test. |
| 9 | Zero visual collision | Met | Automated checks on every major screen at 1440/1280/1024/768 (customer screens also at 390): page overflow, overlapping text, clipped figures and field values, content escaping panels. Defects found and fixed: authority editor, status pills, metric tiles, top bar, onboarding on a phone, step labels. |
| 10 | Financial number presentation | Met | Kobo integers end to end; tabular numerals, right-aligned amounts, grouped thousands in inputs (`NairaField`), currency always shown. Extreme amounts (₦987bn) tested visually. |
| 11–16 | Hierarchy, progressive disclosure, customer experience, speed, engagement, forms | Met | Step-saved drafts; return-for-rework lists exactly what is needed; inline validation with field-level messages; summary-first decision view. |
| 17 | Authentication | Met (interim) | Customers: password + OTP, lockout, single session. Staff: TOTP MFA after directory sign-in. Until Active Directory: Gazelle password + authenticator (D-51, production needs an InfoSec approval reference). |
| 18 | Session management | Met | `session_policy` (maker-checker), warning dialog with *Stay signed in*, passive polling, cross-tab sync, kept unsaved entries (D-54). Tests: `session-policy.test.ts`, `e2e/session-timeout.spec.ts`. |
| 19 | RBAC | Met | Permissions per role; object-level checks; deny-by-default gate on every `/api` route proven by `access.test.ts`. |
| 20 | Maker-checker | Met | Configuration, user import, customer unblock, offers, disbursements. Tests: `platform.test.ts`, `scenarios.test.ts`, `session-policy.test.ts`. |
| 21–22 | Onboarding, business profile | Met | CBA lookup + OTP; more than one portal user per business with rights (D-52). Tests: `auth.test.ts`, `portal-users.test.ts`, browser journey 1. |
| 23–27 | Eligibility, Islamic products, initiation, facility types, cash-backed logic | Met | Configurable FIPG rules and product catalogue; conventional types excluded pending OQ-26; cash-backed classification and matrices (`scenarios.test.ts` scenario 4). |
| 28 | Document management | Met | Versioned, envelope-encrypted, malware-scanned uploads; single-use 60-second download grants. |
| 29 | Document intelligence | Partial | CSV bank statements are parsed automatically. OCR of PDF or scanned statements and financial statements needs a provider (OQ-15). |
| 30–38 | Financial / statement analysis, bureau, exposure, collateral, ORR/FRR, industry, E&S, RARORAC | Met (mock integrations) | Calculations are traceable and tested (`engines.test.ts`, `journey.test.ts`). Bureau, T24 exposure and RARORAC run through mock adapters, clearly labelled MOCK in the UI (OQ-10, OQ-25). |
| 39–43 | Approval workflow, routing, actions, limits, insider/PEP | Met | Configured workflows and authority matrices; aggregate-exposure basis; overrides. Scenarios 3–6 run through the live workflow in `scenarios.test.ts`. |
| 44–46 | Timeline, SLA engine, work queue | Met | Business-hours SLA with warning, breach and escalation (`journey.test.ts`). Queue search, filters, sort and priority (`e2e/queue.spec.ts`). |
| 47–50 | Threads, analyst workspace, executive decision view, credit memo | Met | Clarification threads kept in Gazelle; the decision view is readable in under two minutes (persona review). |
| 51–55 | Term sheet, offer letter, acceptance, Legal/Shariah/Credit Ops, disbursement | Met | CAM 27-section term sheet; offer sign-off bands; negotiation creates terms v2 (`committee.test.ts`); maker-checker disbursement with double-submission protection. |
| 56 | Monitoring | Met | Overdue detection and resolution (journey 12). |
| 57–59 | Admin control centre, configuration engine, rule versioning | Met | Structured editors (authority, SLA, FIPG, ratios, committees, E&S, efficiency ratio, session timeout); versions are never rewritten; baseline releases. |
| 60–62 | Reporting, drop-off analytics, notifications | Met | SLM dashboard, drop-off funnel (step order to confirm, OQ-16), CSV/Excel exports, configurable notification rules. |
| 63–64 | AI, AI security | Met (mock) | AI drafts only and never decides. Output needs human review; prompt-injection guard and claim validation (`platform.test.ts`). A private model deployment is open (OQ-12). |
| 65–66 | Integration and API architecture | Met | Adapter interfaces per system; mock / live mode visible in a persistent banner. `docs/api-reference.md` is generated from the routes and checked by a test. |
| 67–70 | Database, audit, data protection, file security | Met | Migrations; immutable decision tables; hash-chained audit with verification; field encryption; NDPA consent. |
| 71 / 87 | Performance | Partial | Asynchronous heavy work; p95 budgets per key endpoint (`performance.test.ts`, results in `test-results/performance.json`); layered rate limits. **Open:** a volume and load test at Bank scale (production-like data volumes, concurrent users) on the target infrastructure. |
| 72 / 86 | Responsive design and testing | Met | Staff workspace from 768 px; customer screens down to 390 px; all checked automatically in both themes. |
| 73 | Accessibility | Met (automated) | axe WCAG 2.1 A/AA scan on every major screen in both themes; keyboard-reachable scroll regions; accessible dialogs; sortable headers with `aria-sort`. **Recommended:** a manual screen-reader audit before go-live. |
| 74–80 | Design system, tokens, micro-interactions, loading, empty states, tables, dashboards | Met | Shared components; skeletons; specific empty states; theme transitions respect reduced motion. |
| 81 | Security testing | Met (automated) | `security.test.ts`, `access.test.ts`, CSRF / Origin / rate limit / lockout tests; `pnpm audit` clean. **Open (external):** independent penetration test. |
| 82–83 | Automated tests; E2E scenarios 1–10 | Met | 1: `journey.test.ts` + browser journeys · 2: return-for-rework test · 3–6: `scenarios.test.ts` · 7: Team Lead decline · 8: negotiation → terms v2 · 9: SLA sweep and escalation · 10: maker-checker config tests. |
| 84–85 | Extreme data, visual regression | Met | Very long names, ₦987bn amounts and long text in the visual suite. Pixel baselines are kept for the public screens; collision and accessibility checks run on all screens. |
| 88–90 | Observability, error handling, data quality | Met | Health and readiness endpoints, Prometheus metrics, request IDs, a safe error envelope, a dead-letter queue, data-quality checks. Wiring to the Bank's monitoring stack is an infrastructure task. |
| 91 | No fake functionality | Met | Every mock is labelled in the UI and in production refuses to start. Nothing is presented as live when it is not. |
| 92 | Code quality | Met | Strict TypeScript (`pnpm typecheck`) plus ESLint (`eslint.config.mjs`: recommended JS and TypeScript rules, React Hooks rules, no stray console output, documented exemptions only), zero warnings allowed (`pnpm lint`), both in CI. Formatting is not enforced by a tool (no Prettier). |
| 93–94 | Environments, CI/CD | Partial | Environment validation with production guards. `.github/workflows/ci.yml`: typecheck → lint → API tests (PostgreSQL) → build → audit → browser suites → artefacts. **Not yet observed running on GitHub.** Deployment (CD) to the Bank's environments depends on its platform. |
| 95–96 | Documentation, traceability | Met | `docs/` (architecture, data model, security, workflow, runbook, readiness, API reference, decisions, open questions, traceability). |
| 98–100 | UX acceptance, absolute design rules, final standard | Partial | The absolute design rules are enforced automatically where they can be measured (collisions, clipping, contrast, dark/light, hard-coded rules). Beauty, trust and "would I use this" need the Bank's design and business sign-off with real users. |

## Remaining work, in priority order

1. **External connections and decisions:** Active Directory, CBA/T24 statements and exposure, credit bureau, messaging, OCR, private AI, brand palette. See `open-questions.md` (OQ-09, 10, 12, 15, 25, 31).
2. **Independent penetration test** and DPO sign-off (`production-readiness.md`).
3. **Load and volume test** on production-like infrastructure and data volumes.
4. **First CI run on GitHub:** confirm the pipeline passes. If pixel baselines are wanted on CI, record them on the CI image (`VISUAL_BASELINES=strict`).
5. Optional: a code formatter (Prettier) if the Bank's engineering standards require one.
6. **Manual accessibility audit** with a screen reader, and a **design review** with the Bank's brand team and a few real users of each persona.
