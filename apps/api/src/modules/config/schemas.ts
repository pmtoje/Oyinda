import { z } from 'zod';
import { validateCondition, parseFormula, type Condition } from '@gazelle/shared';

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
    name: z.string().min(2),
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
    category: z.enum(['REAL_ESTATE', 'CASH', 'SECURITIES', 'GUARANTEE', 'CHARGE', 'NEGATIVE_PLEDGE', 'LEASED_ASSET', 'RECEIVABLES']),
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
    exceptionApproverRole: roleCode,
    justificationMinLength: z.number().int().min(20).max(2000),
  }),

  workflow_definition: z.object({
    kind: z.enum(['CREDIT_APPROVAL', 'FULFILMENT', 'NEGOTIATION_REVIEW']),
    appliesWhen: condition,
    priority: z.number().int(),
    stages: z.array(z.discriminatedUnion('type', [
      z.object({ type: z.literal('TASK'), key: code, name: z.string(), role: roleCode, taskType: z.enum(['REVIEW', 'ANALYSIS', 'FULFILMENT', 'CHECK']), when: condition.optional(), actions: z.array(z.enum(['RECOMMEND', 'DECLINE', 'RETURN', 'REQUEST_CLARIFICATION', 'COMMENT', 'COMPLETE'])).min(1), slaPolicyKey: z.string(), assignTo: z.enum(['ROLE_QUEUE', 'RELATIONSHIP_MANAGER', 'BRANCH_MANAGER']).default('ROLE_QUEUE'), returnTargets: z.array(z.enum(['CUSTOMER', 'RM', 'PREVIOUS'])).default(['PREVIOUS']) }),
      z.object({ type: z.literal('PARALLEL'), key: code, name: z.string(), branches: z.array(z.object({ key: code, name: z.string(), role: roleCode, taskType: z.enum(['REVIEW', 'ANALYSIS', 'FULFILMENT', 'CHECK']), when: condition.optional(), actions: z.array(z.enum(['RECOMMEND', 'DECLINE', 'RETURN', 'REQUEST_CLARIFICATION', 'COMMENT', 'COMPLETE'])).min(1), slaPolicyKey: z.string() })).min(2) }),
      z.object({ type: z.literal('APPROVAL_CHAIN'), key: code, name: z.string(), authorityKey: z.string() }),
    ])).min(1),
    declineBehaviour: z.enum(['TERMINATE', 'CONTINUE_TO_FINAL']).default('TERMINATE'),
    resumeAfterReturn: z.enum(['RETURNING_STAGE', 'START']).default('RETURNING_STAGE'),
  }),

  approval_authority: z.object({
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
    })).min(1),
    overrides: z.array(z.object({
      code,
      reason: z.string(),
      when: condition,
      finalLevel: z.string().optional(),
      minimumFinalLevel: z.string().optional(),
      addReviewRole: roleCode.optional(),
    })).default([]),
  }),

  committee: z.object({
    code,
    name: z.string(),
    memberRoles: z.array(roleCode).min(1),
    quorum: z.number().int().positive(),
    requiredApprovals: z.number().int().positive(),
    requiredRoles: z.array(roleCode).default([]),
    voting: z.enum(['PARALLEL', 'SERIAL']),
    serialOrder: z.array(roleCode).default([]),
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
  sla_policy: 'SLA policies',
  business_calendar: 'Business calendar',
  notification_rule: 'Notification rules',
  template: 'Document templates',
  condition_template: 'Condition templates',
  legal_terms: 'Terms & privacy notice',
};
