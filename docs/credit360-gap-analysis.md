# Credit360 by AltBank — Phase 0 audit, gap map and roadmap

Prepared 24-Nov-2026 against the *Credit360 by AltBank — Definitive Master Development Prompt (Brand Identity Edition)*.
Branch `claude/gazelle-platform-build-1iq76a`. Status words: **Built** (implemented and tested), **Partial** (core in place, gaps listed), **Gap** (not yet built), **Blocked** (needs an input from the Bank).

## 1. What exists (audit summary)

The repository already holds a working, tested platform, built as "Gazelle". Per the prompt's Part XII §38, it is extended here, not replaced.

| Area | State |
| --- | --- |
| Stack | pnpm monorepo: Fastify 5 + PostgreSQL API (`apps/api`), React 19 + Vite web (`apps/web`), shared rules/formula/brand package (`packages/shared`). |
| Customer portal | Onboarding against core banking + OTP, password policy, multiple portal users with rights, business profile, guided application (7 steps, autosave per step), documents, tracking, clarifications, offers (accept / negotiate / reject). |
| Staff workspaces | RM / BM / RBE / DH review, credit analyst workspace (financials, statements, bureau, exposure, collateral, ORR/FRR/industry, RARORAC, E&S, memo), executive decision view, Legal / Shariah / Credit Ops fulfilment, disbursement maker-checker, monitoring. |
| Workflow | Configurable workflows and authority matrices (aggregate exposure, cash-backed, contingent, insider, PEP, SOL overrides), committees, SLA engine with business calendar and escalation, delegation. |
| Administration | Maker-checker configuration for products, rules, authority, SLA, templates, session policy, efficiency ratio; staff import; audit with hash chain; health and data quality. |
| Security | Deny-by-default API gate, CSRF, layered rate limits, MFA, field encryption, single session, configurable timeout, malware scanning, single-use download grants. |
| Quality | 190 API tests, 20 + 2 browser tests (journeys, visual collision + accessibility in light/dark, session timeout, queue), CI pipeline, generated API reference. |

## 2. Gap map against the Credit360 prompt

| Prompt part | Status | Notes / remaining work |
| --- | --- | --- |
| I §1 Product identity | **Built** | Every customer- and staff-visible name, e-mail, SMS, authenticator label, Word document and browser title is now *Credit360 by AltBank* (single source: `packages/shared/src/brand.ts`). Kept for compatibility (not customer-visible as a name): package names `@gazelle/*`, cookie `gz_session`, storage key `gz-theme`, historical migrations. See decision C-03 for reference prefixes. |
| I §2 Logo | **Blocked** | The logo image referred to in the prompt was **not received**. The prompt forbids inventing a mark, so the product uses a *typographic* lockup that follows the described characteristics ("Credit" charcoal, "360" gold, "by AltBank" beneath) and a clearly marked **provisional** icon (`apps/web/public/credit360-icon.svg`: a bold rounded C in gold on charcoal, without the orbit or sparkle). On receipt of the file: retain the original, reconstruct SVG variants (horizontal, compact, light, dark, icon-only), favicon and app icons, then replace the `Wordmark` component and the provisional icon. |
| I §3 Brand compliance | **Partial** | Palette, typography and radii re-tokenised (charcoal, warm gold, cream, warm neutrals). Values are **provisional** (derived from the brand description) and need reconciliation with AltBank's approved corporate codes and the logo file (decision C-01). |
| II §4–6 Design, personality, typography | **Partial** | Plus Jakarta Sans (SIL OFL 1.1, self-hosted, no third-party requests) with a weight scale; rounded radii; gold reserved for primary actions, the active item and the "360". Customer dashboard now leads with *Welcome back* / *Your financing journey*. Further refinement in Phase 18 (design review), with the logo in hand. |
| II §7 Light and dark | **Built** | Both themes are re-designed on the new palette (light header keeps the charcoal wordmark; dark is deep charcoal, not inverted); system preference, persistence per account, applied before first paint; print and Word documents are theme-independent. |
| II §8 Zero overlap | **Built / extending** | Automated collision, clipping and overflow checks on every major screen at 1440/1280/1024/768 (+390 customer) in both themes. The rebrand's wider typeface exposed tables that could overflow; **all 24 data tables** now scroll within their panel. Extending to 320/375/1920 and browser zoom (Phase 2, task tracked). |
| II §9 UX principles | **Built** | "Where am I / what's next" on every request; real-completion progress; autosave; inline validation; empty states; kept unsaved entries after timeout. |
| III §10 Five experiences | **Built** | Customer portal, RM/business review, credit & risk workspace, post-approval workspace, admin control centre — separate navigation and permissions on one platform. |
| IV §11 Registration/login | **Built** | Customer password + OTP; staff directory or interim password + TOTP; step-up re-entry of password for sensitive customer actions; configurable session timeout. |
| IV §12 Business onboarding | **Partial** | Core-banking verified details, profile, parties (directors, shareholders, key executives), ownership checks. Gaps: CAC / tax registry verification adapters (provenance is already separated: "on the Bank's records" vs entered). |
| **IV §13 Promoter BVN + NIN verification** | **Gap → in progress** | Only a BVN *field* exists today (encrypted, masked). Needed: a controlled verification subsystem — "Verify your identity" step, BVN *and* NIN with consent, provider adapters (sandbox, honest states), comparison with bank records, explicit states, discrepancy review and escalation, masking/encryption/rate limiting/audit, submission gate. **Next phase (task #20).** |
| IV §14 Eligibility / FIPG | **Built** | Configurable rule engine with maker-checker; outcomes explained; no policy in UI code. |
| IV §15 Application journey | **Built** | Stage navigator adapted by product; summary before submission; customer- and RM-initiated. Promoter verification will become a stage once §13 is built. |
| V §16 Non-interest product engine | **Built** | Murabaha, Ijarah, Istisna, Salam, Qard, Musharaka, Mudaraba, Wakalah Bil Istithmar, Kafalah guarantees, investment structures — each with its own fields, Shariah structure, limits, pricing basis (profit rate or fee), documents, conditions. All templates require Bank Legal / Risk / Shariah sign-off before production (C-06). |
| VI §17 Documents | **Built** | Versioning, malware scan, review / reject / resubmit, expiry, role-based access, single-use download grants. Gaps: drag-and-drop zone and inline preview polish (Phase 6). |
| VI §18–19 Financial and statement analysis | **Built** | Three-year statements, ratios with documented formulas, statement turnover, FX, analyst adjustments. |
| VI §20 Bureau and exposure | **Built (mock adapters)** | Aggregate exposure with CCF, de-duplicated pipeline; bureau via adapter (mock, labelled). Live providers await contracts (OQ-10). |
| VII §21–24 Risk, collateral, E&S, memo | **Built** | Versioned models with maker-checker; 110% cash-backed test; E&S at ₦100m+ in HEART / Oil & Gas / Mining / Aviation (configurable); editable, versioned memo and term sheet. |
| VIII §25–29 Workflow, authority, SLA, collaboration | **Built** | See `workflow-model.md`; scenarios (PEP, insider, SOL, cash-backed) run through the live workflow in tests. |
| IX §30–33 Offers, post-approval, disbursement | **Built** | Offer maker-checker and sign-off bands; negotiation creates new terms versions; Legal ∥ Shariah → Credit Ops; disbursement idempotent and maker-checker; core-banking posting via adapter (mock). |
| X §34–36 Dashboards | **Partial** | Customer, staff and SLM dashboards exist; executive dashboard coverage to be checked against §36's list (drop-off and SLA done; regional/directorate breakdown to confirm). |
| XI §37 Administration | **Built** | Maker-checker for every critical configuration with reason, versions and effective dates. |
| XII–XIII Architecture, security | **Built** | See `architecture-assessment.md`, `security-model.md`. |
| XIV §43 AI | **Built (mock)** | Drafts only, cites sources, human review recorded; private model deployment open (OQ-12). |
| XV §44–45 Design system and tokens | **Partial** | Tokens centralised (three layers, no raw colours in components). Component states exist; a living component catalogue page is a Phase 2 follow-up. |
| XVI §46–47 Performance, accessibility | **Built / ongoing** | p95 budgets in CI; axe WCAG AA in both themes; target raised to WCAG 2.2 AA (manual audit recommended). |
| XVIII §48–50 Testing | **Partial** | Functional, scenario, visual and accessibility suites in CI. Additions planned: 320/375/1920 widths, zoom, the §8 value set, BVN/NIN cases (§48). |

## 3. Decisions requiring Bank approval

| # | Decision | Interim position |
| --- | --- | --- |
| C-01 | Approved AltBank colour codes and typeface licence for Credit360 | Provisional palette in `tokens.css`; Plus Jakarta Sans (OFL, free for commercial use). |
| C-02 | The official Credit360 logo file (all variants) | Typographic lockup + provisional icon, clearly marked; no invented symbol. |
| C-03 | Reference prefixes customers see (`GZ-CUS-…`, `GZ-FAC-…`) | Kept unchanged so existing records, documents and audit history stay consistent. Changing them needs a decision (e.g. `C360-` for new records only). |
| C-04 | Identity verification providers for BVN and NIN, lawful basis and consent wording, retention of verification results | Sandbox adapter only; never reported as a live check. |
| C-05 | BVN/NIN discrepancy policy: who may clear a discrepancy, and whether a cleared discrepancy can proceed to submission | Two-person review (maker-checker) with reasons; submission blocked until verified or cleared. |
| C-06 | Product contracts, computations and templates | Configured, not yet signed off by Legal, Risk and Shariah. |

## 4. Design-token proposal (provisional)

| Role | Light | Dark | Notes |
| --- | --- | --- | --- |
| Canvas / surface | `#FAF9F6` / `#FFFFFF` | `#111317` / `#1A1D23` | Off-white and cream in light; deep charcoal, never black, in dark. |
| Text / secondary | `#16181D` / `#555B66` | `#F4F1EA` / `#ACA79D` | All text ≥ 4.5:1. |
| Brand gold (accent, primary action) | `#F5B700`, text on it `#16181D` (≈10:1) | `#F5B700` | Gold never used as body text on white (fails contrast); links use gold-brown `#8A5F00` (5.6:1). |
| Wordmark | "Credit" `#16181D`, "360" `#F5B700` | "Credit" `#F4F1EA`, "360" `#F5B700` | Logotype (WCAG 1.4.3 exemption). |
| Status | ok green, **warning orange** (not gold), danger red, info blue | lifted variants | Warning differs from brand gold so it never reads as a brand accent. |
| Type | Plus Jakarta Sans 400–800; tabular figures | same | Self-hosted. |
| Radius | 6 / 10 / 14 px, pill | same | Rounded, consistent. |

## 5. Roadmap (dependency order)

1. **Done this phase:** identity rename, provisional brand tokens, typography, light/dark on the new palette, document template, table overflow hardening, customer dashboard hierarchy.
2. **Next — Phase 4: promoter BVN/NIN verification** (largest functional gap; §13).
3. Phase 2 completion on receipt of the logo: SVG variants, icons, component catalogue, design review.
4. Visual regression extension: 320 / 375 / 1920 px, 200% zoom, the §8 value set, open drawers and modals.
5. Phase 12 / 6 polish: drag-and-drop uploads with previews; executive dashboard breakdowns (§36).
6. Live integrations as the Bank supplies contracts and credentials (CAC, tax, BVN, NIN, bureau, statements, AD).
