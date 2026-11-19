# Open Questions

Raised under MBP Phase 75. Nothing here blocks the build: each item has a configurable default that Credit Risk, Compliance or Technology can change without a release.

| ID | Question | Why it matters | Current default | Owner |
|---|---|---|---|---|
| OQ-01 | Please supply the Gazelle PRD/BRD and the 27-Oct-2026 SWR, plus the image content of MBP sections 18, 23, 34, 40 and 51–56. | They are the primary functional source. | MBP text plus documented defaults. | Product owner |
| OQ-02 | Is a customer portal password required in addition to OTP? | Policy on customer authentication factors. | Passwordless OTP to the CBA-registered mobile (D-02). | Information Security |
| OQ-03 | Confirm approval authority limits (CRO ₦100m, ED ₦250m, MD ₦500m, MIC ₦2bn, BCC ₦5bn, Board above) and cash-backed limits. | Drives the approval chain. | Seeded defaults in `approval_authority/STANDARD`. | Credit Risk |
| OQ-04 | Confirm committee quorum and signature rules for MIC, BCC and Board. | Committee decisions. | MIC quorum 3 / 3 approvals incl. MD; BCC 3/3; Board quorum 4 / 3 approvals. | Company Secretariat |
| OQ-05 | Define the "HEART" sector group for the E&S trigger. | E&S trigger scope. | See D-07. | Sustainability |
| OQ-06 | Confirm the SLA table and escalation thresholds. | SLA engine. | See D-05. | Credit Risk / Operations |
| OQ-07 | The Single Obligor Limit amount and basis (shareholders' funds figure). | SOL enforcement. | ₦5bn placeholder. | Finance / Credit Risk |
| OQ-08 | RARORAC hurdle and minimum profit rate. | Pricing exceptions. | Hurdle 15%, minimum profit rate 18%, exception approver GH Credit Risk. | Treasury / Credit Risk |
| OQ-09 | Approved Alternative Bank brand tokens (colour hex values, typeface licence). | Visual identity. | Restrained deep-green and brass palette in `apps/web/src/styles/tokens.css`, one file to replace. | Brand / Marketing |
| OQ-10 | Approved credit bureau providers and their API contracts. | Live bureau integration. | `BureauAdapter` with a mock. | Credit Risk / Technology |
| OQ-11 | Account-opening journey URL for customers without an Alternative Bank account. | Onboarding "No" branch. | Configurable `ACCOUNT_OPENING_URL`. | Digital Banking |
| OQ-12 | Approved private AI deployment (model, endpoint, VPC). | AI layer. | `AI_MODE=local` deterministic engine; `private-endpoint` adapter behind a host allow-list. | Technology / InfoSec |
| OQ-13 | Confirm the moveable Islamic public holiday dates each year. | SLA business-hour calculation. | Provisional dates in `business_calendar/NG_HEAD_OFFICE`. | Operations |
