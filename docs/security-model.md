# Security Model

> **Product name:** this platform is now **Credit360 by AltBank** (product owner direction, 24-Nov-2026). "Gazelle" below is its original working name, kept where it traces to the source PRD/BRD/SWR and to earlier decisions.

Gazelle is treated as a banking system of record: security controls live in the server and the database, never only in the UI.

## 1. Identity

| Actor | Mechanism | Controls |
|---|---|---|
| Existing-account customer (SWR §1) | Account number + applicant name and role → **CBA lookup** (identity never taken from the client) → one 6-digit OTP to the **phone and e-mail registered on the CBA** → account name shown → password (username = CBA company e-mail) → terms and data privacy → welcome e-mail with a single-use verification link (48 h) | The start step returns the same generic message for every valid-format account (SWR TC-2); the account name appears only after the OTP. OTP hashed (HMAC-SHA256, keyed, per-challenge salt); never returned by any API or written to logs; 5-minute TTL; 5 attempts; single use; only the newest challenge valid; resend throttle (30 s, 5 per 15 min); per-IP rate limit; journey state is server-held behind an opaque HttpOnly cookie. Passwords: configurable policy (`password_policy`), checked server-side (the browser pop-up is a convenience), scrypt (N=2¹⁵) with per-user salt, never logged. One portal account per business. |
| Invited customer user (D-52) | Invitation link from a colleague with **Manage users** (who re-enters their password) → own mobile verified by OTP → password → terms | Single-use 72-hour link proves the e-mail; rights (submit, respond to offers, manage users) enforced server-side; no self-changes; at least one user manager kept; access changes end sessions. |
| Returning customer | Company e-mail + password → 6-digit OTP to the CBA-registered phone | Identical error for unknown users and wrong passwords; constant-work password check; configurable lockout (default 5 failures → 30 minutes) on password and on OTP; blocked (suspended) customers cannot sign in. |
| Staff | Active Directory (LDAPS adapter; mock directory in non-production) → **TOTP MFA** (RFC 6238) | No local passwords. Enrolment at first sign-in; secret AES-256-GCM encrypted; ±1 step drift; replay blocked by last-used step; 5 MFA failures → session revoked and account locked; session token rotated after MFA (fixation defence); pre-MFA sessions can only call MFA endpoints. |
| Staff — interim (`STAFF_AUTH_MODE=local`, until AD) | Username + **Gazelle password** → the same **TOTP MFA** | Production requires an InfoSec approval reference. Passwords set only by the user through single-use e-mailed links (72 h activation, 1 h reset), scrypt-hashed with history; administrators can send links but never see or set passwords; staff policy with expiry, history and lockout; identical errors for unknown users and wrong passwords; generic forgotten-password response; password change or administrator reset ends all sessions. |

## 2. Sessions & CSRF

* **Single session (SWR TC-22, PRD):** a new fully authenticated sign-in (staff: after MFA) ends the user's other live sessions (`SINGLE_SESSION`, default on). Blocking a customer ends all of its sessions at once.

* Opaque 256-bit tokens; only an HMAC of the token is stored. Cookies are `HttpOnly; Secure; SameSite=Strict`.
* **Session timeout is configuration, not code** (`session_policy`, maker-checker; keys `CUSTOMER_PORTAL` and `STAFF`): inactivity limit (5–120 min, baseline 15), warning lead time (30–600 s, baseline 120) and maximum session length (1–24 h; baseline 8 customer, 10 staff). An approved change applies to every session within 30 seconds; the environment values are only a fallback.
* **What counts as activity:** a user request, or real use of the page (typing, clicking, scrolling — sent at most once a minute as an explicit keep-alive). Background refreshes (notification count, queue polling, status checks) carry `x-gz-passive: 1` and are authenticated without extending the session, so an unattended screen always times out.
* **Warning:** before the session ends the browser shows an accessible dialog (`role="alertdialog"`, focus on **Stay signed in**) with a countdown. Near the maximum length there is no "stay" option. Open tabs coordinate (an extension or sign-out in one applies to all). The server remains the authority: the browser re-checks before acting, so a session extended elsewhere is not ended.
* **Nothing typed is lost:** when a session ends on its own, values typed on the current page (never passwords, one-time codes, hidden or file fields) are kept in that browser tab only (sessionStorage, 12-hour limit, never sent to the server) and offered for restore after the user signs back in. Draft facility requests are also saved server-side per step.
* Sessions are revocable per device. Deactivation and role changes revoke all of a user's sessions.
* CSRF: a synchroniser token derived from the session (HMAC) must accompany every state-changing request, plus an Origin check. Pre-authentication endpoints rely on Origin + SameSite.

## 3. Authorisation

* **RBAC**: 19 roles × 39 permissions (`apps/api/src/modules/identity/rbac.ts`), stored in tables and administered with maker-checker for privileged roles.
* **Object-level authorisation** (`facilities/access.ts`): every facility, customer, document, thread and task lookup is checked against the caller. Customers see only their own customer. RMs see their own portfolio; BMs, RBEs and DHs see their business unit; credit roles see submitted facilities; **drafts are visible only to the customer and their portfolio**. Inaccessible records return **404** (no existence oracle).
* **Workflow authority**: permitted actions are computed server-side per user and task: role, assignment, claim, delegated authority, personal approval limit and segregation of duties. *Approve* is never offered above authority, and the API refuses it.
* Maker-checker (DB-enforced where possible): configuration, privileged access, offer letters, disbursements, condition waivers, delegations.

## 4. Data protection (NDPA / CBN)

| Data | Protection |
|---|---|
| BVN | AES-256-GCM field encryption, keyed HMAC for de-duplication, last 4 digits for display; never returned in full. |
| MFA secrets | AES-256-GCM. |
| Documents | Envelope encryption: random 256-bit data key per object, wrapped by the master key (KMS/HSM adapter in production). Random, non-guessable storage keys; no public URLs; 60-second single-use download grants bound to the requester; `Content-Security-Policy: sandbox` on downloads. |
| Account numbers, phone, email, TIN | Masked in UI and APIs where the full value is not needed. |
| Logs | Pino redacts cookies, CSRF and authorization headers; the audit writer redacts fields named otp, code, password, secret, token, bvn, nin or pin. |
| Customer views | Customer-safe projections only: no internal comments, officers, thresholds or internal references. |

Keys come from environment or secret-manager variables (`HMAC_KEY`, `DATA_KEY`); none are in source. Production refuses to start with mock integrations unless explicitly overridden, or with insecure cookies.

## 5. Input, output & files

* All input is validated with zod schemas at the edge; SQL is fully parameterised (no string-built values).
* The condition language and formula engine are data-only parsers: no `eval`, no prototype traversal, depth and length limits.
* Uploads: size limits, magic-byte MIME detection, extension–content match, double-extension rejection, PDF active-content rejection (JavaScript, Launch, embedded files), CSV formula-injection rejection, ZIP whitelisting (DOCX/XLSX only), antivirus scan (ClamAV `clamd` INSTREAM in production) before any file is downloadable.
* CSV exports escape formula characters.
* Errors: safe messages and a request reference; never stack traces.

## 6. Transport & headers

HSTS (1 year, preload), strict CSP (`script-src 'self'`, `frame-ancestors 'none'`, `object-src 'none'`; style attributes only allowed inline), `X-Content-Type-Options`, strict referrer policy, Permissions-Policy, `Cache-Control: no-store` on API responses. Swagger/OpenAPI is not exposed.

## 7. Abuse resistance

Layered rate limits: a generous per-IP ceiling (`IP_RATE_LIMIT_PER_MIN`, default 3000 — branch and head-office staff share egress IPs, so a low per-IP limit would lock out a whole office), a per-signed-in-user limit (`USER_RATE_LIMIT_PER_MIN`, default 600 per API instance, with `Retry-After`; counters are in memory, so N replicas allow up to N× — use the gateway for a hard cluster-wide cap), and strict identity-endpoint limits (`AUTH_RATE_LIMIT_PER_15MIN`). The web app never treats a 429 or 5xx as "signed out": it keeps the user's state and retries with backoff. Also per-account lockouts, idempotency keys on facility creation, workflow actions and disbursements (double-click and replay safe), optimistic locking on facilities, tasks and offers, and atomic task claiming.

## 8. AI security

The private-endpoint provider is HTTPS-only behind a host allow-list (SSRF and egress control). Customer text is sanitised and labelled untrusted (injection patterns neutralised and flagged). Outputs must cite known sources, every figure must appear in those sources, and decision language is rejected. Every interaction is logged with model, version, prompt hash and sources, and awaits human review. The AI module has no access to workflow actions (enforced by test).

## 9. Audit

Insert-only `audit_log` with a SHA-256 hash chain computed in a database trigger under an advisory lock. UPDATE, DELETE and TRUNCATE are blocked by triggers. `verifyAuditChain` recomputes the chain end to end (exposed in System health and the audit viewer). Decision records (workflow actions, votes, terms, assessments, generated documents, status history) are also immutable at database level.

## 10. Residual risks / production prerequisites

* Live adapters (CBA, AD/LDAPS, bureau, RARORAC, SMS/email gateway, KMS/HSM, OCR) must be implemented against the Bank API Gateway. The mocks fail closed in production.
* Penetration test and code review by Group Information Security before go-live.
* WAF / gateway rate limiting in front of the application; database TLS and at-rest encryption at the infrastructure layer.

## Promoter identity verification (BVN and NIN)

* **What is checked:** for each director, promoter and shareholder at or above the configured ownership threshold (`identity_policy`, maker-checker), the BVN and NIN are checked server-side with the configured provider. Only name and date of birth are requested. Each is compared with what the customer entered, with the other record (NIN against BVN), and with the Bank's own record of the person (core banking, by BVN).
* **Explicit states:** Not started, Checking, Verified, Details differ (discrepancy), With the Bank for review, Service unavailable, Not verified. Every check is a row with its source (`SANDBOX` or `LIVE`), provider reference and timestamps. Editing a person's name, date of birth or identifier makes the earlier result stale.
* **No silent overrides:** a discrepancy is cleared only through a review. A KYC officer proposes clear, reject or escalate with a reason, and a *different* officer approves (database constraint plus server check). Unverified promoters block submission when the policy says so.
* **Data handling:** identifiers travel only in request bodies, never URLs. They are never echoed in errors, logged, or sent to analytics. Responses show only the last four digits. The BVN is field-encrypted, because the bureau check needs it. The NIN is kept only as a keyed hash plus its last four digits. The provider's name and date of birth are encrypted and shown only to reviewers on request, and every viewing is audited (`IDENTITY_RECORD_VIEWED`). Consent, with its wording version, is recorded before any provider call. Checks are limited per person per day (policy) and per client (route rate limit).
* **Honesty:** outside production a clearly labelled sandbox provider is used, with synthetic identities only. Results carry a SANDBOX label in every screen and are never presented as a live check. Production refuses to start with the sandbox, as with every other mock integration.
