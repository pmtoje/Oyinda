# Credit360 API reference

_Generated from the route source by `pnpm --filter @gazelle/api docs:api`; a test fails when this file is out of date. Do not edit by hand._

## Conventions

* **Base:** same origin as the web app; JSON in and out. Successful responses are `{ "data": … }`; errors are `{ "error": { "code", "message", "details?", "requestId" } }` with an HTTP status (400 validation, 401 not signed in, 403 not permitted, 404 not found or not visible to you, 409 conflict / stale `rowVersion`, 422 business rule, 429 rate limited with `Retry-After`).
* **Session:** an HttpOnly `gz_session` cookie. Every state-changing request needs the `x-csrf-token` header (returned by sign-in and `GET /api/auth/session`) and a same-origin `Origin`.
* **Background refreshes** send `x-gz-passive: 1`: authenticated, but they never extend the inactivity timeout.
* **Deny by default:** every `/api` route returns 401 without a session unless it is on the public allowlist (`src/http/public-routes.ts`); a test calls every route anonymously to prove it.
* **Access** below is the check made by the handler. "Staff + MFA" means a staff session that completed the second factor; permissions are listed in `docs/security-model.md`. Facility-scoped routes additionally enforce row-level visibility (own customer, assigned relationship manager, or a role that sees all).
* **Idempotency:** facility creation, workflow actions and disbursements take an `idempotencyKey`; optimistic concurrency uses `rowVersion`.

**192 endpoints** in 15 modules.

## admin

| Method | Path | Access | Purpose | Source |
| --- | --- | --- | --- | --- |
| GET | `/api/admin/access-requests` | Staff + MFA · `user.manage` | — | `modules/admin/routes.ts:192` |
| POST | `/api/admin/access-requests/:rid/decide` | Staff + MFA · `user.manage` | — | `modules/admin/routes.ts:196` |
| GET | `/api/admin/audit` | Staff + MFA · `audit.view` | audit | `modules/admin/routes.ts:393` |
| GET | `/api/admin/audit/verify` | Staff + MFA · `audit.view` | — | `modules/admin/routes.ts:409` |
| GET | `/api/admin/config` | Staff + MFA · `config.view` | — | `modules/admin/routes.ts:30` |
| POST | `/api/admin/config` | Staff + MFA · `config.edit` | — | `modules/admin/routes.ts:61` |
| GET | `/api/admin/config/:id` | Staff + MFA · `config.view` | — | `modules/admin/routes.ts:54` |
| DELETE | `/api/admin/config/:id` | Staff + MFA · `config.edit` | — | `modules/admin/routes.ts:89` |
| POST | `/api/admin/config/:id/deactivate` | Staff + MFA · `config.approve` | — | `modules/admin/routes.ts:83` |
| POST | `/api/admin/config/:id/reject` | Staff + MFA · `config.approve` | — | `modules/admin/routes.ts:77` |
| POST | `/api/admin/config/efficiency-preview` | Staff + MFA · `config.edit` | — | `modules/admin/routes.ts:43` |
| GET | `/api/admin/config/efficiency-variables` | Staff + MFA · `config.view` | Facility efficiency ratio: the variables a definition may use, and a preview of a draft formula on a real facility. | `modules/admin/routes.ts:42` |
| GET | `/api/admin/config/facts` | Staff + MFA · `config.view` | — | `modules/admin/routes.ts:40` |
| GET | `/api/admin/config/kinds` | Staff + MFA · `config.view` | configuration | `modules/admin/routes.ts:25` |
| POST | `/api/admin/config/preview-condition` | Staff + MFA · `config.view` | Preview a condition against a real facility's facts before submitting a rule change. | `modules/admin/routes.ts:99` |
| GET | `/api/admin/customer-block-requests` | Staff + MFA · `customer.block` | — | `modules/admin/routes.ts:288` |
| POST | `/api/admin/customer-block-requests/:rid/decide` | Staff + MFA · `customer.block` | — | `modules/admin/routes.ts:294` |
| GET | `/api/admin/customers` | Staff + MFA · any of `user.manage`, `customer.view.all` | — | `modules/admin/routes.ts:251` |
| POST | `/api/admin/customers/:cid/block` | Staff + MFA · `customer.block` | — | `modules/admin/routes.ts:259` |
| POST | `/api/admin/customers/:cid/relationship-manager` | Staff + MFA · `user.manage` | Assign a customer portfolio to an RM. | `modules/admin/routes.ts:240` |
| POST | `/api/admin/customers/:cid/unblock` | Staff + MFA · `customer.block` | — | `modules/admin/routes.ts:276` |
| GET | `/api/admin/data-quality` | Staff + MFA · any of `system.health`, `report.view` | data quality & reconciliation | `modules/admin/routes.ts:447` |
| GET | `/api/admin/fx-rates` | Staff + MFA | FX rates | `modules/admin/routes.ts:379` |
| POST | `/api/admin/fx-rates` | Staff + MFA · `config.edit` | — | `modules/admin/routes.ts:383` |
| GET | `/api/admin/health` | Staff + MFA · `system.health` | — | `modules/admin/routes.ts:417` |
| POST | `/api/admin/jobs/:jid/retry` | Staff + MFA · `system.health` | — | `modules/admin/routes.ts:437` |
| GET | `/api/admin/reference` | Staff + MFA | — | `modules/admin/routes.ts:123` |
| GET | `/api/admin/roles` | Staff + MFA · `user.manage` | — | `modules/admin/routes.ts:119` |
| GET | `/api/admin/user-imports` | Staff + MFA · `user.manage` | — | `modules/admin/user-import-routes.ts:61` |
| POST | `/api/admin/user-imports` | Staff + MFA · `user.manage` | — | `modules/admin/user-import-routes.ts:45` |
| GET | `/api/admin/user-imports/:bid` | Staff + MFA · `user.manage` | — | `modules/admin/user-import-routes.ts:66` |
| POST | `/api/admin/user-imports/:bid/decide` | Staff + MFA · `user.manage` | Checker: apply or reject. The approver must differ from the uploader and cannot be changed by the batch. | `modules/admin/user-import-routes.ts:75` |
| POST | `/api/admin/user-imports/:bid/withdraw` | Staff + MFA · `user.manage` | — | `modules/admin/user-import-routes.ts:102` |
| GET | `/api/admin/user-imports/template.xlsx` | Staff + MFA · `user.manage` | — | `modules/admin/user-import-routes.ts:23` |
| GET | `/api/admin/users` | Staff + MFA · any of `user.manage`, `task.reassign` | users & access | `modules/admin/routes.ts:110` |
| POST | `/api/admin/users` | Staff + MFA · `user.manage` | — | `modules/admin/routes.ts:128` |
| PATCH | `/api/admin/users/:uid` | Staff + MFA · `user.manage` | — | `modules/admin/routes.ts:139` |
| POST | `/api/admin/users/:uid/credential-link` | Staff + MFA · `user.manage` | Interim local sign-in: send an activation or reset link to the user's work e-mail. Administrators never see or set passwords. | `modules/admin/routes.ts:154` |
| POST | `/api/admin/users/:uid/limits` | Staff + MFA · `user.manage` | — | `modules/admin/routes.ts:215` |
| POST | `/api/admin/users/:uid/roles` | Staff + MFA · `user.manage` | Role changes. Privileged roles need a second administrator (maker-checker). | `modules/admin/routes.ts:171` |
| POST | `/api/admin/users/:uid/sectors` | Staff + MFA · `user.manage` | — | `modules/admin/routes.ts:228` |
| GET | `/api/admin/users/export.xlsx` | Staff + MFA · `user.manage` | PRD: export the list of users in Excel format for access review. | `modules/admin/routes.ts:310` |
| GET | `/api/customers` | Staff + MFA · any of `customer.view.assigned`, `customer.view.all` | Portfolio-scoped customer list (RM: own customers; BM/RBE/DH: business unit; bank-wide roles: all). | `modules/admin/routes.ts:343` |
| GET | `/api/delegations` | Staff + MFA | — | `modules/admin/routes.ts:361` |
| POST | `/api/delegations` | Staff + MFA · `task.work` | delegation | `modules/admin/routes.ts:352` |
| POST | `/api/delegations/:did/decide` | Staff + MFA · `user.manage` | — | `modules/admin/routes.ts:366` |
| GET | `/api/staff/directory` | Staff + MFA · any of `task.work`, `thread.participate` | Read-only staff directory for choosing colleagues (clarifications, delegations). No contact or access data. | `modules/admin/routes.ts:337` |
| GET | `/health/live` | Operational (outside /api) | health & observability | `modules/admin/routes.ts:412` |
| GET | `/health/ready` | Operational (outside /api) | — | `modules/admin/routes.ts:413` |
| GET | `/internal/metrics` | Operational (outside /api) | — | `modules/admin/routes.ts:416` |

## ai

| Method | Path | Access | Purpose | Source |
| --- | --- | --- | --- | --- |
| POST | `/api/ai/:iid/review` | Staff + MFA · `ai.use` | — | `modules/ai/routes.ts:23` |
| GET | `/api/facilities/:id/ai` | Staff + MFA · `ai.use` | — | `modules/ai/routes.ts:18` |
| POST | `/api/facilities/:id/ai/:useCase` | Staff + MFA · `ai.use` | — | `modules/ai/routes.ts:12` |

## analysis

| Method | Path | Access | Purpose | Source |
| --- | --- | --- | --- | --- |
| POST | `/api/bank-statements/:sid/review` | Staff + MFA · `financials.validate` | — | `modules/analysis/statement-routes.ts:157` |
| GET | `/api/bank-statements/:sid/transactions` | Staff + MFA · `financials.edit` | — | `modules/analysis/statement-routes.ts:128` |
| PATCH | `/api/bank-transactions/:tid` | Staff + MFA · `financials.edit` | Human validation of an uncertain transaction. Original raw description is retained. | `modules/analysis/statement-routes.ts:141` |
| GET | `/api/collateral-types` | Signed in · further checks in the handler | — | `modules/analysis/credit-routes.ts:111` |
| GET | `/api/customers/:customerId/financial-statements` | Signed in · further checks in the handler | — | `modules/analysis/financial-routes.ts:44` |
| POST | `/api/customers/:customerId/financial-statements` | Staff + MFA · `financials.edit` | — | `modules/analysis/financial-routes.ts:50` |
| GET | `/api/facilities/:id/altbank-accounts` | Owning customer, or staff with access to the facility | The customer's own Alternative Bank accounts, for choosing a statement to spool. | `modules/analysis/statement-routes.ts:116` |
| GET | `/api/facilities/:id/bank-statements` | Owning customer, or staff with access to the facility | — | `modules/analysis/statement-routes.ts:121` |
| POST | `/api/facilities/:id/bank-statements` | Staff + MFA · `financials.edit` | — | `modules/analysis/statement-routes.ts:64` |
| POST | `/api/facilities/:id/bank-statements/spool` | Staff + MFA · `financials.edit` | SWR §2: spool an Alternative Bank statement directly from the core banking system. Only accounts that the Bank holds for this facility's customer can be requested (SWR technology control 6) — the account is never taken on trust from the client, and another customer's account is indistinguishable from a non-existent one. | `modules/analysis/statement-routes.ts:81` |
| GET | `/api/facilities/:id/bureau-checks` | Staff + MFA | — | `modules/analysis/credit-routes.ts:58` |
| POST | `/api/facilities/:id/bureau-checks` | Staff + MFA · `bureau.request` | — | `modules/analysis/credit-routes.ts:26` |
| GET | `/api/facilities/:id/collateral` | Owning customer, or staff with access to the facility | — | `modules/analysis/credit-routes.ts:116` |
| POST | `/api/facilities/:id/collateral` | Staff + MFA · `collateral.edit` | — | `modules/analysis/credit-routes.ts:131` |
| PUT | `/api/facilities/:id/collateral/:cid` | Staff + MFA · `collateral.edit` | — | `modules/analysis/credit-routes.ts:139` |
| DELETE | `/api/facilities/:id/collateral/:cid` | Staff + MFA · `collateral.edit` | — | `modules/analysis/credit-routes.ts:149` |
| GET | `/api/facilities/:id/es` | Staff + MFA | — | `modules/analysis/credit-routes.ts:291` |
| PUT | `/api/facilities/:id/es` | Staff + MFA · any of `es.assess`, `es.checklist` | — | `modules/analysis/credit-routes.ts:303` |
| GET | `/api/facilities/:id/exposure` | Staff + MFA | — | `modules/analysis/credit-routes.ts:73` |
| POST | `/api/facilities/:id/exposure` | Staff + MFA · `exposure.compute` | — | `modules/analysis/credit-routes.ts:67` |
| GET | `/api/facilities/:id/financial-analysis` | Staff + MFA | — | `modules/analysis/financial-routes.ts:130` |
| POST | `/api/facilities/:id/financial-analysis` | Staff + MFA · `financials.validate` | Run (and freeze) the financial analysis for a facility using current ratio configuration. | `modules/analysis/financial-routes.ts:104` |
| GET | `/api/facilities/:id/rarorac` | Staff + MFA | — | `modules/analysis/credit-routes.ts:282` |
| POST | `/api/facilities/:id/rarorac` | Staff + MFA · `rarorac.compute` | — | `modules/analysis/credit-routes.ts:240` |
| GET | `/api/facilities/:id/risk` | Staff + MFA | — | `modules/analysis/credit-routes.ts:162` |
| POST | `/api/facilities/:id/risk-combined` | Staff + MFA · `risk.assess` | — | `modules/analysis/credit-routes.ts:219` |
| POST | `/api/facilities/:id/risk-frr` | Staff + MFA · `risk.assess` | FRR from the latest frozen financial analysis. | `modules/analysis/credit-routes.ts:201` |
| POST | `/api/facilities/:id/risk/:kind` | Staff + MFA · `risk.assess` | — | `modules/analysis/credit-routes.ts:176` |
| GET | `/api/facilities/:id/statement-analysis` | Staff + MFA | — | `modules/analysis/statement-routes.ts:191` |
| POST | `/api/facilities/:id/statement-analysis` | Staff + MFA · `financials.validate` | — | `modules/analysis/statement-routes.ts:171` |
| PUT | `/api/financial-statements/:id/lines` | Staff + MFA · `financials.edit` | — | `modules/analysis/financial-routes.ts:73` |
| POST | `/api/financial-statements/:id/validate` | Staff + MFA · `financials.validate` | — | `modules/analysis/financial-routes.ts:90` |
| GET | `/api/financial-template` | Signed in · further checks in the handler | — | `modules/analysis/financial-routes.ts:38` |
| POST | `/api/rarorac/:rid/justify` | Staff + MFA · `rarorac.justify` | — | `modules/analysis/credit-routes.ts:266` |

## app.ts

| Method | Path | Access | Purpose | Source |
| --- | --- | --- | --- | --- |
| GET | `/api/meta` | Public · no session (own challenge / rate limits) | — | `http/app.ts:151` |

## docgen

| Method | Path | Access | Purpose | Source |
| --- | --- | --- | --- | --- |
| GET | `/api/facilities/:id/decision-view` | Staff + MFA | — | `modules/docgen/routes.ts:53` |
| GET | `/api/facilities/:id/efficiency-ratio` | Staff + MFA | — | `modules/docgen/routes.ts:47` |
| GET | `/api/facilities/:id/generated/:kind` | Staff + MFA | — | `modules/docgen/routes.ts:24` |
| POST | `/api/facilities/:id/memo` | Staff + MFA · `memo.generate` | — | `modules/docgen/routes.ts:16` |
| GET | `/api/facilities/:id/risk-flags` | Staff + MFA | — | `modules/docgen/routes.ts:59` |
| POST | `/api/facilities/:id/term-sheet` | Staff + MFA · `memo.generate` | — | `modules/docgen/routes.ts:32` |

## documents

| Method | Path | Access | Purpose | Source |
| --- | --- | --- | --- | --- |
| DELETE | `/api/documents/:docId` | Signed in · further checks in the handler | — | `modules/documents/routes.ts:128` |
| POST | `/api/documents/:docId/grant` | Signed in · further checks in the handler | Issue a single-use, 60-second download grant bound to the caller's identity. | `modules/documents/routes.ts:81` |
| POST | `/api/documents/:docId/review` | Staff + MFA · `document.verify` | — | `modules/documents/routes.ts:112` |
| POST | `/api/documents/:docId/upload` | Staff + MFA | — | `modules/documents/routes.ts:55` |
| GET | `/api/documents/:docId/versions` | Signed in · further checks in the handler | — | `modules/documents/routes.ts:72` |
| GET | `/api/facilities/:id/documents` | Owning customer, or staff with access to the facility | — | `modules/documents/routes.ts:36` |
| POST | `/api/facilities/:id/documents` | Owning customer, or staff with access to the facility | Additional (ad-hoc) document on a facility. | `modules/documents/routes.ts:45` |
| GET | `/api/files/:token` | Signed in · further checks in the handler | — | `modules/documents/routes.ts:96` |

## facilities

| Method | Path | Access | Purpose | Source |
| --- | --- | --- | --- | --- |
| GET | `/api/facilities` | Staff + MFA | — | `modules/facilities/routes.ts:110` |
| POST | `/api/facilities` | Staff + MFA · `facility.initiate` | — | `modules/facilities/routes.ts:83` |
| GET | `/api/facilities/:id` | Owning customer, or staff with access to the facility | — | `modules/facilities/routes.ts:132` |
| PATCH | `/api/facilities/:id` | Staff + MFA · `facility.initiate` | — | `modules/facilities/routes.ts:159` |
| POST | `/api/facilities/:id/eligibility` | Owning customer, or staff with access to the facility | — | `modules/facilities/routes.ts:203` |
| POST | `/api/facilities/:id/rework/:itemId/respond` | Owning customer, or staff with access to the facility | — | `modules/facilities/routes.ts:273` |
| POST | `/api/facilities/:id/submit` | Staff + MFA · `facility.initiate` | — | `modules/facilities/routes.ts:215` |
| POST | `/api/facilities/:id/withdraw` | Owning customer, or staff with access to the facility | — | `modules/facilities/routes.ts:257` |
| GET | `/api/products` | Staff + MFA | — | `modules/facilities/routes.ts:75` |

## identity

| Method | Path | Access | Purpose | Source |
| --- | --- | --- | --- | --- |
| POST | `/api/auth/customer/email/send` | Customer user | — | `modules/identity/routes.ts:262` |
| POST | `/api/auth/customer/email/verify-link` | Public · no session (own challenge / rate limits) | Public: the link in the welcome e-mail. Single use, expires after 48 hours. | `modules/identity/routes.ts:274` |
| POST | `/api/auth/customer/login/start` | Public · no session (own challenge / rate limits) | — | `modules/identity/routes.ts:291` |
| POST | `/api/auth/customer/login/verify` | Public · no session (own challenge / rate limits) | — | `modules/identity/routes.ts:316` |
| POST | `/api/auth/logout` | Public · no session (own challenge / rate limits) | — | `modules/identity/routes.ts:498` |
| GET | `/api/auth/me` | Signed in · further checks in the handler | — | `modules/identity/routes.ts:476` |
| GET | `/api/auth/session` | Public · no session (own challenge / rate limits) | Session probe for the SPA: 200 with null when signed out (avoids noisy 401s before sign-in). | `modules/identity/routes.ts:471` |
| POST | `/api/auth/session/keep-alive` | Signed in · further checks in the handler | "Stay signed in": an explicit activity that slides the idle window (never past the maximum session length). | `modules/identity/routes.ts:517` |
| GET | `/api/auth/session/status` | Signed in · further checks in the handler | — | `modules/identity/routes.ts:512` |
| GET | `/api/auth/sessions` | Signed in · further checks in the handler | — | `modules/identity/routes.ts:522` |
| DELETE | `/api/auth/sessions/:id` | Signed in · further checks in the handler | — | `modules/identity/routes.ts:529` |
| POST | `/api/auth/sessions/revoke-others` | Signed in · further checks in the handler | — | `modules/identity/routes.ts:540` |
| POST | `/api/auth/staff/login` | Public · no session (own challenge / rate limits) | — | `modules/identity/routes.ts:351` |
| POST | `/api/auth/staff/mfa/verify` | Signed in · further checks in the handler | — | `modules/identity/routes.ts:431` |
| POST | `/api/auth/staff/password/change` | Staff + MFA | — | `modules/identity/routes.ts:422` |
| POST | `/api/auth/staff/password/forgot` | Public · no session (own challenge / rate limits) | Self-service reset. Identical response whether or not the username exists. | `modules/identity/routes.ts:411` |
| GET | `/api/auth/staff/password/link` | Public · no session (own challenge / rate limits) | — | `modules/identity/routes.ts:394` |
| POST | `/api/auth/staff/password/set` | Public · no session (own challenge / rate limits) | — | `modules/identity/routes.ts:403` |
| GET | `/api/customers/:customerId/identity` | Signed in · further checks in the handler | — | `modules/identity/verification-routes.ts:19` |
| POST | `/api/customers/:customerId/parties/:partyId/identity/review` | Customer user with portal right `SUBMIT_REQUESTS` | Customer asks the Bank to review a difference (e.g. a known name change) instead of re-entering details. | `modules/identity/verification-routes.ts:39` |
| POST | `/api/customers/:customerId/parties/:partyId/identity/verify` | Customer user with portal right `SUBMIT_REQUESTS` | "Verify your identity": BVN and/or NIN with date of birth and consent; runs the checks server-side. | `modules/identity/verification-routes.ts:25` |
| GET | `/api/identity-reviews` | Staff + MFA · `identity.review` | Staff review queue (KYC / Compliance): maker proposes, a different checker decides ---- | `modules/identity/verification-routes.ts:49` |
| GET | `/api/identity-reviews/:id` | Staff + MFA · `identity.review` | — | `modules/identity/verification-routes.ts:58` |
| POST | `/api/identity-reviews/:id/decide` | Staff + MFA · `identity.review` | — | `modules/identity/verification-routes.ts:76` |
| POST | `/api/identity-reviews/:id/propose` | Staff + MFA · `identity.review` | — | `modules/identity/verification-routes.ts:68` |
| POST | `/api/identity-reviews/:id/reveal` | Staff + MFA · `identity.review` | — | `modules/identity/verification-routes.ts:63` |
| PUT | `/api/me/preferences` | Signed in · further checks in the handler | Display preferences saved on the user's account (theme follows the user between devices). | `modules/identity/routes.ts:490` |
| POST | `/api/onboarding/complete` | Public · no session (own challenge / rate limits) | — | `modules/identity/routes.ts:175` |
| GET | `/api/onboarding/password-policy` | Public · no session (own challenge / rate limits) | — | `modules/identity/routes.ts:64` |
| POST | `/api/onboarding/resend-otp` | Public · no session (own challenge / rate limits) | — | `modules/identity/routes.ts:119` |
| POST | `/api/onboarding/start` | Public · no session (own challenge / rate limits) | — | `modules/identity/routes.ts:69` |
| POST | `/api/onboarding/verify-otp` | Public · no session (own challenge / rate limits) | — | `modules/identity/routes.ts:133` |

## notifications

| Method | Path | Access | Purpose | Source |
| --- | --- | --- | --- | --- |
| GET | `/api/notifications` | Signed in · further checks in the handler | — | `modules/notifications/routes.ts:14` |
| POST | `/api/notifications/:nid/read` | Signed in · further checks in the handler | — | `modules/notifications/routes.ts:22` |
| POST | `/api/notifications/read-all` | Signed in · further checks in the handler | — | `modules/notifications/routes.ts:28` |

## offers

| Method | Path | Access | Purpose | Source |
| --- | --- | --- | --- | --- |
| PATCH | `/api/conditions/:cid` | Staff + MFA | — | `modules/offers/routes.ts:95` |
| POST | `/api/conditions/:cid/evidence` | Customer user | Customer uploads evidence for a customer-owned condition (Credit Ops then marks it satisfied). | `modules/offers/routes.ts:115` |
| GET | `/api/facilities/:id/conditions` | Owning customer, or staff with access to the facility | — | `modules/offers/routes.ts:85` |
| GET | `/api/facilities/:id/offer` | Owning customer, or staff with access to the facility | — | `modules/offers/routes.ts:16` |
| POST | `/api/facilities/:id/offer` | Staff + MFA · `offer.make` | — | `modules/offers/routes.ts:31` |
| POST | `/api/negotiations/:nid/decide` | Staff + MFA · `negotiation.review` | — | `modules/offers/routes.ts:71` |
| POST | `/api/offers/:offerId/check` | Staff + MFA · `offer.check` | — | `modules/offers/routes.ts:38` |
| POST | `/api/offers/:offerId/respond` | Customer user with portal right `RESPOND_TO_OFFERS` | — | `modules/offers/routes.ts:59` |
| POST | `/api/offers/:offerId/sign` | Staff + MFA · `offer.sign` | — | `modules/offers/routes.ts:49` |

## profile

| Method | Path | Access | Purpose | Source |
| --- | --- | --- | --- | --- |
| POST | `/api/customers/:customerId/parties` | Signed in · further checks in the handler | Parties | `modules/profile/routes.ts:147` |
| PUT | `/api/customers/:customerId/parties/:partyId` | Signed in · further checks in the handler | — | `modules/profile/routes.ts:169` |
| DELETE | `/api/customers/:customerId/parties/:partyId` | Signed in · further checks in the handler | — | `modules/profile/routes.ts:187` |
| GET | `/api/customers/:customerId/profile` | Signed in · further checks in the handler | — | `modules/profile/routes.ts:118` |
| PUT | `/api/customers/:customerId/profile` | Signed in · further checks in the handler | — | `modules/profile/routes.ts:123` |
| GET | `/api/portal-invites` | Public · no session (own challenge / rate limits) | — | `modules/profile/portal-users.ts:119` |
| POST | `/api/portal-invites/accept` | Public · no session (own challenge / rate limits) | — | `modules/profile/portal-users.ts:141` |
| POST | `/api/portal-invites/phone` | Public · no session (own challenge / rate limits) | — | `modules/profile/portal-users.ts:128` |
| GET | `/api/portal/users` | Customer user | — | `modules/profile/portal-users.ts:40` |
| PATCH | `/api/portal/users/:uid` | Customer user with portal right `MANAGE_USERS` | Change another user's rights or status. The business always keeps at least one active user who can manage users. | `modules/profile/portal-users.ts:88` |
| POST | `/api/portal/users/invites` | Customer user with portal right `MANAGE_USERS` | — | `modules/profile/portal-users.ts:52` |
| POST | `/api/portal/users/invites/:iid/revoke` | Customer user with portal right `MANAGE_USERS` | — | `modules/profile/portal-users.ts:78` |
| GET | `/api/reference/sectors` | Public · no session (own challenge / rate limits) | — | `modules/profile/routes.ts:228` |

## reports

| Method | Path | Access | Purpose | Source |
| --- | --- | --- | --- | --- |
| GET | `/api/reports` | Staff + MFA · `report.view` | — | `modules/reports/routes.ts:111` |
| GET | `/api/reports/:key` | Staff + MFA · `report.view` | — | `modules/reports/routes.ts:113` |
| GET | `/api/reports/dropoff` | Staff + MFA · `report.view` | Where customers abandon the application journey. | `modules/reports/routes.ts:96` |
| GET | `/api/reports/slm` | Staff + MFA · `report.view` | Service Level Management dashboard. | `modules/reports/routes.ts:66` |

## servicing

| Method | Path | Access | Purpose | Source |
| --- | --- | --- | --- | --- |
| POST | `/api/disbursements/:did/decide` | Staff + MFA · `disbursement.check` | — | `modules/servicing/routes.ts:121` |
| GET | `/api/facilities/:id/account` | Owning customer, or staff with access to the facility | — | `modules/servicing/routes.ts:86` |
| POST | `/api/facilities/:id/activate` | Staff + MFA · `facility.activate` | — | `modules/servicing/routes.ts:79` |
| POST | `/api/facilities/:id/disbursements` | Staff + MFA · `disbursement.make` | — | `modules/servicing/routes.ts:103` |
| POST | `/api/facility-accounts/:aid/payments` | Staff + MFA · `monitoring.manage` | Record a payment (from CBA reconciliation). Duplicate references are rejected (idempotent). | `modules/servicing/routes.ts:156` |
| GET | `/api/monitoring` | Staff + MFA | — | `modules/servicing/routes.ts:184` |
| POST | `/api/monitoring/:mid/resolve` | Staff + MFA · `monitoring.manage` | — | `modules/servicing/routes.ts:193` |

## threads

| Method | Path | Access | Purpose | Source |
| --- | --- | --- | --- | --- |
| GET | `/api/facilities/:id/threads` | Owning customer, or staff with access to the facility | — | `modules/threads/routes.ts:10` |
| POST | `/api/facilities/:id/threads` | Staff + MFA · `thread.participate` | — | `modules/threads/routes.ts:20` |
| GET | `/api/threads/:threadId` | Owning customer, or staff with access to the facility | — | `modules/threads/routes.ts:29` |
| POST | `/api/threads/:threadId/messages` | Staff + MFA · `thread.participate` | — | `modules/threads/routes.ts:44` |
| POST | `/api/threads/:threadId/resolve` | Staff + MFA · `thread.participate` | — | `modules/threads/routes.ts:64` |

## workflow

| Method | Path | Access | Purpose | Source |
| --- | --- | --- | --- | --- |
| GET | `/api/facilities/:id/workflow` | Staff + MFA | Internal operational timeline: route explanation, every task and every action. Staff only. | `modules/workflow/routes.ts:133` |
| GET | `/api/tasks` | Staff + MFA · `task.work` | — | `modules/workflow/routes.ts:35` |
| GET | `/api/tasks/:taskId` | Staff + MFA · `task.work` | — | `modules/workflow/routes.ts:54` |
| POST | `/api/tasks/:taskId/actions` | Staff + MFA · `task.work` | — | `modules/workflow/routes.ts:110` |
| POST | `/api/tasks/:taskId/claim` | Staff + MFA · `task.work` | — | `modules/workflow/routes.ts:77` |
| GET | `/api/tasks/:taskId/eligible-assignees` | Staff + MFA · `task.reassign` | — | `modules/workflow/routes.ts:102` |
| POST | `/api/tasks/:taskId/reassign` | Staff + MFA · `task.reassign` | — | `modules/workflow/routes.ts:94` |
| POST | `/api/tasks/:taskId/release` | Staff + MFA · `task.work` | — | `modules/workflow/routes.ts:87` |
