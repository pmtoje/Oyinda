# Open Questions

Raised under MBP Phase 75. Nothing here blocks the build: each item has a configurable default that Credit Risk, Compliance or Technology can change without a release. Items marked **Resolved** were answered by the SWR (27-Oct-2026) or the PRD/BRD; see the referenced decision.

| ID | Question | Why it matters | Current default | Owner |
|---|---|---|---|---|
| OQ-01 | Supply the PRD/BRD and SWR. | — | **Resolved**: received 19-Nov-2026 (D-21). MBP image sections remain unseen; the PRD/SWR now cover their content. | Product owner |
| OQ-02 | Customer portal password? | — | **Resolved** by SWR §1 (D-22). | Information Security |
| OQ-03 | Approval authority limits. | — | **Resolved** by the PRD grid (D-27, D-28); see OQ-18 for the RBE cash-backed limit. | Credit Risk |
| OQ-04 | Committee quorum and signatures. | — | **Resolved** by the PRD (D-31); see OQ-23. | Company Secretariat |
| OQ-05 | HEART definition. | — | **Resolved** by the PRD (D-35). | Sustainability |
| OQ-06 | SLA table and escalation. | — | **Resolved** by SWR §7 and the PRD (D-34); see OQ-30. | Credit Risk / Operations |
| OQ-07 | The Single Obligor Limit amount and basis (shareholders' funds figure). | SOL enforcement. | ₦5bn placeholder. | Finance / Credit Risk |
| OQ-08 | RARORAC hurdle and minimum profit rate. | Pricing exceptions. | Hurdle 15%, minimum profit rate 18%, exception approver GH Credit Risk. | Treasury / Credit Risk |
| OQ-09 | Approved Alternative Bank brand tokens (colour hex values, typeface licence). | Visual identity. | Restrained deep-green and brass palette in `apps/web/src/styles/tokens.css`, one file to replace. | Brand / Marketing |
| OQ-10 | Approved credit bureau providers and their API contracts. | Live bureau integration. | `BureauAdapter` with a mock. | Credit Risk / Technology |
| OQ-11 | Account-opening journey URL for customers without an Alternative Bank account. | Onboarding "No" branch. | Configurable `ACCOUNT_OPENING_URL`. | Digital Banking |
| OQ-12 | Approved private AI deployment (model, endpoint, VPC). | AI layer. | `AI_MODE=local` deterministic engine; `private-endpoint` adapter behind a host allow-list. | Technology / InfoSec |
| OQ-13 | Confirm the moveable Islamic public holiday dates each year. | SLA business-hour calculation. | Provisional dates in `business_calendar/NG_HEAD_OFFICE`. | Operations |
| OQ-14 | Should customers be able to edit or withdraw financial statements they entered before submission? | Currently only staff correct them. | Staff correction with audit trail. | Product owner |
| OQ-15 | OCR provider for PDF / scanned bank statements and financial statements. | PDF statements are flagged for manual validation. | CSV/XLSX parsed automatically. | Technology |
| OQ-16 | Confirm the drop-off funnel step order and any additional journey steps to track. | Analytics accuracy. | Order matches the application stepper. | Digital Banking |
| OQ-17 | Which role is the "Group Head" who may countersign offer letters above ₦2m? | Offer sign-off (D-41). | **Resolved (product owner, 19-Nov-2026)**: Group Head = Divisional / Directorate Head (DH) role. | Business / Credit Operations |
| OQ-18 | Should the RBE hold final authority up to ₦500m for cash-backed contingent facilities (PRD text), skipping HCR (grid)? | Authority matrix (D-29). | **Resolved (product owner, 19-Nov-2026)**: no — the RBE recommends and HCR is final up to ₦1bn for cash-backed contingents. | Credit Risk |
| OQ-19 | Are treasury bills and Bankers' Acceptances acceptable collateral? | Cash-backed classification and collateral list (D-25, D-37). | **Resolved (product owner, 19-Nov-2026)**: treasury bills are excluded; Bankers' Acceptance is kept as a collateral type (10% haircut, not cash-backed). Only cash deposits (incl. APG proceeds under lien) count towards cash-backed status. | Shariah Compliance / Credit Risk |
| OQ-20 | Scoring weights and category thresholds for the E&S checklist. | E&S category A/B/C (D-35). | Adverse answers weighted 1–10 (prohibited practices 10); A ≥ 12, B ≥ 5. | Sustainability |
| OQ-21 | The Bank's customer password standard (length, complexity, expiry, history). | Onboarding (D-22). | 12–128 characters, upper, lower, digit and symbol; no name or e-mail; 5 failures lock for 30 minutes. | Information Security — product owner accepted the current defaults for go-live on 19-Nov-2026 (customer and interim staff policies); InfoSec may tighten them by configuration change |
| OQ-22 | May a business have more than one portal user (delegates), given the username is the CBA company e-mail? | Onboarding (D-24). | One portal account per business. | Product owner |
| OQ-23 | Confirm BRMC (SWR) versus BCC (PRD) as the board committee for credit, and the NED composition of MIC. | Committee routing (D-31). | BRMC; MIC = MD, EDs and NEDs with 3 NED + 2 ED signatures. | Company Secretariat |
| OQ-24 | Definition of the "facility efficiency ratio" in the Credit Approval Memo. | CAM section 25 (D-45). | Not computed; analyst text. | Credit Risk |
| OQ-25 | Live core-banking statement API (endpoint, format, limits). | Statement spooling (D-42). | MOCK adapter; live adapter refuses until configured. | Technology |
| OQ-26 | Are the conventional facility types in the PRD list (overdraft, temporary overdraft, time loan, etc.) in scope, and if so under which Shariah structure? | Product catalogue (D-36). | Not offered; SWR Islamic products and contingents only. | Product / Shariah Compliance |
| OQ-27 | Should credit analysts and credit approvers be assigned by directorate (CIB vs Commercial, as in the PRD grid), and what is the updated directorate classification (SWR §13)? | Task assignment and reporting (D-46). | Credit roles bank-wide; existing directorate list. | Credit Risk / HR |
| OQ-28 | Product paper (product programme) workflows (PRD). | Separate approval workflows for programmes. | Not built; workflows can already be configured per product with `appliesWhen`. | Product owner |
| OQ-29 | Should related-party (group) exposure count towards the approval-authority amount? | Authority (D-33). | Shown on the term sheet but not added. | Credit Risk |
| OQ-30 | Are SWR SLA hours business hours or elapsed hours? | SLA due times (D-34). | Business hours (08:00–17:00 WAT, working days). | Operations |
| OQ-31 | Interim staff sign-in while AD is unavailable. | — | **Resolved (product owner, 19-Nov-2026)**: proceed with the interim Gazelle password + authenticator as built (D-51). Active Directory authentication and synchronisation are deferred; to be revisited by the product owner. | Product owner / Information Security |
| OQ-32 | Staff signature specimens ("sign automatically", SWR §2) for offer letters and memos. | Signature images on generated documents. | Names, roles and timestamps are recorded on sign-off; no signature images. | Credit Operations / Legal |
