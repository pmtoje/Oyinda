import { createHash, randomUUID } from 'node:crypto';
import type { Db } from '../db/pool.js';
import { q } from '../db/pool.js';
import { DEMO_CBA_CUSTOMERS, DEMO_EXPOSURE } from './mock-data.js';
import type {
  AntivirusAdapter, BureauAdapter, CoreBankingAdapter, DirectoryAdapter, IdentityAdapter, MessagingAdapter, RaroracAdapter,
} from './types.js';

/** Deterministic pseudo-random from a seed so mock outputs are stable and testable. */
const seeded = (seed: string) => parseInt(createHash('sha256').update(seed).digest('hex').slice(0, 8), 16) / 0xffffffff;

export class MockCoreBanking implements CoreBankingAdapter {
  mode = 'MOCK' as const;
  private bookings = new Map<string, string>();
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

export class MockIdentity implements IdentityAdapter {
  mode = 'MOCK' as const;
  async verifyBvn(bvn: string, _fullName: string) {
    // Structural validation only in mock mode; '00000000000'-style values are rejected.
    const valid = /^[0-9]{11}$/.test(bvn) && !/^(\d)\1{10}$/.test(bvn);
    return { valid, nameMatch: valid ? ('UNKNOWN' as const) : ('MISMATCH' as const) };
  }
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
    const ec = ead * 0.08 * (1 + p * 4);
    const income = ead * ((req.proposedProfitRatePct + req.managementFeePct / Math.max(req.tenorMonths / 12, 1)) / 100);
    const fundingCost = ead * 0.12;
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
