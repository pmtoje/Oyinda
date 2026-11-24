import { createHash, randomUUID } from 'node:crypto';
import type { Db } from '../db/pool.js';
import { q } from '../db/pool.js';
import { DEMO_CBA_CUSTOMERS, DEMO_CBA_PEOPLE, DEMO_EXPOSURE, SANDBOX_IDENTITIES, SANDBOX_UNAVAILABLE } from './mock-data.js';
import type {
  AntivirusAdapter, BureauAdapter, CoreBankingAdapter, DirectoryAdapter, IdentityAdapter, MessagingAdapter, RaroracAdapter,
} from './types.js';
import { IntegrationError } from './types.js';

/** Deterministic pseudo-random from a seed so mock outputs are stable and testable. */
const seeded = (seed: string) => parseInt(createHash('sha256').update(seed).digest('hex').slice(0, 8), 16) / 0xffffffff;

export class MockCoreBanking implements CoreBankingAdapter {
  mode = 'MOCK' as const;
  private bookings = new Map<string, string>();
  async findPersonByBvn(bvn: string) {
    const p = DEMO_CBA_PEOPLE.find((x) => x.bvn === bvn);
    return p ? { cbaCustomerId: p.cbaCustomerId, fullName: p.fullName, dateOfBirth: p.dateOfBirth } : null;
  }
  async findByAccountNumber(accountNumber: string) {
    return DEMO_CBA_CUSTOMERS.find((c) => c.accounts.some((a) => a.accountNumber === accountNumber)) ?? null;
  }
  async getExposure(cbaCustomerId: string) {
    return DEMO_EXPOSURE[cbaCustomerId] ?? { lines: [], groupLines: [] };
  }
  async bookFacility(input: { idempotencyKey: string }) {
    const existing = this.bookings.get(input.idempotencyKey);
    if (existing) return { reference: existing };
    const ref = `MOCK-CBA-FAC-${input.idempotencyKey.slice(0, 8).toUpperCase()}`;
    this.bookings.set(input.idempotencyKey, ref);
    return { reference: ref };
  }
  async postDisbursement(input: { idempotencyKey: string }) {
    return { reference: `MOCK-CBA-DSB-${createHash('sha256').update(input.idempotencyKey).digest('hex').slice(0, 10).toUpperCase()}` };
  }
  /** MOCK statement: deterministic monthly inflows and outflows per account. Clearly fictitious. */
  async getStatement(input: { accountNumber: string; from: string; to: string }) {
    const acct = DEMO_CBA_CUSTOMERS.flatMap((c) => c.accounts).find((a) => a.accountNumber === input.accountNumber);
    if (!acct) throw new Error('Unknown account');
    const fmt = (n: number) => `"${(n / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}"`;
    const base = acct.currency === 'NGN' ? 150_000_000_00 : 30_000_00;
    let bal = Math.round(base * 0.2);
    const lines = [`Account Number: ${input.accountNumber}`, 'MOCK CBA STATEMENT - DEMO / NON-PRODUCTION', 'Trans Date,Value Date,Narration,Debit,Credit,Balance'];
    const start = new Date(`${input.from.slice(0, 7)}-01T00:00:00Z`);
    const end = new Date(`${input.to}T00:00:00Z`);
    for (let d = new Date(start), i = 0; d <= end; d.setUTCMonth(d.getUTCMonth() + 1), i++) {
      const mm = String(d.getUTCMonth() + 1).padStart(2, '0'), yy = d.getUTCFullYear();
      const credit = Math.round(base * (0.85 + seeded(`${input.accountNumber}:${yy}-${mm}:c`) * 0.3));
      const debit = Math.round(credit * (0.75 + seeded(`${input.accountNumber}:${yy}-${mm}:d`) * 0.2));
      bal += credit; lines.push(`06/${mm}/${yy},06/${mm}/${yy},MOCK INWARD TRANSFER ${i + 1},,${fmt(credit)},${fmt(bal)}`);
      bal -= debit; lines.push(`22/${mm}/${yy},22/${mm}/${yy},MOCK SUPPLIER PAYMENT ${i + 1},${fmt(debit)},,${fmt(bal)}`);
    }
    return { csv: Buffer.from(lines.join('\n') + '\n'), currency: acct.currency };
  }
}

/** Writes to the mock_outbox table so developers and automated tests can read messages. Never used in production. */
export class MockMessaging implements MessagingAdapter {
  mode = 'MOCK' as const;
  constructor(private db: () => Db) {}
  async sendSms(to: string, body: string) {
    await q(this.db(), 'INSERT INTO mock_outbox(channel,destination,body) VALUES ($1,$2,$3)', ['SMS', to, body]);
    return { providerRef: `mock-sms-${randomUUID()}` };
  }
  async sendEmail(to: string, subject: string, body: string) {
    await q(this.db(), 'INSERT INTO mock_outbox(channel,destination,subject,body) VALUES ($1,$2,$3,$4)', ['EMAIL', to, subject, body]);
    return { providerRef: `mock-email-${randomUUID()}` };
  }
}

/**
 * Mock Active Directory. Recognises only seeded DEMO usernames and a single demo password
 * supplied through MOCK_AD_DEMO_PASSWORD (never hard-coded). Real deployments use LDAPS bind.
 */
export class MockDirectory implements DirectoryAdapter {
  mode = 'MOCK' as const;
  constructor(private users: () => Promise<{ ad_username: string; display_name: string; email: string }[]>, private demoPassword: string | undefined) {}
  async authenticate(username: string, password: string) {
    if (!this.demoPassword || this.demoPassword.length < 12) return null;
    const a = Buffer.from(password);
    const b = Buffer.from(this.demoPassword);
    const { timingSafeEqual } = await import('node:crypto');
    const ok = a.length === b.length && timingSafeEqual(a, b);
    const u = (await this.users()).find((x) => x.ad_username.toLowerCase() === username.toLowerCase());
    if (!ok || !u) return null;
    return { username: u.ad_username, displayName: u.display_name, email: u.email, groups: ['GAZELLE-USERS'] };
  }
}

export class MockBureau implements BureauAdapter {
  mode = 'MOCK' as const;
  provider = 'MOCK-BUREAU';
  async businessReport(input: { rcNumber?: string; tin?: string; name: string }) {
    const key = input.rcNumber ?? input.tin ?? input.name;
    const r = seeded(key);
    if (key.endsWith('000')) return { status: 'NO_HIT' as const, providerRef: `mock-${randomUUID()}` };
    return {
      status: 'COMPLETED' as const,
      providerRef: `mock-${randomUUID()}`,
      reportReference: `MOCKRPT-${createHash('sha1').update(key).digest('hex').slice(0, 10).toUpperCase()}`,
      score: Math.round(550 + r * 250),
      totalFacilities: 1 + Math.floor(r * 5),
      totalOutstandingMinor: Math.round(r * 400_000_000) * 100,
      delinquentFacilities: r > 0.92 ? 1 : 0,
      worstClassification: r > 0.92 ? 'WATCHLIST' : 'PERFORMING',
      summary: { note: 'MOCK bureau response — not a real credit report' },
    };
  }
  async individualReport(input: { bvn: string; name: string }) {
    const r = seeded(input.bvn);
    return {
      status: 'COMPLETED' as const,
      providerRef: `mock-${randomUUID()}`,
      reportReference: `MOCKRPT-${createHash('sha1').update(input.bvn).digest('hex').slice(0, 10).toUpperCase()}`,
      score: Math.round(600 + r * 200),
      totalFacilities: Math.floor(r * 3),
      totalOutstandingMinor: Math.round(r * 15_000_000) * 100,
      delinquentFacilities: 0,
      worstClassification: 'PERFORMING',
      summary: { note: 'MOCK bureau response — not a real credit report' },
    };
  }
}

/**
 * SANDBOX identity provider (non-production only; production refuses to start with it). Answers from a small
 * registry of synthetic identities so every outcome can be exercised. Results are recorded as SANDBOX and are
 * never presented as a live BVN/NIN check.
 */
export class MockIdentity implements IdentityAdapter {
  mode = 'MOCK' as const;
  provider = 'Credit360 identity sandbox';
  private lookup(kind: 'bvn' | 'nin', value: string) {
    if (value === SANDBOX_UNAVAILABLE[kind]) throw new IntegrationError('Identity', `${kind.toUpperCase()} provider unavailable (sandbox outage simulation)`, true);
    const hit = SANDBOX_IDENTITIES.find((p) => p[kind] === value);
    const providerRef = `SBX-${kind.toUpperCase()}-${createHash('sha256').update(value).digest('hex').slice(0, 10).toUpperCase()}`;
    return hit ? { found: true, record: { fullName: hit.fullName, dateOfBirth: hit.dateOfBirth }, providerRef } : { found: false, providerRef };
  }
  async lookupBvn(bvn: string) { return this.lookup('bvn', bvn); }
  async lookupNin(nin: string) { return this.lookup('nin', nin); }
}

/**
 * Development stand-in for the Bank's Risk Asset & Pricing Portal.
 * The formula is illustrative only; results are labelled MOCK everywhere they appear.
 */
export class MockRarorac implements RaroracAdapter {
  mode = 'MOCK' as const;
  provider = 'MOCK-RAPP';
  async compute(req: import('./types.js').RaroracRequest) {
    const pd: Record<string, number> = { AAA: 0.003, AA: 0.006, A: 0.01, BBB: 0.02, BB: 0.04, B: 0.08, CCC: 0.18, C: 0.35 };
    const p = pd[req.riskGrade] ?? 0.05;
    const lgd = Math.max(0.1, 0.45 * (1 - Math.min(req.collateralCoveragePct, 150) / 150));
    const ead = req.amountMinor;
    const el = ead * p * lgd;
    const unfunded = req.productCategory === 'CONTINGENT';
    const ec = ead * 0.08 * (1 + p * 4) * (unfunded ? 0.5 : 1);
    const income = ead * ((req.proposedProfitRatePct + req.managementFeePct / Math.max(req.tenorMonths / 12, 1)) / 100);
    const fundingCost = unfunded ? 0 : ead * 0.12; // guarantees are unfunded until invoked
    const opCost = ead * 0.01;
    const rarorac = ((income - fundingCost - opCost - el) / ec) * 100;
    const recommended = ((fundingCost + opCost + el + ec * 0.18) / ead) * 100;
    return {
      providerRef: `mock-rapp-${randomUUID()}`,
      raroracPct: Math.round(rarorac * 100) / 100,
      recommendedProfitRatePct: Math.round(recommended * 100) / 100,
      expectedLossMinor: Math.round(el),
      economicCapitalMinor: Math.round(ec),
      notes: ['MOCK computation for development and testing only. Not a production RARORAC result.'],
    };
  }
}

const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';

/** Detects the EICAR test signature only. Clearly reported as a mock engine. */
export class MockAntivirus implements AntivirusAdapter {
  mode = 'MOCK' as const;
  async scan(data: Buffer) {
    return data.includes(Buffer.from(EICAR))
      ? { status: 'INFECTED' as const, engine: 'mock-eicar-only', signature: 'EICAR-Test-File' }
      : { status: 'CLEAN' as const, engine: 'mock-eicar-only' };
  }
}
