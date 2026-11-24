/** Integration contracts. Credit360 depends only on these interfaces; providers are swappable. */
export type Mode = 'MOCK' | 'LIVE';

export interface CbaAccount {
  accountNumber: string;
  accountName: string;
  currency: string;
  productName: string;
  status: 'ACTIVE' | 'DORMANT' | 'CLOSED' | 'PND';
}
export interface CbaCustomer {
  cbaCustomerId: string;
  customerType: 'CORPORATE' | 'INDIVIDUAL';
  businessName: string;
  rcNumber?: string;
  tin?: string;
  incorporationDate?: string;
  address?: string;
  city?: string;
  state?: string;
  registeredPhone: string;
  registeredEmail?: string;
  relationshipManagerStaffNumber?: string;
  businessUnitCode?: string;
  customerSince?: string;
  accounts: CbaAccount[];
}
export interface CbaExposureLine {
  reference: string;
  product: string;
  kind: 'DIRECT' | 'CONTINGENT';
  currency: string;
  approvedMinor: number;
  outstandingMinor: number;
  maturityDate?: string;
  classification: 'PERFORMING' | 'WATCHLIST' | 'SUBSTANDARD' | 'DOUBTFUL' | 'LOST';
  relatedParty?: string;
}
export interface CoreBankingAdapter {
  mode: Mode;
  findByAccountNumber(accountNumber: string): Promise<CbaCustomer | null>;
  getExposure(cbaCustomerId: string): Promise<{ lines: CbaExposureLine[]; groupLines: CbaExposureLine[] }>;
  bookFacility(input: { idempotencyKey: string; cbaCustomerId: string; product: string; amountMinor: number; currency: string; tenorMonths: number; profitRatePct: number }): Promise<{ reference: string }>;
  postDisbursement(input: { idempotencyKey: string; facilityReference: string; amountMinor: number; beneficiaryAccount: string; narrative: string }): Promise<{ reference: string }>;
  /** SWR: spool an Alternative Bank account statement (CSV in the Bank's statement export layout). */
  getStatement(input: { accountNumber: string; from: string; to: string }): Promise<{ csv: Buffer; currency: string }>;
}

export interface MessagingAdapter {
  mode: Mode;
  sendSms(to: string, body: string): Promise<{ providerRef: string }>;
  sendEmail(to: string, subject: string, body: string): Promise<{ providerRef: string }>;
}

export interface DirectoryUser {
  username: string;
  displayName: string;
  email: string;
  groups: string[];
}
export interface DirectoryAdapter {
  mode: Mode;
  authenticate(username: string, password: string): Promise<DirectoryUser | null>;
}

export interface BureauReport {
  status: 'COMPLETED' | 'NO_HIT';
  providerRef: string;
  reportReference?: string;
  score?: number;
  totalFacilities?: number;
  totalOutstandingMinor?: number;
  delinquentFacilities?: number;
  worstClassification?: string;
  summary?: Record<string, unknown>;
}
export interface BureauAdapter {
  mode: Mode;
  provider: string;
  businessReport(input: { rcNumber?: string; tin?: string; name: string }): Promise<BureauReport>;
  individualReport(input: { bvn: string; name: string }): Promise<BureauReport>;
}

export interface IdentityAdapter {
  mode: Mode;
  verifyBvn(bvn: string, fullName: string): Promise<{ valid: boolean; nameMatch: 'MATCH' | 'PARTIAL' | 'MISMATCH' | 'UNKNOWN' }>;
}

export interface RaroracRequest {
  facilityRef: string;
  product: string;
  amountMinor: number;
  currency: string;
  tenorMonths: number;
  proposedProfitRatePct: number;
  managementFeePct: number;
  riskGrade: string;
  collateralCoveragePct: number;
  customerSector: string;
  productCategory: 'DIRECT' | 'CONTINGENT' | 'INVESTMENT';
}
export interface RaroracResponse {
  providerRef: string;
  raroracPct: number;
  recommendedProfitRatePct: number;
  expectedLossMinor: number;
  economicCapitalMinor: number;
  notes: string[];
}
export interface RaroracAdapter {
  mode: Mode;
  provider: string;
  compute(req: RaroracRequest): Promise<RaroracResponse>;
}

export interface ScanResult {
  status: 'CLEAN' | 'INFECTED' | 'ERROR';
  engine: string;
  signature?: string;
}
export interface AntivirusAdapter {
  mode: Mode;
  scan(data: Buffer): Promise<ScanResult>;
}

export class IntegrationError extends Error {
  constructor(public readonly system: string, message: string, public readonly retryable = true) {
    super(`${system}: ${message}`);
  }
}
