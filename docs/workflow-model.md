# Workflow Model

> **Product name:** this platform is now **Credit360 by AltBank** (product owner direction, 24-Nov-2026). "Gazelle" below is its original working name, kept where it traces to the source PRD/BRD/SWR and to earlier decisions.

## Definitions (configuration)

`workflow_definition` items choose a route by condition (e.g. `facility.origin = CUSTOMER`) and priority. Stages:

* **TASK**: role, task type, permitted actions, SLA policy, assignment (role queue / the customer's RM), return targets, **prerequisites** (e.g. `DOCUMENTS_VERIFIED`), optional condition.
* **PARALLEL**: branches that run concurrently; a branch is included only when its condition holds (E&S review when `risk.esRequired`). The stage completes when every included branch is complete.
* **APPROVAL_CHAIN**: expanded **lazily** when reached, using the facts at that moment (risk grade, SOL breach, RARORAC, cash-backed status are only known after analysis) and the `approval_authority` matrix.

Routes (SWR §7; see `requirements-decisions.md` D-26):

```
Customer-initiated: RM → Team Lead → RBE → DH → [Credit analysis ∥ E&S review*] → Team Lead, Credit Analysis → approval chain
RM-initiated:       Team Lead → RBE → DH → [Credit analysis ∥ E&S review*] → Team Lead, Credit Analysis → approval chain
Post-approval:      [Legal ∥ Shariah] → Credit Operations          (*E&S: ≥ ₦100m in HEART, Oil & Gas, Mining, Aviation)
```

A stage may continue after a "not recommended" (`onDecline: CONTINUE` — RM, E&S and credit analyst, per the PRD); TL, RBE, DH and approver declines end the workflow.

## Approval authority (PRD approval grid)

The `APPROVAL_CHAIN` stage picks the active `approval_authority` matrix whose condition matches (highest priority): **approved line / direct**, **non-cash-backed contingent**, **cash-backed direct**, **cash-backed contingent** (cash ≥ 110% of the amount). The authority amount is the request **plus outstanding exposure** (`amountBasis: AGGREGATE_EXPOSURE`).

Levels follow the SWR order HCR → CRO → Line ED → ED (concurrence) → MD → MIC → BRMC → Board. Combination approvals are levels that **join above an amount**; the first participating level that may be final and whose limit covers the amount approves, the others recommend:

| Authority amount (approved line / direct, non-cash contingent) | Chain |
|---|---|
| ≤ ₦50m | HCR (after RBE/TL and DH reviews) |
| ≤ ₦100m | HCR → ED |
| ≤ ₦150m | HCR → CRO → ED |
| ≤ ₦500m | HCR → CRO → ED → ED concurrence → MD |
| ≤ ₦750m | … → MIC |
| ≤ ₦1.5bn | … → BRMC |
| > ₦1.5bn | … → Board |

Cash-backed matrices: HCR ≤ ₦1bn, + ED ≤ ₦1.5bn, + CRO ≤ ₦2bn, + 2nd ED and MD ≤ ₦2.5bn, MIC above.

| Override | Effect |
|---|---|
| Insider-related | Full chain, Board final, irrespective of amount |
| PEP | Standard route regardless of rating; full chain, Board final |
| SOL breach | Full chain, Board final |
| Pricing exception (RARORAC below threshold) | Final level at least the Line ED |

If the officer at the final level has a lower **personal limit**, *Approve* is replaced by *Recommend*, and recommending inserts the next level (escalation for authority). Segregation of duties makes the ED concurrence a different ED from the Line ED.

## Committees

Quorum, required approvals, required roles and **minimum signatures per role** (PRD: MIC 3 NEDs + 2 EDs including the MD; BRMC chairman + 2 NEDs; Board chairman), parallel or serial voting. One immutable vote per member. Credit Operations may **record the committee decision** from the signed minutes (minutes reference required). Decision: approved when quorum, approvals and required roles are all satisfied; declined as soon as approval becomes impossible.

## Actions

`CLAIM` (atomic compare-and-set; one holder), `RELEASE`, `REASSIGN` (with reason; role-checked), `RECOMMEND`, `APPROVE`, `DECLINE` (terminates by default; `CONTINUE_TO_FINAL` configurable), `RETURN` (to the customer with itemised rework, to the RM via a rework task, or to the previous stage), `REQUEST_CLARIFICATION` (opens a secure thread; optional SLA pause), `COMMENT`, `VOTE`, `RECORD_DECISION`, `COMPLETE`. Every action requires an idempotency key (replay-safe), checks the task `row_version`, and is written as an immutable `workflow_action` plus an audit entry. Decline, return and clarification require a comment. Segregation of duties: one person cannot take decision actions at two different stages of the same workflow.

## SLA

Each task gets an SLA policy (duration, business/calendar time, warning %, escalation ladder) and the business calendar (working days, hours, Nigerian public holidays). The sweep (every minute, advisory-locked) records warnings, breaches and escalations (PRD: breach over 2 days → CRO, over 5 days → EXCO; SWR stage timelines) idempotently as `sla_event`s and notifications.

## Facility status lifecycle

```
DRAFT → SUBMITTED → IN_REVIEW ⇄ RETURNED
IN_REVIEW → APPROVED | DECLINED
APPROVED → (offer maker-checker → business sign-off) → OFFER_ISSUED → OFFER_ACCEPTED → FULFILMENT → READY_FOR_ACTIVATION → ACTIVE
OFFER_ISSUED → IN_NEGOTIATION → (APPROVED with new terms version | OFFER_ISSUED) ; OFFER_ISSUED → OFFER_REJECTED
DRAFT/RETURNED/SUBMITTED/IN_REVIEW → WITHDRAWN
```
