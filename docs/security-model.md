# Security Model

Gazelle is treated as a banking system of record: security controls live in the server and the database, never only in the UI.

## 1. Identity

| Actor | Mechanism | Controls |
|---|---|---|
| Existing-account customer | Account number → **CBA lookup** (identity never taken from the client) → 6-digit OTP to the **CBA-registered phone** → contact details → email OTP | OTP hashed (HMAC-SHA256, keyed, per-challenge salt); never returned by any API or written to logs; 5-minute TTL; 5 attempts; single use; only the newest challenge valid; resend throttle (30 s, 5 per 15 min); per-IP rate limit; journey state is server-held behind an opaque HttpOnly cookie. |
| Returning customer | Email → OTP to registered phone | Same response whether or not the user exists (no enumeration); 5 failures → 30-minute account lock. |
| Staff | Active Directory (LDAPS adapter; mock directory in non-production) → **TOTP MFA** (RFC 6238) | No local passwords. Enrolment at first sign-in; secret AES-256-GCM encrypted; ±1 step drift; replay blocked by last-used step; 5 MFA failures → session revoked and account locked; session token rotated after MFA (fixation defence); pre-MFA sessions can only call MFA endpoints. |

## 2. Sessions & CSRF

* Opaque 256-bit tokens; only an HMAC of the token is stored. Cookies are `HttpOnly; Secure; SameSite=Strict`.
* Idle timeout 15 minutes (sliding), absolute 8 hours (configurable). Sessions are revocable per device. Deactivation and role changes revoke all of a user's sessions.
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

Global rate limit plus stricter identity-endpoint limits (configurable), per-account lockouts, idempotency keys on facility creation, workflow actions and disbursements (double-click and replay safe), optimistic locking on facilities, tasks and offers, and atomic task claiming.

## 8. AI security

The private-endpoint provider is HTTPS-only behind a host allow-list (SSRF and egress control). Customer text is sanitised and labelled untrusted (injection patterns neutralised and flagged). Outputs must cite known sources, every figure must appear in those sources, and decision language is rejected. Every interaction is logged with model, version, prompt hash and sources, and awaits human review. The AI module has no access to workflow actions (enforced by test).

## 9. Audit

Insert-only `audit_log` with a SHA-256 hash chain computed in a database trigger under an advisory lock. UPDATE, DELETE and TRUNCATE are blocked by triggers. `verifyAuditChain` recomputes the chain end to end (exposed in System health and the audit viewer). Decision records (workflow actions, votes, terms, assessments, generated documents, status history) are also immutable at database level.

## 10. Residual risks / production prerequisites

* Live adapters (CBA, AD/LDAPS, bureau, RARORAC, SMS/email gateway, KMS/HSM, OCR) must be implemented against the Bank API Gateway. The mocks fail closed in production.
* Penetration test and code review by Group Information Security before go-live.
* WAF / gateway rate limiting in front of the application; database TLS and at-rest encryption at the infrastructure layer.
