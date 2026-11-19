# Workflow Model

## Definitions (configuration)

`workflow_definition` items choose a route by condition (e.g. `facility.origin = CUSTOMER`) and priority. Stages:

* **TASK**: role, task type, permitted actions, SLA policy, assignment (role queue / the customer's RM), return targets, **prerequisites** (e.g. `DOCUMENTS_VERIFIED`), optional condition.
* **PARALLEL**: branches that run concurrently; a branch is included only when its condition holds (E&S review when `risk.esRequired`). The stage completes when every included branch is complete.
* **APPROVAL_CHAIN**: expanded **lazily** when reached, using the facts at that moment (risk grade, SOL breach, RARORAC, cash-backed status are only known after analysis) and the `approval_authority` matrix.

Default routes (see `requirements-decisions.md` D-04):

```
Customer-initiated: RM review → BM review → [Credit analysis ∥ E&S review*] → CTL → GH Credit Risk → approval chain
RM-initiated:       BM review → RBE review → DH review → [Credit analysis ∥ E&S review*] → CTL → GH Credit Risk → approval chain
Post-acceptance:    [Legal ∥ Shariah] → Credit Operations          (*E&S when the configured trigger applies)
```

## Approval authority

Levels (CRO, ED, MD, MIC, BCC, Board) carry limits and optional cash-backed limits. The chain runs from the first level up to the first level whose limit covers the NGN-equivalent amount; lower levels **recommend**, the final level **approves**. Overrides (configurable):

| Override | Effect |
|---|---|
| Insider-related | Final level = Board, irrespective of amount |
| PEP | Final level at least MD, regardless of rating |
| SOL breach | Final level = Board |
| Pricing exception (RARORAC below threshold) | Final level at least ED |

If the officer at the final level has a lower **personal limit**, *Approve* is replaced by *Recommend*, and recommending inserts the next level (escalation for authority).

## Committees

Quorum, required approvals, required roles (e.g. MD on MIC), parallel or serial voting. One immutable vote per member. Decision: approved when quorum, approvals and required roles are all satisfied; declined as soon as approval becomes impossible.

## Actions

`CLAIM` (atomic compare-and-set; one holder), `RELEASE`, `REASSIGN` (with reason; role-checked), `RECOMMEND`, `APPROVE`, `DECLINE` (terminates by default; `CONTINUE_TO_FINAL` configurable), `RETURN` (to the customer with itemised rework, to the RM via a rework task, or to the previous stage), `REQUEST_CLARIFICATION` (opens a secure thread; optional SLA pause), `COMMENT`, `VOTE`, `COMPLETE`. Every action requires an idempotency key (replay-safe), checks the task `row_version`, and is written as an immutable `workflow_action` plus an audit entry. Decline, return and clarification require a comment. Segregation of duties: one person cannot take decision actions at two different stages of the same workflow.

## SLA

Each task gets an SLA policy (duration, business/calendar time, warning %, escalation ladder) and the business calendar (working days, hours, Nigerian public holidays). The sweep (every minute, advisory-locked) records warnings, breaches and escalations (default +24 h → CRO, +72 h → EXCO) idempotently as `sla_event`s and notifications.

## Facility status lifecycle

```
DRAFT → SUBMITTED → IN_REVIEW ⇄ RETURNED
IN_REVIEW → APPROVED | DECLINED
APPROVED → OFFER_ISSUED → OFFER_ACCEPTED → FULFILMENT → READY_FOR_ACTIVATION → ACTIVE
OFFER_ISSUED → IN_NEGOTIATION → (APPROVED with new terms version | OFFER_ISSUED) ; OFFER_ISSUED → OFFER_REJECTED
DRAFT/RETURNED/SUBMITTED/IN_REVIEW → WITHDRAWN
```
