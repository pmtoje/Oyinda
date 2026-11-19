import { env } from '../config/env.js';
import { getPool, q } from '../db/pool.js';
import { MockAntivirus, MockBureau, MockCoreBanking, MockDirectory, MockIdentity, MockMessaging, MockRarorac } from './mocks.js';
import { ClamdAntivirus, unprovisionedBureau, unprovisionedCba, unprovisionedDirectory, unprovisionedIdentity, unprovisionedMessaging, unprovisionedRarorac } from './live.js';
import type { AntivirusAdapter, BureauAdapter, CoreBankingAdapter, DirectoryAdapter, IdentityAdapter, MessagingAdapter, RaroracAdapter } from './types.js';

export interface Integrations {
  cba: CoreBankingAdapter;
  messaging: MessagingAdapter;
  directory: DirectoryAdapter;
  bureau: BureauAdapter;
  identity: IdentityAdapter;
  rarorac: RaroracAdapter;
  antivirus: AntivirusAdapter;
}

let current: Integrations | undefined;

export function integrations(): Integrations {
  if (current) return current;
  const e = env();
  current = {
    cba: e.CBA_MODE === 'mock' ? new MockCoreBanking() : unprovisionedCba,
    messaging: e.MESSAGING_MODE === 'mock' ? new MockMessaging(() => getPool()) : unprovisionedMessaging,
    directory: e.AD_MODE === 'mock'
      ? new MockDirectory(async () => q(getPool(), `SELECT ad_username, display_name, email FROM app_user WHERE is_demo AND status='ACTIVE'`), process.env.MOCK_AD_DEMO_PASSWORD)
      : unprovisionedDirectory,
    bureau: e.BUREAU_MODE === 'mock' ? new MockBureau() : unprovisionedBureau,
    identity: e.IDENTITY_MODE === 'mock' ? new MockIdentity() : unprovisionedIdentity,
    rarorac: e.RARORAC_MODE === 'mock' ? new MockRarorac() : unprovisionedRarorac,
    antivirus: e.AV_MODE === 'mock' ? new MockAntivirus() : new ClamdAntivirus(e.CLAMD_HOST ?? '127.0.0.1', e.CLAMD_PORT ?? 3310),
  };
  return current;
}

export function overrideIntegrations(partial: Partial<Integrations>): void {
  current = { ...integrations(), ...partial };
}
