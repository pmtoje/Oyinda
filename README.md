# Gazelle by Alternative Bank

Corporate, commercial and institutional **non-interest (Islamic) credit** origination, assessment, approval, fulfilment and monitoring platform.

```
Onboarding → Business profile → Facility request → FIPG eligibility → Documents → Financial & bank-statement analysis
→ Bureau, exposure, collateral, risk rating, RARORAC, E&S → Configurable approval workflow (incl. committees)
→ Executive decision → Offer (maker-checker) → Accept / negotiate → Legal ∥ Shariah → Credit Operations
→ Activation → Disbursement (maker-checker) → Monitoring
```

> **DEMO / NON-PRODUCTION.** All integrations (core banking, Active Directory, credit bureau, RARORAC portal, SMS/email, antivirus) run as clearly labelled **mock** adapters in this repository. The UI shows a persistent banner, and every mock-derived value is tagged `MOCK`. Production refuses to start in mock mode.

## Repository layout

| Path | Contents |
|---|---|
| `apps/api` | Fastify + TypeScript API, PostgreSQL migrations, domain modules, integration adapters, worker, seed, tests |
| `apps/web` | React + Vite web app: customer portal, staff workspace, executive decision view, control centre |
| `packages/shared` | Condition language, safe formula engine and shared vocabulary |
| `docs` | Architecture, security, data and workflow models, traceability, decisions, open questions, runbook |

## Run locally

Requirements: Node 22, pnpm 10, PostgreSQL 16.

```bash
pnpm install
createdb gazelle_dev                       # and a role with access to it
cp apps/api/.env.example apps/api/.env     # then fill HMAC_KEY / DATA_KEY (see the comment in the file)
echo "MOCK_AD_DEMO_PASSWORD=$(openssl rand -base64 18)" >> apps/api/.env   # demo staff password (mock directory)
pnpm --filter @gazelle/api seed            # migrations + baseline configuration + DEMO data
pnpm dev:api                               # http://127.0.0.1:4000
pnpm --filter @gazelle/api worker          # background jobs and SLA / monitoring sweeps
pnpm dev:web                               # http://localhost:5173
```

### Demo walkthrough

| Who | Sign-in | Notes |
|---|---|---|
| Customer (ABC Manufacturing Ltd) | `/login` → `treasury@abc-manufacturing.demo`, DEMO password `Gazelle#Portal2026` | Then the sign-in OTP, which goes to the mock outbox: `pnpm --filter @gazelle/api demo:otp` |
| New customer onboarding | `/` → "Yes" → account `0100000003` (Kano Agro-Allied, DEMO), your name and role | The OTP goes to the CBA phone and e-mail (mock outbox); the welcome e-mail link is in the mock outbox too |
| Staff | `/staff/login` → `demo.rm`, `demo.bm` (Team Lead), `demo.rbe`, `demo.dh`, `demo.analyst`, `demo.es`, `demo.ctl`, `demo.ghcr`, `demo.cro`, `demo.ed`, `demo.ed2`, `demo.md`, `demo.ned1`–`3`, `demo.brmcchair`, `demo.boardchair`, `demo.legal`, `demo.shariah`, `demo.creditops`, `demo.creditops2`, `demo.admin`, `demo.superadmin`, `demo.auditor` … | Password = `MOCK_AD_DEMO_PASSWORD`. First sign-in enrols TOTP; for users enrolled by the seed: `pnpm --filter @gazelle/api demo:totp demo.analyst` |

Staff directory: until Active Directory synchronisation is integrated, administrators load staff, roles, line managers, approval limits and sectors from a spreadsheet (Admin → Users & access → Import from spreadsheet; template provided). A second administrator approves each upload.

Seeded state: a ₦150m Murabaha with Credit Analysis (Manufacturing is outside the E&S sectors), a draft Ijarah, and a ₦45m APG approved by the MD (request + outstanding exposure) with a signed offer awaiting the customer.

## Tests

```bash
pnpm --filter @gazelle/api test           # unit + API integration + end-to-end journeys against a real PostgreSQL test DB
pnpm --filter @gazelle/web e2e            # browser journeys (Playwright); requires API + web running
```

Further detail: [`docs/`](docs) — start with `architecture-assessment.md`, then `security-model.md`, `workflow-model.md`, `requirements-traceability.md` and `production-readiness.md`.
