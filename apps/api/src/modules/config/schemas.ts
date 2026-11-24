import { z } from 'zod';
import { validateCondition, parseFormula, variablesOf, type Condition } from '@gazelle/shared';

/** Facts that conditions may reference. Admin-authored rules are validated against this catalogue. */
export const FACT_CATALOGUE: Record<string, string> = {
  'facility.amountNgn': 'Facility amount (NGN equivalent, major units)',
  'facility.amount': 'Facility amount in facility currency (major units)',
  'facility.currency': 'Facility currency',
  'facility.tenorMonths': 'Tenor in months',
  'facility.productCode': 'Product code',
  'facility.productFamily': 'Islamic contract family (MURABAHA, IJARAH, ...)',
  'facility.category': 'Product category (DIRECT, CONTINGENT, INVESTMENT)',
  'facility.origin': 'Initiated by CUSTOMER or RM',
  'facility.isContingent': 'Contingent (indirect) facility',
  'facility.isCashBacked': 'Qualifies as cash-backed under collateral rules',
  'facility.isProductPaper': 'Originated under an approved product programme',
  'facility.collateralCoveragePct': 'Eligible collateral cover, % of facility',
  'facility.creditTurnoverCoverX': 'Annualised credit turnover ÷ facility amount (x)',
  'customer.category': 'Customer category',
  'customer.sector': 'Sector code',
  'customer.yearsInOperation': 'Years since incorporation',
  'customer.yearsWithBank': 'Years banking with Alternative Bank',
  'customer.hasRcNumber': 'RC number provided',
  'customer.hasTin': 'TIN provided',
  'customer.hasLitigation': 'Declared material litigation',
  'customer.hasRegulatoryMatters': 'Declared regulatory matters',
  'customer.isPep': 'Any shareholder/director/promoter is a PEP',
  'customer.isInsider': 'Insider-related (director/staff relationship)',
  'customer.auditedYears': 'Number of audited financial years on file',
  'customer.latestRevenueNgn': 'Latest annualised revenue (NGN)',
  'customer.latestPatNgn': 'Latest profit after tax (NGN)',
  'customer.hasDelinquentBureau': 'Any delinquent bureau record',
  'customer.avgMonthlyCreditTurnoverNgn': 'Average monthly credit turnover (NGN)',
  'risk.combinedGrade': 'Combined risk grade',
  'risk.esRequired': 'E&S assessment required',
  'risk.esCategory': 'E&S category (A, B, C)',
  'risk.solBreached': 'Single Obligor Limit breached',
  'risk.raroracWithinThreshold': 'RARORAC within configured threshold',
};
export const FACT_KEYS = new Set(Object.keys(FACT_CATALOGUE));

const condition = z.custom<Condition>((v) => validateCondition(v, FACT_KEYS).length === 0, {
  message: 'Invalid condition (check fact names and operators)',
});
const code = z.string().regex(/^[A-Z][A-Z0-9_]{1,60}$/, 'Use UPPER_SNAKE_CASE');
const optionCode = z.string().regex(/^[A-Z0-9][A-Z0-9_]{0,60}$/, 'Use upper-case letters, digits and _');
const minor = z.number().int().nonnegative();
const pct = z.number().min(0).max(100);
const roleCode = z.string().regex(/^[A-Z][A-Z0-9_]{1,40}$/);
/** Variables available to the facility efficiency ratio formula (amounts in Naira). */
export const EFFICIENCY_VARIABLES: Record<string, string> = {
  REQUEST_AMOUNT: 'Requested facility amount (₦, FX-converted)',
  TENOR_MONTHS: 'Requested tenor (months)',
  OUTSTANDING_EXPOSURE: 'Existing outstanding exposure — direct plus CCF-weighted contingent (₦)',
  AGGREGATE_EXPOSURE: 'Aggregate exposure including this request and related parties (₦)',
  ANNUAL_REVENUE: 'Revenue, latest period, annualised (₦)',
  EBITDA: 'EBITDA, latest period, annualised (₦)',
  PROFIT_AFTER_TAX: 'Profit after tax, latest period, annualised (₦)',
  OPERATING_CASH_FLOW: 'Operating cash flow, latest period, annualised (₦)',
  TOTAL_EQUITY: 'Total equity, latest period (₦)',
  TOTAL_FINANCING: 'Total financing / borrowings, latest period (₦)',
  AVG_MONTHLY_CREDIT_TURNOVER: 'Average monthly credit turnover across all accounts, excluding reversals (₦)',
  ANNUAL_CREDIT_TURNOVER: 'Average monthly credit turnover × 12 (₦)',
  ALTBANK_WALLET_SHARE: 'Alternative Bank share of credit turnover (%)',
  ELIGIBLE_COLLATERAL: 'Eligible collateral value after haircuts (₦)',
  COLLATERAL_COVERAGE: 'Eligible collateral as a percentage of the request (%)',
  PRICING_RATE: 'Proposed profit rate or commission (%)',
  RARORAC: 'RARORAC (%)',
};

export function efficiencyFormulaError(formula: string): string | null {
  try {
    const vars = [...variablesOf(parseFormula(formula))].filter((v) => !(v in EFFICIENCY_VARIABLES));
    return vars.length ? `Unknown variable(s): ${vars.join(', ')}. Use the listed variables only.` : null;
  } catch (e) { return (e as Error).message; }
}
export const PREREQUISITES = ['BUREAU', 'EXPOSURE', 'FINANCIAL_ANALYSIS', 'STATEMENT_ANALYSIS', 'COLLATERAL', 'RISK_RATING', 'RARORAC', 'CREDIT_MEMO', 'ES_ASSESSMENT', 'CONDITIONS_LEGAL', 'CONDITIONS_SHARIAH', 'CONDITIONS_ALL_MANDATORY', 'DOCUMENTS_VERIFIED'] as const;
const prereqs = z.array(z.enum(PREREQUISITES)).default([]);

export const productField = z.object({
  key: z.string().regex(/^[a-z][a-zA-Z0-9]{1,40}$/),
  label: z.string().min(2).max(120),
  type: z.enum(['text', 'textarea', 'number', 'money', 'date', 'select', 'boolean']),
  required: z.boolean().default(false),
  options: z.array(z.object({ value: z.string(), label: z.string() })).optional(),
  help: z.string().max(300).optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  maxLength: z.number().int().positive().max(5000).optional(),
});

export const schemas = {
  product: z.object({
    code,
    /** SWR: facility names must not contain special characters. */
    name: z.string().min(2).max(80).regex(/^[A-Za-z0-9 ]+$/, 'Facility names may contain letters, digits and spaces only'),
    /** Plain-language description shown beside the name, e.g. "Cost Plus Financing". */
    descriptor: z.string().max(80).optional(),
    family: z.enum(['MURABAHA', 'IJARAH', 'ISTISNA', 'SALAM', 'QARD', 'MUSHARAKA', 'MUDARABA', 'DIRECT_INVESTMENT', 'COMMON_STOCK', 'WAKALAH_BIL_ISTITHMAR', 'KAFALAH']),
    category: z.enum(['DIRECT', 'CONTINGENT', 'INVESTMENT']),
    contingentType: z.enum(['APG', 'BANK_GUARANTEE', 'BID_BOND', 'PERFORMANCE_BOND', 'CUSTOM_BOND', 'BAIL_BOND', 'OTHER']).optional(),
    summary: z.string().min(10).max(600),
    shariahStructure: z.string().min(10).max(1500),
    currencies: z.array(z.string().regex(/^[A-Z]{3}$/)).min(1),
    minAmountMinor: minor,
    maxAmountMinor: minor,
    minTenorMonths: z.number().int().positive(),
    maxTenorMonths: z.number().int().positive(),
    pricingBasis: z.enum(['PROFIT_RATE', 'RENTAL', 'PROFIT_SHARING_RATIO', 'FEE', 'NONE']),
    indicativeProfitRatePct: z.number().min(0).max(100).optional(),
    paymentFrequencies: z.array(z.enum(['MONTHLY', 'QUARTERLY', 'SEMI_ANNUAL', 'ANNUAL', 'BULLET'])).min(1),
    requiresSupplier: z.boolean(),
    requiresAsset: z.boolean(),
    requiresProject: z.boolean(),
    customerSelectable: z.boolean(),
    isProductPaper: z.boolean().default(false),
    fields: z.array(productField).max(40),
  }).refine((p) => p.maxAmountMinor >= p.minAmountMinor && p.maxTenorMonths >= p.minTenorMonths, 'Max must be ≥ min'),

  document_requirement: z.object({
    code,
    title: z.string().min(3),
    description: z.string().max(600),
    docType: code,
    stage: z.enum(['APPLICATION', 'FULFILMENT']),
    appliesWhen: condition,
    mandatory: z.boolean(),
    customerVisible: z.boolean(),
    acceptedMime: z.array(z.enum(['application/pdf', 'image/png', 'image/jpeg', 'text/csv', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'])).min(1),
    maxSizeMb: z.number().positive().max(50),
    /** Customer-level documents (e.g. CAC certificate) may be reused across requests once verified. */
    reusable: z.boolean().default(false),
    validityDays: z.number().int().positive().optional(),
  }),

  fipg_rule: z.object({
    code,
    description: z.string().min(5),
    appliesWhen: condition,
    passWhen: condition,
    requiredValue: z.string().min(1),
    severity: z.enum(['BLOCKER', 'MAJOR', 'MINOR']),
    action: z.enum(['DECLINE', 'REFER', 'EXCEPTION', 'WARN']),
    exceptionAllowed: z.boolean(),
    customerMessage: z.string().min(5).max(400),
    internalMessage: z.string().min(5).max(800),
    customerTypes: z.array(z.string()).default([]),
    productCodes: z.array(z.string()).default([]),
    sectorCodes: z.array(z.string()).default([]),
  }),

  financial_template: z.object({
    lines: z.array(z.object({
      code,
      label: z.string(),
      section: z.enum(['INCOME_STATEMENT', 'BALANCE_SHEET', 'CASH_FLOW']),
      isFlow: z.boolean(),
      required: z.boolean(),
      derived: z.string().optional(),
    })).min(5),
  }),

  ratio: z.object({
    code,
    name: z.string(),
    formula: z.string().refine((f) => { try { parseFormula(f); return true; } catch { return false; } }, 'Formula does not parse'),
    unit: z.enum(['x', '%', 'days', 'NGN']),
    category: z.enum(['PROFITABILITY', 'LIQUIDITY', 'LEVERAGE', 'COVERAGE', 'EFFICIENCY', 'GROWTH']),
    direction: z.enum(['HIGHER_BETTER', 'LOWER_BETTER']),
    weight: z.number().min(0).max(100),
    sectors: z.array(z.string()).default([]),
    bands: z.array(z.object({ min: z.number().optional(), max: z.number().optional(), score: z.number(), label: z.string(), implication: z.string() })).min(1),
  }),

  scorecard: z.object({
    kind: z.enum(['ORR', 'INDUSTRY', 'COLLATERAL']),
    name: z.string(),
    sectors: z.array(z.string()).default([]),
    sections: z.array(z.object({
      code,
      name: z.string(),
      weight: z.number().min(0).max(100),
      questions: z.array(z.object({
        code,
        text: z.string(),
        guidance: z.string().optional(),
        options: z.array(z.object({ code: optionCode, label: z.string(), score: z.number().min(0) })).min(2),
      })).min(1),
    })).min(1),
    grades: z.array(z.object({ grade: z.string(), minScore: z.number(), description: z.string() })).min(2),
  }),

  rating_model: z.object({
    components: z.array(z.object({ kind: z.enum(['ORR', 'FRR', 'INDUSTRY', 'COLLATERAL']), weight: z.number().min(0).max(100) })).min(1),
    grades: z.array(z.object({ grade: z.string(), minScore: z.number(), description: z.string(), riskLevel: z.enum(['LOW', 'MODERATE', 'ELEVATED', 'HIGH', 'UNACCEPTABLE']) })).min(2),
    frrGrades: z.array(z.object({ grade: z.string(), minScore: z.number(), description: z.string() })).min(2),
  }),

  collateral_type: z.object({
    code,
    name: z.string(),
    category: z.enum(['REAL_ESTATE', 'CASH', 'SECURITIES', 'GUARANTEE', 'CHARGE', 'NEGATIVE_PLEDGE', 'LEASED_ASSET', 'RECEIVABLES', 'INSTRUMENT']),
    defaultHaircutPct: pct,
    cashEquivalent: z.boolean(),
    shariahCompliant: z.literal(true),
    requiresValuation: z.boolean(),
    valuationValidityMonths: z.number().int().positive().optional(),
    requiresPerfection: z.boolean(),
    countsTowardsCoverage: z.boolean(),
  }),

  policy_cash_backed: z.object({ minCashCoveragePct: z.number().min(0).max(1000), eligibleTypeCodes: z.array(z.string()).min(1) }),

  sol_limit: z.object({
    singleObligorLimitMinor: minor,
    basisDescription: z.string(),
    contingentConversionPct: pct,
    sectorLimitsMinor: z.record(z.string(), minor).default({}),
  }),

  es_trigger: z.object({
    description: z.string(),
    triggerWhen: condition,
    questionnaire: z.array(z.object({ code, text: z.string(), options: z.array(z.object({ code: optionCode, label: z.string(), weight: z.number() })).min(2) })).min(1),
    categoryThresholds: z.object({ A: z.number(), B: z.number() }),
  }),

  rarorac_threshold: z.object({
    hurdlePct: z.number().min(0).max(100),
    minProfitRatePct: z.number().min(0).max(100),
    /** Minimum commission for fee-priced (Kafalah / contingent) products; profit-rate minimum does not apply to them. */
    minFeePct: z.number().min(0).max(100).default(1),
    exceptionApproverRole: roleCode,
    justificationMinLength: z.number().int().min(20).max(2000),
  }),

  workflow_definition: z.object({
    kind: z.enum(['CREDIT_APPROVAL', 'FULFILMENT', 'NEGOTIATION_REVIEW']),
    appliesWhen: condition,
    priority: z.number().int(),
    stages: z.array(z.discriminatedUnion('type', [
      z.object({ type: z.literal('TASK'), key: code, name: z.string(), role: roleCode, taskType: z.enum(['REVIEW', 'ANALYSIS', 'FULFILMENT', 'CHECK']), when: condition.optional(), actions: z.array(z.enum(['RECOMMEND', 'DECLINE', 'RETURN', 'REQUEST_CLARIFICATION', 'COMMENT', 'COMPLETE'])).min(1), slaPolicyKey: z.string(), prerequisites: prereqs, onDecline: z.enum(['TERMINATE', 'CONTINUE']).default('TERMINATE'), assignTo: z.enum(['ROLE_QUEUE', 'RELATIONSHIP_MANAGER', 'BRANCH_MANAGER', 'RM_LINE_MANAGER']).default('ROLE_QUEUE'), returnTargets: z.array(z.enum(['CUSTOMER', 'RM', 'PREVIOUS'])).default(['PREVIOUS']) }),
      z.object({ type: z.literal('PARALLEL'), key: code, name: z.string(), branches: z.array(z.object({ key: code, name: z.string(), role: roleCode, taskType: z.enum(['REVIEW', 'ANALYSIS', 'FULFILMENT', 'CHECK']), when: condition.optional(), actions: z.array(z.enum(['RECOMMEND', 'DECLINE', 'RETURN', 'REQUEST_CLARIFICATION', 'COMMENT', 'COMPLETE'])).min(1), slaPolicyKey: z.string(), prerequisites: prereqs, onDecline: z.enum(['TERMINATE', 'CONTINUE']).default('TERMINATE') })).min(2) }),
      /** authorityKey pins one matrix; when omitted the active matrix whose appliesWhen matches (highest priority) is used. */
      z.object({ type: z.literal('APPROVAL_CHAIN'), key: code, name: z.string(), authorityKey: z.string().optional() }),
    ])).min(1),
    declineBehaviour: z.enum(['TERMINATE', 'CONTINUE_TO_FINAL']).default('TERMINATE'),
    resumeAfterReturn: z.enum(['RETURNING_STAGE', 'START']).default('RETURNING_STAGE'),
  }),

  approval_authority: z.object({
    /** Workflow type this matrix governs (e.g. approved line direct, cash-backed contingent). */
    workflowType: z.string().optional(),
    appliesWhen: condition.optional(),
    priority: z.number().int().default(0),
    /** REQUEST: the requested amount. AGGREGATE_EXPOSURE: requested amount plus the obligor's outstanding exposure (PRD). */
    amountBasis: z.enum(['REQUEST', 'AGGREGATE_EXPOSURE']).default('REQUEST'),
    levels: z.array(z.object({
      code,
      name: z.string(),
      kind: z.enum(['INDIVIDUAL', 'COMMITTEE']),
      role: roleCode.optional(),
      committeeKey: z.string().optional(),
      limitMinor: minor,
      cashBackedLimitMinor: minor.optional(),
      slaPolicyKey: z.string(),
      alwaysReview: z.boolean().default(false),
      /** The level only takes part when the amount exceeds this value (combination / concurrence approvals). */
      participatesAboveMinor: minor.optional(),
      /** A concurring level that never holds final authority on its own. */
      canBeFinal: z.boolean().default(true),
      /** Reached only through an override (e.g. insider-related to Board). */
      overrideOnly: z.boolean().default(false),
    })).min(1),
    overrides: z.array(z.object({
      code,
      reason: z.string(),
      when: condition,
      finalLevel: z.string().optional(),
      minimumFinalLevel: z.string().optional(),
      addReviewRole: roleCode.optional(),
      /** Every level up to the final level takes part, regardless of amount thresholds. */
      fullChain: z.boolean().default(false),
    })).default([]),
  }),

  /** CAM §25 facility efficiency ratio — defined and changed from time to time on management's or the Board's direction. */
  facility_efficiency_ratio: z.object({
    name: z.string().min(3).max(80),
    description: z.string().min(10).max(1000),
    formula: z.string().min(1).max(500).superRefine((f, ctx) => { const e = efficiencyFormulaError(f); if (e) ctx.addIssue({ code: 'custom', message: e }); }),
    unit: z.enum(['x', '%', 'days', 'NGN', 'ratio']),
    direction: z.enum(['HIGHER_BETTER', 'LOWER_BETTER', 'NEUTRAL']),
    bands: z.array(z.object({ min: z.number().nullable().optional(), max: z.number().nullable().optional(), label: z.string().min(1).max(40), assessment: z.string().min(3).max(300) })).max(10).default([]),
    directedBy: z.enum(['MANAGEMENT', 'BOARD']),
    /** Reference of the management or Board direction (e.g. MANCO minutes 2026/41, Board resolution 2026/12). */
    directionReference: z.string().trim().min(3).max(120),
  }),

  /** PRD offer-letter sign-off bands: who signs and who countersigns, by facility amount (NGN). */
  offer_signoff: z.object({
    bands: z.array(z.object({
      maxAmountMinor: minor,
      label: z.string(),
      signRoles: z.array(roleCode).min(1),
      countersignRoles: z.array(roleCode).min(1),
      /** The signatory must be the customer's assigned Relationship Manager when signing as RM. */
      signerMustBeAssignedRm: z.boolean().default(true),
    })).min(1),
  }),

  /** Customer portal password rules (SWR: the Bank's minimum character and length requirements). */
  password_policy: z.object({
    minLength: z.number().int().min(8).max(64),
    maxLength: z.number().int().min(16).max(256),
    requireUpper: z.boolean(),
    requireLower: z.boolean(),
    requireDigit: z.boolean(),
    requireSymbol: z.boolean(),
    disallowPersonalInfo: z.boolean().default(true),
    maxFailedAttempts: z.number().int().min(3).max(10).default(5),
    lockMinutes: z.number().int().min(5).max(1440).default(30),
    /** Days before the password must be changed (0 = no expiry). */
    maxAgeDays: z.number().int().min(0).max(3650).default(0),
    /** Number of previous passwords that cannot be reused (0 = no history check). */
    historyCount: z.number().int().min(0).max(24).default(0),
  }),

  /**
   * Session timeout (master prompt §: configurable by authorised administrators). Inactivity ends a session after
   * idleMinutes; a warning with "Stay signed in" appears warningSeconds before; no session outlives absoluteHours.
   * Background refreshes (notification counts, queue polling) never count as activity.
   */
  session_policy: z.object({
    idleMinutes: z.number().int().min(5).max(120),
    absoluteHours: z.number().int().min(1).max(24),
    warningSeconds: z.number().int().min(30).max(600),
  }).superRefine((v, ctx) => {
    if (v.warningSeconds >= v.idleMinutes * 60) ctx.addIssue({ code: 'custom', path: ['warningSeconds'], message: 'The warning must appear before the inactivity timeout.' });
    if (v.idleMinutes > v.absoluteHours * 60) ctx.addIssue({ code: 'custom', path: ['idleMinutes'], message: 'The inactivity timeout cannot be longer than the maximum session length.' });
  }),

  /**
   * Promoter identity verification policy (Credit360 §13). Which parties must be verified, with which
   * identifiers, how names and dates of birth are compared, and whether unverified promoters block submission.
   */
  identity_policy: z.object({
    requiredPartyTypes: z.array(z.enum(['SHAREHOLDER', 'DIRECTOR', 'PROMOTER', 'PRINCIPAL_OFFICER', 'BOARD_MEMBER', 'KEY_EXECUTIVE'])).min(1),
    shareholderMinOwnershipPct: z.number().min(0).max(100),
    requireBvn: z.boolean(),
    requireNin: z.boolean(),
    acceptPartialNameWhenDobMatches: z.boolean(),
    compareWithBankRecord: z.boolean(),
    blockSubmissionUntilVerified: z.boolean(),
    maxChecksPerPartyPerDay: z.number().int().min(1).max(20),
    reuseVerifiedWithinDays: z.number().int().min(0).max(730),
    consentWordingVersion: z.string().min(1).max(20),
    consentText: z.string().min(40).max(2000),
  }),

  committee: z.object({
    code,
    name: z.string(),
    memberRoles: z.array(roleCode).min(1),
    quorum: z.number().int().positive(),
    requiredApprovals: z.number().int().positive(),
    requiredRoles: z.array(roleCode).default([]),
    /** Minimum approving signatures per role, e.g. { NED: 3, ED: 2 }. */
    requiredRoleCounts: z.record(z.string(), z.number().int().positive()).default({}),
    voting: z.enum(['PARALLEL', 'SERIAL']),
    serialOrder: z.array(roleCode).default([]),
    /** A role (e.g. Credit Operations) permitted to record the decision taken at the committee meeting, citing the minutes. */
    recordedByRole: roleCode.optional(),
  }).refine((c) => c.requiredApprovals <= c.quorum, 'Required approvals cannot exceed quorum'),

  sla_policy: z.object({
    durationHours: z.number().positive().max(2000),
    calendar: z.enum(['BUSINESS', 'CALENDAR']),
    warnAtPct: z.number().min(1).max(99),
    pauseOnClarification: z.boolean().default(false),
    escalations: z.array(z.object({ afterBreachHours: z.number().nonnegative(), notifyRoles: z.array(roleCode).min(1), label: z.string() })).default([]),
  }),

  business_calendar: z.object({
    timezoneOffsetMinutes: z.number().int(),
    workdays: z.array(z.number().int().min(0).max(6)).min(1),
    startHour: z.number().int().min(0).max(23),
    endHour: z.number().int().min(1).max(24),
    holidays: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)),
  }).refine((c) => c.endHour > c.startHour, 'endHour must be after startHour'),

  notification_rule: z.object({
    event: z.string().regex(/^[A-Z_]+$/),
    audiences: z.array(z.string().regex(/^(ASSIGNEES|CUSTOMER|RM|BM|ACTOR|ROLE:[A-Z_]+)$/)).min(1),
    channels: z.array(z.enum(['IN_APP', 'EMAIL', 'SMS'])).min(1),
    title: z.string().max(140),
    body: z.string().max(1000),
    severity: z.enum(['INFO', 'ACTION', 'WARNING', 'CRITICAL']).default('INFO'),
  }),

  template: z.object({
    kind: z.enum(['OFFER_LETTER', 'TERM_SHEET', 'CREDIT_MEMO']),
    title: z.string(),
    sections: z.array(z.object({ heading: z.string(), body: z.string().max(8000) })).min(1),
  }),

  condition_template: z.object({
    appliesWhen: condition,
    items: z.array(z.object({ code, description: z.string(), category: z.enum(['PRECEDENT', 'SUBSEQUENT', 'COVENANT']), ownerTeam: z.enum(['LEGAL', 'SHARIAH', 'CREDIT_OPS', 'CUSTOMER', 'RM']), mandatory: z.boolean(), frequency: z.string().optional() })).min(1),
  }),

  legal_terms: z.object({ version: z.string(), termsText: z.string().min(50), privacyText: z.string().min(50) }),
} as const;

export type ConfigKind = keyof typeof schemas;
export const CONFIG_KINDS = Object.keys(schemas) as ConfigKind[];
export type Payload<K extends ConfigKind> = z.infer<(typeof schemas)[K]>;

export const KIND_LABEL: Record<ConfigKind, string> = {
  product: 'Facility products',
  document_requirement: 'Document requirements',
  fipg_rule: 'FIPG eligibility rules',
  financial_template: 'Financial statement template',
  ratio: 'Financial ratios',
  scorecard: 'Risk scorecards (ORR / industry / collateral)',
  rating_model: 'Combined rating model',
  collateral_type: 'Collateral types',
  policy_cash_backed: 'Cash-backed policy',
  sol_limit: 'Single Obligor & sector limits',
  es_trigger: 'E&S triggers',
  rarorac_threshold: 'RARORAC thresholds',
  workflow_definition: 'Workflow definitions',
  approval_authority: 'Approval authority matrix',
  committee: 'Committees',
  password_policy: 'Password policies',
  session_policy: 'Session timeout',
  identity_policy: 'Promoter identity verification',
  offer_signoff: 'Offer letter sign-off',
  facility_efficiency_ratio: 'Facility efficiency ratio',
  sla_policy: 'SLA policies',
  business_calendar: 'Business calendar',
  notification_rule: 'Notification rules',
  template: 'Document templates',
  condition_template: 'Condition templates',
  legal_terms: 'Terms & privacy notice',
};
