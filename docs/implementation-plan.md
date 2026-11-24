# Implementation Plan

> **Product name:** this platform is now **Credit360 by AltBank** (product owner direction, 24-Nov-2026). "Gazelle" below is its original working name, kept where it traces to the source PRD/BRD/SWR and to earlier decisions.

Gazelle is built in the phase order set by the master build prompt (MBP). Every phase follows the same loop: implement → test → security check → fix → retest → UX review → requirements check → docs → commit.

| # | Phase | Main deliverables | Status |
|---|---|---|---|
| 0 | Discovery & foundation | Architecture assessment, schema (7 migrations), config engine, adapters, test harness | Done |
| 1 | Design system & shell | Tokenised CSS design system, app shells for portal, workspace and admin | See traceability |
| 2 | Auth & security | Customer OTP onboarding/login, staff AD + TOTP MFA, sessions, CSRF, rate limits, lockout, audit chain | Done |
| 3 | Onboarding & dashboard | Existing-account onboarding journey, customer dashboard | See traceability |
| 4 | Business profile | Master profile, parties, banking, counterparties, risk declarations, versioned snapshots | See traceability |
| 5 | FIPG engine | Configurable rules, explanations, customer-safe messages | See traceability |
| 6–7 | Products & origination | 16 configurable Islamic products, dynamic forms, GZ-FAC IDs, idempotent creation | See traceability |
| 8 | Documents | Requirements engine, encrypted storage, AV scan, MIME sniffing, versions, signed grants | See traceability |
| 9–10 | Financial & bank statements | Line-item capture, configurable ratios, statement parsing, turnover, FX | See traceability |
| 11–16 | Bureau, exposure, collateral, risk, RARORAC, E&S | Adapters plus backend-enforced calculations | See traceability |
| 17–24 | Workflow engine | Configurable routing, authority, committees, special workflows, claiming, SLA, threads | See traceability |
| 25–28 | Workspaces | Analyst workspace, credit memo, Word term sheet, executive decision view | See traceability |
| 29–33 | Offer → monitoring | Offer templates, maker-checker, negotiation, CP checklist, activation, disbursement, monitoring | See traceability |
| 34–41 | Admin, config, reporting, notifications | Control centre, maker-checker config, SLM dashboards, drop-off, notification centre | See traceability |
| 42–44 | AI assistance | Human-reviewed AI with sources, injection defence, audit | See traceability |
| 45–61 | Hardening, observability, data quality | OWASP controls, health dashboard, reconciliation | See traceability |
| 72–80 | Readiness | E2E scenario, security test, UX test, readiness checklist | See `production-readiness.md` |

Status per requirement is tracked in `requirements-traceability.md`, the single source of truth for what is built, tested and outstanding.

## Working agreements

* **No placeholders.** If something cannot be finished (for example a live integration without credentials), it has an interface, a clearly labelled mock, and an open question. It is never a "coming soon" button.
* **Configuration over code.** A business rule that might change goes in `config_item` with maker-checker approval.
* **Server is the authority.** Every authorisation, limit and state transition is enforced in the API and tested at API level.
