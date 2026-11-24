import type { ConfigKind } from '../modules/config/schemas.js';

const N = (naira: number) => naira * 100; // minor units
const always = { always: true } as const;
const field = (key: string, label: string, type: string, required = false, extra: Record<string, unknown> = {}) => ({ key, label, type, required, ...extra });

export interface BaselineItem { kind: ConfigKind; key: string; title: string; payload: unknown }

// ---------------------------------------------------------------------------
// Islamic banking products
// ---------------------------------------------------------------------------
const products: Omit<BaselineItem, 'kind'>[] = [
  { key: 'MURABAHA', title: 'Murabaha', payload: {
    code: 'MURABAHA', name: 'Murabaha', descriptor: 'Cost Plus Financing', family: 'MURABAHA', category: 'DIRECT',
    summary: 'Cost-plus sale. The Bank purchases the asset or inventory and sells it to the customer at an agreed profit, payable in instalments.',
    shariahStructure: 'The Bank acquires title to the asset (directly or through a Wakalah agent) before selling to the customer at cost plus a disclosed profit. The sale price is fixed at contract and cannot increase.',
    currencies: ['NGN', 'USD'], minAmountMinor: N(5_000_000), maxAmountMinor: N(20_000_000_000), minTenorMonths: 1, maxTenorMonths: 60,
    pricingBasis: 'PROFIT_RATE', indicativeProfitRatePct: 24, paymentFrequencies: ['MONTHLY', 'QUARTERLY', 'BULLET'],
    requiresSupplier: true, requiresAsset: true, requiresProject: false, customerSelectable: true,
    fields: [
      field('assetDescription', 'Goods or asset to be purchased', 'textarea', true, { maxLength: 1000 }),
      field('supplierQuoteRef', 'Supplier pro-forma invoice reference', 'text', true),
      field('assetCostMinor', 'Cost of goods (supplier price)', 'money', true),
      field('customerContributionMinor', 'Customer equity contribution', 'money', false, { help: 'Amount the customer will contribute towards the purchase, if any.' }),
      field('deliveryLocation', 'Delivery location', 'text', true),
      field('expectedDeliveryDate', 'Expected delivery date', 'date', false),
    ] } },
  { key: 'IJARAH', title: 'Ijarah', payload: {
    code: 'IJARAH', name: 'Ijarah', descriptor: 'Asset Financing', family: 'IJARAH', category: 'DIRECT',
    summary: 'Lease. The Bank owns the asset and leases it to the customer for an agreed rental. Ijarah Muntahia Bittamleek transfers ownership at the end.',
    shariahStructure: 'The Bank retains ownership and the risks of ownership (including Takaful) throughout the lease. Rentals are payable only for usufruct actually delivered.',
    currencies: ['NGN'], minAmountMinor: N(5_000_000), maxAmountMinor: N(10_000_000_000), minTenorMonths: 12, maxTenorMonths: 84,
    pricingBasis: 'RENTAL', indicativeProfitRatePct: 23, paymentFrequencies: ['MONTHLY', 'QUARTERLY'],
    requiresSupplier: true, requiresAsset: true, requiresProject: false, customerSelectable: true,
    fields: [
      field('assetType', 'Asset type', 'select', true, { options: [{ value: 'VEHICLES', label: 'Vehicles & fleet' }, { value: 'PLANT_MACHINERY', label: 'Plant & machinery' }, { value: 'EQUIPMENT', label: 'Equipment' }, { value: 'PROPERTY', label: 'Property' }] }),
      field('assetDescription', 'Asset description', 'textarea', true, { maxLength: 1000 }),
      field('assetCostMinor', 'Asset cost', 'money', true),
      field('ownershipTransfer', 'Ownership transfers to customer at end of lease (Ijarah Muntahia Bittamleek)', 'boolean', false),
      field('usefulLifeYears', 'Estimated useful life (years)', 'number', false, { min: 1, max: 50 }),
    ] } },
  { key: 'ISTISNA', title: 'Istisna', payload: {
    code: 'ISTISNA', name: 'Istisna', descriptor: 'Construction or Project Financing', family: 'ISTISNA', category: 'DIRECT',
    summary: 'Manufacturing or construction contract. The Bank commissions an asset to specification and sells it to the customer on completion.',
    shariahStructure: 'Specification, price and delivery date are fixed at contract. Payment may be staged against construction milestones. A parallel Istisna may be executed with the contractor.',
    currencies: ['NGN'], minAmountMinor: N(20_000_000), maxAmountMinor: N(20_000_000_000), minTenorMonths: 6, maxTenorMonths: 84,
    pricingBasis: 'PROFIT_RATE', indicativeProfitRatePct: 25, paymentFrequencies: ['QUARTERLY', 'SEMI_ANNUAL', 'BULLET'],
    requiresSupplier: true, requiresAsset: true, requiresProject: true, customerSelectable: true,
    fields: [
      field('projectName', 'Project name', 'text', true),
      field('specification', 'Asset specification', 'textarea', true, { maxLength: 2000 }),
      field('contractor', 'Contractor / manufacturer', 'text', true),
      field('projectCostMinor', 'Total project cost', 'money', true),
      field('completionDate', 'Expected completion date', 'date', true),
      field('milestones', 'Payment milestones', 'textarea', false, { maxLength: 2000 }),
    ] } },
  { key: 'SALAM', title: 'Salam', payload: {
    code: 'SALAM', name: 'Salam', family: 'SALAM', category: 'DIRECT',
    summary: 'Forward purchase. The Bank pays in full today for a commodity to be delivered at a specified future date.',
    shariahStructure: 'The price is paid in full at contract. Quantity, quality and delivery date of the commodity must be precisely specified. Usually combined with a parallel Salam or an agency to sell.',
    currencies: ['NGN'], minAmountMinor: N(10_000_000), maxAmountMinor: N(5_000_000_000), minTenorMonths: 1, maxTenorMonths: 12,
    pricingBasis: 'PROFIT_RATE', indicativeProfitRatePct: 24, paymentFrequencies: ['BULLET'],
    requiresSupplier: false, requiresAsset: true, requiresProject: false, customerSelectable: true,
    fields: [
      field('commodity', 'Commodity', 'text', true),
      field('quantity', 'Quantity and unit', 'text', true),
      field('qualitySpecification', 'Quality specification', 'textarea', true, { maxLength: 1000 }),
      field('deliveryDate', 'Delivery date', 'date', true),
    ] } },
  { key: 'QARD', title: 'Qard', payload: {
    code: 'QARD', name: 'Qard', descriptor: 'Benevolent Financing', family: 'QARD', category: 'DIRECT',
    summary: 'Benevolent facility with no profit. Only the principal is repaid; an actual-cost service charge may apply.',
    shariahStructure: 'No return may be charged on a Qard. Any administrative charge must reflect actual cost and cannot be linked to amount or tenor.',
    currencies: ['NGN'], minAmountMinor: N(1_000_000), maxAmountMinor: N(500_000_000), minTenorMonths: 1, maxTenorMonths: 24,
    pricingBasis: 'NONE', paymentFrequencies: ['MONTHLY', 'BULLET'],
    requiresSupplier: false, requiresAsset: false, requiresProject: false, customerSelectable: false,
    fields: [field('justification', 'Basis for Qard request', 'textarea', true, { maxLength: 1500 })] } },
  { key: 'MUSHARAKA', title: 'Musharaka', payload: {
    code: 'MUSHARAKA', name: 'Musharaka', descriptor: 'Partnership Investment Facility', family: 'MUSHARAKA', category: 'DIRECT',
    summary: 'Partnership. The Bank and customer contribute capital to a venture; profit is shared by agreed ratio and losses by capital contribution.',
    shariahStructure: 'Profit-sharing ratio is agreed upfront; losses follow capital contribution. In Diminishing Musharaka the customer progressively buys the Bank’s units.',
    currencies: ['NGN'], minAmountMinor: N(50_000_000), maxAmountMinor: N(20_000_000_000), minTenorMonths: 12, maxTenorMonths: 120,
    pricingBasis: 'PROFIT_SHARING_RATIO', indicativeProfitRatePct: 25, paymentFrequencies: ['QUARTERLY', 'SEMI_ANNUAL', 'ANNUAL'],
    requiresSupplier: false, requiresAsset: false, requiresProject: true, customerSelectable: true,
    fields: [
      field('ventureDescription', 'Venture description', 'textarea', true, { maxLength: 2000 }),
      field('customerCapitalMinor', 'Customer capital contribution', 'money', true),
      field('proposedBankProfitSharePct', 'Proposed Bank profit share (%)', 'number', true, { min: 1, max: 99 }),
      field('diminishing', 'Diminishing Musharaka (customer buys out Bank units)', 'boolean', false),
    ] } },
  { key: 'MUDARABA', title: 'Mudaraba', payload: {
    code: 'MUDARABA', name: 'Mudaraba', descriptor: 'Profit Sharing Investment', family: 'MUDARABA', category: 'INVESTMENT',
    summary: 'Investment partnership. The Bank provides capital (Rabb-ul-Maal); the customer provides management (Mudarib). Profit is shared by agreed ratio.',
    shariahStructure: 'Capital losses are borne by the capital provider unless caused by the Mudarib’s negligence or breach. The Mudarib cannot guarantee capital or profit.',
    currencies: ['NGN'], minAmountMinor: N(50_000_000), maxAmountMinor: N(10_000_000_000), minTenorMonths: 6, maxTenorMonths: 60,
    pricingBasis: 'PROFIT_SHARING_RATIO', indicativeProfitRatePct: 25, paymentFrequencies: ['QUARTERLY', 'SEMI_ANNUAL'],
    requiresSupplier: false, requiresAsset: false, requiresProject: true, customerSelectable: false,
    fields: [field('investmentPlan', 'Investment plan', 'textarea', true, { maxLength: 2000 }), field('proposedBankProfitSharePct', 'Proposed Bank profit share (%)', 'number', true, { min: 1, max: 99 })] } },
  { key: 'DIRECT_INVESTMENT', title: 'Direct Investment', payload: {
    code: 'DIRECT_INVESTMENT', name: 'Direct Investment', family: 'DIRECT_INVESTMENT', category: 'INVESTMENT',
    summary: 'Equity-type participation by the Bank in a Shariah-compliant business or project.',
    shariahStructure: 'Investee activities must pass Shariah screening. Returns depend on actual performance and cannot be guaranteed.',
    currencies: ['NGN'], minAmountMinor: N(100_000_000), maxAmountMinor: N(10_000_000_000), minTenorMonths: 12, maxTenorMonths: 120,
    pricingBasis: 'PROFIT_SHARING_RATIO', paymentFrequencies: ['ANNUAL', 'BULLET'],
    requiresSupplier: false, requiresAsset: false, requiresProject: true, customerSelectable: false,
    fields: [field('investmentThesis', 'Investment thesis', 'textarea', true, { maxLength: 3000 }), field('exitStrategy', 'Exit strategy', 'textarea', true, { maxLength: 1500 })] } },
  { key: 'COMMON_STOCK', title: 'Common Stock', payload: {
    code: 'COMMON_STOCK', name: 'Common Stock', descriptor: 'Shariah-screened equity', family: 'COMMON_STOCK', category: 'INVESTMENT',
    summary: 'Investment in ordinary shares of a Shariah-screened company.',
    shariahStructure: 'The company must pass business-activity and financial-ratio Shariah screens; any impure income is purified.',
    currencies: ['NGN'], minAmountMinor: N(50_000_000), maxAmountMinor: N(5_000_000_000), minTenorMonths: 12, maxTenorMonths: 120,
    pricingBasis: 'NONE', paymentFrequencies: ['BULLET'],
    requiresSupplier: false, requiresAsset: false, requiresProject: false, customerSelectable: false,
    fields: [field('issuer', 'Issuer', 'text', true), field('shareCount', 'Number of shares', 'number', true, { min: 1 })] } },
  { key: 'WAKALAH_BIL_ISTITHMAR', title: 'Wakalah Bil Istithmar', payload: {
    code: 'WAKALAH_BIL_ISTITHMAR', name: 'Wakalah Bil Istithmar', descriptor: 'Agency Investment Facility', family: 'WAKALAH_BIL_ISTITHMAR', category: 'INVESTMENT',
    summary: 'Investment agency. The customer invests the Bank’s funds as agent (Wakeel) for an agreed fee and an expected profit.',
    shariahStructure: 'The agent earns a fixed or percentage agency fee; profit above the expected rate may be retained by the agent as an incentive. Capital is not guaranteed except for negligence.',
    currencies: ['NGN', 'USD'], minAmountMinor: N(50_000_000), maxAmountMinor: N(20_000_000_000), minTenorMonths: 3, maxTenorMonths: 60,
    pricingBasis: 'PROFIT_RATE', indicativeProfitRatePct: 22, paymentFrequencies: ['MONTHLY', 'QUARTERLY', 'BULLET'],
    requiresSupplier: false, requiresAsset: false, requiresProject: true, customerSelectable: true,
    fields: [field('investmentActivity', 'Investment activity', 'textarea', true, { maxLength: 2000 }), field('agencyFeePct', 'Proposed agency fee (%)', 'number', false, { min: 0, max: 20 })] } },
];

const contingent = (code: string, name: string, type: string, summary: string): Omit<BaselineItem, 'kind'> => ({
  key: code, title: name, payload: {
    code, name, family: 'KAFALAH', category: 'CONTINGENT', contingentType: type, summary,
    shariahStructure: 'Issued under Kafalah. A fee reflecting actual service may be charged; no return is charged on the guaranteed amount. On invocation, any payment converts to a Shariah-compliant facility or Qard.',
    currencies: ['NGN', 'USD'], minAmountMinor: N(1_000_000), maxAmountMinor: N(20_000_000_000), minTenorMonths: 1, maxTenorMonths: 36,
    pricingBasis: 'FEE', indicativeProfitRatePct: 1.5, paymentFrequencies: ['BULLET'],
    requiresSupplier: false, requiresAsset: false, requiresProject: false, customerSelectable: true,
    fields: [
      field('beneficiary', 'Beneficiary', 'text', true),
      field('contractReference', 'Underlying contract / tender reference', 'text', true),
      field('contractValueMinor', 'Underlying contract value', 'money', true),
      field('expiryDate', 'Required expiry date', 'date', true),
      field('beneficiaryFormat', 'Beneficiary has a prescribed format', 'boolean', false),
    ] },
});
products.push(
  contingent('APG', 'Advance Payment Guarantee', 'APG', 'Guarantees the return of an advance payment made by the beneficiary to the customer under a contract.'),
  contingent('BANK_GUARANTEE', 'Bank Guarantee', 'BANK_GUARANTEE', 'General Kafalah guarantee issued in favour of a named beneficiary.'),
  contingent('BID_BOND', 'Bid Bond', 'BID_BOND', 'Supports the customer’s tender submission.'),
  contingent('PERFORMANCE_BOND', 'Performance Bond', 'PERFORMANCE_BOND', 'Guarantees the customer’s performance of contract obligations.'),
  contingent('CUSTOM_BOND', 'Customs Bond', 'CUSTOM_BOND', 'Guarantees duties payable to the Nigeria Customs Service.'),
  contingent('BAIL_BOND', 'Bail Bond', 'BAIL_BOND', 'Court-required bond issued on behalf of the customer.'),
);

// ---------------------------------------------------------------------------
// Document requirements
// ---------------------------------------------------------------------------
const PDF_IMG = ['application/pdf', 'image/png', 'image/jpeg'];
const REUSABLE = new Set(['CAC_CERTIFICATE', 'CAC_STATUS_REPORT', 'MEMART', 'DIRECTORS_ID', 'TAX_CLEARANCE']);
const docReq = (code: string, title: string, description: string, appliesWhen: unknown, mandatory: boolean, docType = code, stage = 'APPLICATION', validityDays?: number): BaselineItem => ({
  kind: 'document_requirement', key: code, title,
  payload: { code, title, description, docType, stage, appliesWhen, mandatory, customerVisible: true, acceptedMime: PDF_IMG, maxSizeMb: 20, reusable: REUSABLE.has(code), ...(validityDays ? { validityDays } : {}) },
});
const documents: BaselineItem[] = [
  docReq('CAC_CERTIFICATE', 'Certificate of Incorporation', 'Certificate of Incorporation issued by the Corporate Affairs Commission.', always, true),
  docReq('CAC_STATUS_REPORT', 'CAC Status Report', 'Current status report showing directors, shareholders and share capital (not older than 12 months).', always, true, 'CAC_STATUS_REPORT', 'APPLICATION', 365),
  docReq('MEMART', 'Memorandum & Articles of Association', 'Certified true copy of the Memorandum and Articles of Association.', always, true),
  docReq('BOARD_RESOLUTION', 'Board Resolution', 'Board resolution authorising the facility request and the signatories.', always, true),
  docReq('DIRECTORS_ID', 'Directors’ means of identification', 'Valid government-issued identification for each director and signatory.', always, true, 'DIRECTORS_ID', 'APPLICATION', 365 * 5),
  docReq('PROFORMA_INVOICE', 'Supplier pro-forma invoice', 'Pro-forma invoice from the supplier or vendor for the goods or asset.', { fact: 'facility.productFamily', op: 'in', value: ['MURABAHA', 'IJARAH', 'ISTISNA'] }, true),
  docReq('CONTRACT_AWARD', 'Contract award / tender document', 'Contract award letter, purchase order or tender document supporting the facility.', { fact: 'facility.category', op: 'eq', value: 'CONTINGENT' }, true),
  docReq('BENEFICIARY_FORMAT', 'Beneficiary’s guarantee format', 'Prescribed guarantee format from the beneficiary, where applicable.', { fact: 'facility.category', op: 'eq', value: 'CONTINGENT' }, false),
  docReq('FEASIBILITY_STUDY', 'Project feasibility study', 'Feasibility study or business plan for the project.', { all: [{ fact: 'facility.productFamily', op: 'in', value: ['ISTISNA', 'MUSHARAKA', 'MUDARABA', 'DIRECT_INVESTMENT'] }] }, true),
  docReq('CASH_FLOW_PROJECTION', 'Cash-flow projection', 'Projected cash flow covering the facility tenor.', { fact: 'facility.amountNgn', op: 'gte', value: 100_000_000 }, true),
  docReq('ES_IMPACT_ASSESSMENT', 'Environmental & Social impact assessment', 'EIA or E&S management plan for the project, where available.', { fact: 'risk.esRequired', op: 'truthy' }, false),
  docReq('TAX_CLEARANCE', 'Tax Clearance Certificate', 'Current Tax Clearance Certificate issued by FIRS.', always, true, 'TAX_CLEARANCE', 'APPLICATION', 365),
];

// ---------------------------------------------------------------------------
// FIPG eligibility rules
// ---------------------------------------------------------------------------
const fipg = (code: string, p: Record<string, unknown>): BaselineItem => ({ kind: 'fipg_rule', key: code, title: String(p.description), payload: { code, customerTypes: [], productCodes: [], sectorCodes: [], exceptionAllowed: false, appliesWhen: always, ...p } });
const fipgRules: BaselineItem[] = [
  fipg('FIPG_REGISTERED_ENTITY', { description: 'Business is registered with the Corporate Affairs Commission', passWhen: { fact: 'customer.hasRcNumber', op: 'truthy' }, requiredValue: 'RC / BN number on file', severity: 'BLOCKER', action: 'DECLINE', customerMessage: 'Your business registration (RC) number is required. Update your business profile.', internalMessage: 'No CAC registration number on the business profile.' }),
  fipg('FIPG_TAX_IDENTIFICATION', { description: 'Business has a Tax Identification Number', passWhen: { fact: 'customer.hasTin', op: 'truthy' }, requiredValue: 'TIN on file', severity: 'MAJOR', action: 'REFER', customerMessage: 'Your Tax Identification Number (TIN) is required. Update your business profile.', internalMessage: 'TIN missing from business profile.' }),
  fipg('FIPG_MIN_YEARS_IN_OPERATION', { description: 'Minimum years in operation', passWhen: { fact: 'customer.yearsInOperation', op: 'gte', value: 2 }, requiredValue: '≥ 2 years since incorporation', severity: 'MAJOR', action: 'EXCEPTION', exceptionAllowed: true, customerMessage: 'Your business does not yet meet the minimum operating history for this request. Your relationship manager will advise on the options available.', internalMessage: 'Business has operated for less than the 2-year minimum; requires an approved exception.' }),
  fipg('FIPG_SHARIAH_SECTOR_SCREEN', { description: 'Business activity passes Shariah sector screening', passWhen: { fact: 'customer.sector', op: 'nin', value: ['EXCLUDED_GAMBLING', 'EXCLUDED_ALCOHOL', 'EXCLUDED_TOBACCO', 'EXCLUDED_INTEREST_FINANCE', 'EXCLUDED_ARMS'] }, requiredValue: 'Sector not on the Shariah exclusion list', severity: 'BLOCKER', action: 'DECLINE', customerMessage: 'The Bank is unable to finance this business activity under its non-interest banking principles.', internalMessage: 'Customer sector is on the Shariah exclusion list.' }),
  fipg('FIPG_AUDITED_FINANCIALS', { description: 'Three years of audited financial statements for facilities above ₦50m', appliesWhen: { fact: 'facility.amountNgn', op: 'gt', value: 50_000_000 }, passWhen: { fact: 'customer.auditedYears', op: 'gte', value: 3 }, requiredValue: '3 audited financial years', severity: 'MAJOR', action: 'EXCEPTION', exceptionAllowed: true, customerMessage: 'Three years of audited financial statements are required for this facility amount.', internalMessage: 'Fewer than 3 audited years on file for a facility above ₦50m.' }),
  fipg('FIPG_PROFITABILITY', { description: 'Profitable in the latest financial year (direct facilities)', appliesWhen: { fact: 'facility.category', op: 'eq', value: 'DIRECT' }, passWhen: { fact: 'customer.latestPatNgn', op: 'gt', value: 0 }, requiredValue: 'Profit after tax > 0', severity: 'MAJOR', action: 'EXCEPTION', exceptionAllowed: true, customerMessage: 'Your latest financial statements will be reviewed in more detail by the credit team.', internalMessage: 'Loss-making in the latest financial year.' }),
  fipg('FIPG_CLEAN_BUREAU', { description: 'No delinquent facilities on credit bureau reports', appliesWhen: { fact: 'customer.hasDelinquentBureau', op: 'exists' }, passWhen: { fact: 'customer.hasDelinquentBureau', op: 'falsy' }, requiredValue: 'No delinquent records', severity: 'BLOCKER', action: 'REFER', customerMessage: 'Your credit history will be reviewed by the credit team.', internalMessage: 'Delinquent facility reported by a credit bureau.' }),
  fipg('FIPG_TURNOVER_COVER', { description: 'Annualised credit turnover covers the facility amount', appliesWhen: { fact: 'facility.category', op: 'eq', value: 'DIRECT' }, passWhen: { fact: 'facility.creditTurnoverCoverX', op: 'gte', value: 1.5 }, requiredValue: 'Annual credit turnover ≥ 1.5× facility amount', severity: 'MINOR', action: 'WARN', customerMessage: 'The facility amount is high relative to the turnover in your bank statements. The credit team may request further information.', internalMessage: 'Annualised credit turnover is below 1.5× the requested amount.' }),
  fipg('FIPG_BANK_RELATIONSHIP', { description: 'Minimum banking relationship with Alternative Bank', passWhen: { fact: 'customer.yearsWithBank', op: 'gte', value: 0.5 }, requiredValue: '≥ 6 months', severity: 'MINOR', action: 'WARN', customerMessage: 'Your relationship with the Bank is relatively new; your relationship manager may request additional information.', internalMessage: 'Banking relationship shorter than 6 months.' }),
];

// ---------------------------------------------------------------------------
// Financial template and ratios
// ---------------------------------------------------------------------------
const line = (code: string, label: string, section: string, isFlow: boolean, required: boolean, derived?: string) => ({ code, label, section, isFlow, required, ...(derived ? { derived } : {}) });
const financialTemplate: BaselineItem = { kind: 'financial_template', key: 'STANDARD', title: 'Standard corporate financial statement template', payload: { lines: [
  line('REVENUE', 'Revenue', 'INCOME_STATEMENT', true, true),
  line('COST_OF_SALES', 'Cost of sales', 'INCOME_STATEMENT', true, true),
  line('GROSS_PROFIT', 'Gross profit', 'INCOME_STATEMENT', true, false, 'REVENUE - COST_OF_SALES'),
  line('OPERATING_EXPENSES', 'Operating expenses (incl. depreciation)', 'INCOME_STATEMENT', true, true),
  line('DEPRECIATION', 'Depreciation & amortisation', 'INCOME_STATEMENT', true, false),
  line('OPERATING_PROFIT', 'Operating profit', 'INCOME_STATEMENT', true, false, 'GROSS_PROFIT - OPERATING_EXPENSES'),
  line('EBITDA', 'EBITDA', 'INCOME_STATEMENT', true, false, 'OPERATING_PROFIT + DEPRECIATION'),
  line('FINANCE_COST', 'Finance cost (cost of financing)', 'INCOME_STATEMENT', true, false),
  line('PROFIT_BEFORE_TAX', 'Profit before tax', 'INCOME_STATEMENT', true, true),
  line('TAX', 'Taxation', 'INCOME_STATEMENT', true, false),
  line('PROFIT_AFTER_TAX', 'Profit after tax', 'INCOME_STATEMENT', true, true),
  line('NON_CURRENT_ASSETS', 'Non-current assets', 'BALANCE_SHEET', false, true),
  line('INVENTORY', 'Inventory', 'BALANCE_SHEET', false, false),
  line('TRADE_RECEIVABLES', 'Trade receivables', 'BALANCE_SHEET', false, false),
  line('CASH', 'Cash & bank balances', 'BALANCE_SHEET', false, false),
  line('CURRENT_ASSETS', 'Current assets', 'BALANCE_SHEET', false, true),
  line('TOTAL_ASSETS', 'Total assets', 'BALANCE_SHEET', false, true),
  line('TRADE_PAYABLES', 'Trade payables', 'BALANCE_SHEET', false, false),
  line('SHORT_TERM_FINANCING', 'Short-term financing', 'BALANCE_SHEET', false, false),
  line('CURRENT_LIABILITIES', 'Current liabilities', 'BALANCE_SHEET', false, true),
  line('LONG_TERM_FINANCING', 'Long-term financing', 'BALANCE_SHEET', false, false),
  line('TOTAL_LIABILITIES', 'Total liabilities', 'BALANCE_SHEET', false, true),
  line('SHARE_CAPITAL', 'Share capital', 'BALANCE_SHEET', false, false),
  line('RETAINED_EARNINGS', 'Retained earnings', 'BALANCE_SHEET', false, false),
  line('TOTAL_EQUITY', 'Total equity (shareholders’ funds)', 'BALANCE_SHEET', false, true),
  line('TOTAL_FINANCING', 'Total financing (debt)', 'BALANCE_SHEET', false, false, 'SHORT_TERM_FINANCING + LONG_TERM_FINANCING'),
  line('WORKING_CAPITAL', 'Working capital', 'BALANCE_SHEET', false, false, 'CURRENT_ASSETS - CURRENT_LIABILITIES'),
  line('OPERATING_CASH_FLOW', 'Net cash from operating activities', 'CASH_FLOW', true, false),
  line('INVESTING_CASH_FLOW', 'Net cash from investing activities', 'CASH_FLOW', true, false),
  line('FINANCING_CASH_FLOW', 'Net cash from financing activities', 'CASH_FLOW', true, false),
] } };

const band = (min: number | undefined, max: number | undefined, score: number, label: string, implication: string) => ({ ...(min !== undefined ? { min } : {}), ...(max !== undefined ? { max } : {}), score, label, implication });
const ratio = (code: string, name: string, formula: string, unit: string, category: string, direction: string, weight: number, bands: unknown[]): BaselineItem => ({ kind: 'ratio', key: code, title: name, payload: { code, name, formula, unit, category, direction, weight, sectors: [], bands } });
const ratios: BaselineItem[] = [
  ratio('GROSS_MARGIN', 'Gross margin', 'GROSS_PROFIT / REVENUE * 100', '%', 'PROFITABILITY', 'HIGHER_BETTER', 8, [band(undefined, 10, 2, 'Weak', 'Thin gross margin leaves little room to absorb cost increases.'), band(10, 20, 5, 'Adequate', 'Gross margin is adequate.'), band(20, 35, 8, 'Strong', 'Healthy gross margin.'), band(35, undefined, 10, 'Very strong', 'Very strong pricing power.')]),
  ratio('EBITDA_MARGIN', 'EBITDA margin', 'EBITDA / REVENUE * 100', '%', 'PROFITABILITY', 'HIGHER_BETTER', 10, [band(undefined, 5, 1, 'Weak', 'Operating cash generation is weak.'), band(5, 12, 5, 'Adequate', 'Adequate operating cash generation.'), band(12, 20, 8, 'Strong', 'Strong operating cash generation.'), band(20, undefined, 10, 'Very strong', 'Very strong operating cash generation.')]),
  ratio('NET_MARGIN', 'Net profit margin', 'PROFIT_AFTER_TAX / REVENUE * 100', '%', 'PROFITABILITY', 'HIGHER_BETTER', 8, [band(undefined, 0, 0, 'Loss-making', 'Loss-making; capacity to service the facility from earnings is doubtful.'), band(0, 5, 4, 'Thin', 'Thin net margin.'), band(5, 10, 7, 'Adequate', 'Adequate net margin.'), band(10, undefined, 10, 'Strong', 'Strong net margin.')]),
  ratio('RETURN_ON_EQUITY', 'Return on equity', 'PROFIT_AFTER_TAX / TOTAL_EQUITY * 100', '%', 'PROFITABILITY', 'HIGHER_BETTER', 6, [band(undefined, 5, 2, 'Weak', 'Low return to shareholders.'), band(5, 15, 6, 'Adequate', 'Adequate return.'), band(15, undefined, 10, 'Strong', 'Strong return to shareholders.')]),
  ratio('CURRENT_RATIO', 'Current ratio', 'CURRENT_ASSETS / CURRENT_LIABILITIES', 'x', 'LIQUIDITY', 'HIGHER_BETTER', 12, [band(undefined, 1, 1, 'Weak', 'Current liabilities exceed current assets — short-term liquidity pressure.'), band(1, 1.2, 5, 'Tight', 'Liquidity is tight.'), band(1.2, 2, 8, 'Adequate', 'Adequate liquidity.'), band(2, undefined, 10, 'Strong', 'Strong liquidity.')]),
  ratio('QUICK_RATIO', 'Quick ratio', '(CURRENT_ASSETS - INVENTORY) / CURRENT_LIABILITIES', 'x', 'LIQUIDITY', 'HIGHER_BETTER', 6, [band(undefined, 0.5, 2, 'Weak', 'Heavy reliance on inventory to meet short-term obligations.'), band(0.5, 1, 6, 'Adequate', 'Adequate quick liquidity.'), band(1, undefined, 10, 'Strong', 'Strong quick liquidity.')]),
  ratio('LEVERAGE', 'Leverage (total liabilities / equity)', 'TOTAL_LIABILITIES / TOTAL_EQUITY', 'x', 'LEVERAGE', 'LOWER_BETTER', 14, [band(undefined, 1, 10, 'Low', 'Conservatively financed.'), band(1, 2, 7, 'Moderate', 'Moderate leverage.'), band(2, 3.5, 4, 'High', 'High leverage limits debt capacity.'), band(3.5, undefined, 1, 'Very high', 'Very high leverage — capital base is thin relative to obligations.')]),
  ratio('FINANCING_TO_EBITDA', 'Total financing / EBITDA', 'TOTAL_FINANCING / EBITDA', 'x', 'LEVERAGE', 'LOWER_BETTER', 12, [band(undefined, 2, 10, 'Low', 'Financing is well covered by earnings.'), band(2, 3.5, 7, 'Moderate', 'Moderate financing burden.'), band(3.5, 5, 3, 'High', 'High financing burden relative to earnings.'), band(5, undefined, 0, 'Excessive', 'Financing exceeds 5× EBITDA.')]),
  ratio('FINANCE_COST_COVER', 'Finance cost cover (EBITDA / finance cost)', 'EBITDA / FINANCE_COST', 'x', 'COVERAGE', 'HIGHER_BETTER', 12, [band(undefined, 1.5, 1, 'Weak', 'Earnings barely cover the cost of existing financing.'), band(1.5, 3, 5, 'Adequate', 'Adequate cover.'), band(3, 6, 8, 'Strong', 'Strong cover.'), band(6, undefined, 10, 'Very strong', 'Very strong cover.')]),
  ratio('DEBTOR_DAYS', 'Debtor days', 'TRADE_RECEIVABLES / REVENUE * 365', 'days', 'EFFICIENCY', 'LOWER_BETTER', 4, [band(undefined, 45, 10, 'Efficient', 'Efficient collection.'), band(45, 90, 6, 'Acceptable', 'Acceptable collection period.'), band(90, undefined, 2, 'Slow', 'Slow collection ties up working capital.')]),
  ratio('INVENTORY_DAYS', 'Inventory days', 'INVENTORY / COST_OF_SALES * 365', 'days', 'EFFICIENCY', 'LOWER_BETTER', 4, [band(undefined, 60, 10, 'Efficient', 'Efficient stock turnover.'), band(60, 120, 6, 'Acceptable', 'Acceptable stock holding.'), band(120, undefined, 2, 'Slow', 'Slow-moving inventory.')]),
  ratio('REVENUE_GROWTH', 'Revenue growth', '(REVENUE - PREV.REVENUE) / PREV.REVENUE * 100', '%', 'GROWTH', 'HIGHER_BETTER', 4, [band(undefined, -10, 1, 'Declining', 'Revenue is declining materially.'), band(-10, 5, 5, 'Flat', 'Revenue is broadly flat in real terms.'), band(5, 20, 8, 'Growing', 'Healthy revenue growth.'), band(20, undefined, 10, 'Strong growth', 'Strong revenue growth.')]),
];

// ---------------------------------------------------------------------------
// Risk scorecards and combined rating
// ---------------------------------------------------------------------------
const opts = (...o: [string, string, number][]) => o.map(([code, label, score]) => ({ code, label, score }));
const orr: BaselineItem = { kind: 'scorecard', key: 'ORR_STANDARD', title: 'Obligor Risk Rating — standard corporate', payload: {
  kind: 'ORR', name: 'Obligor Risk Rating — standard corporate', sectors: [],
  sections: [
    { code: 'MANAGEMENT', name: 'Management & ownership', weight: 25, questions: [
      { code: 'MGMT_EXPERIENCE', text: 'Experience of key management in this industry', options: opts(['LT5', 'Less than 5 years', 2], ['5_10', '5–10 years', 6], ['GT10', 'More than 10 years', 10]) },
      { code: 'MGMT_SUCCESSION', text: 'Succession planning and depth of management', options: opts(['NONE', 'Key-person dependent, no succession', 2], ['PARTIAL', 'Some second-line management', 6], ['STRONG', 'Established second line and succession plan', 10]) },
      { code: 'OWNERSHIP_SUPPORT', text: 'Shareholder support and commitment', options: opts(['WEAK', 'Limited shareholder capacity', 2], ['MODERATE', 'Shareholders able to support moderately', 6], ['STRONG', 'Strong, demonstrated shareholder support', 10]) },
    ] },
    { code: 'BUSINESS', name: 'Business & market position', weight: 25, questions: [
      { code: 'MARKET_POSITION', text: 'Market position', options: opts(['MARGINAL', 'Marginal player', 2], ['ESTABLISHED', 'Established competitor', 6], ['LEADER', 'Market leader / niche leader', 10]) },
      { code: 'CUSTOMER_CONCENTRATION', text: 'Customer concentration', options: opts(['HIGH', 'Top customer > 40% of revenue', 2], ['MEDIUM', 'Top customer 20–40% of revenue', 6], ['LOW', 'Well diversified customer base', 10]) },
      { code: 'SUPPLY_RISK', text: 'Supply chain and input availability', options: opts(['HIGH', 'Single-source or FX-dependent imports', 2], ['MEDIUM', 'Some concentration or FX exposure', 6], ['LOW', 'Diversified, local inputs', 10]) },
    ] },
    { code: 'RELATIONSHIP', name: 'Banking relationship & conduct', weight: 20, questions: [
      { code: 'ACCOUNT_CONDUCT', text: 'Account conduct with the Bank', options: opts(['POOR', 'Returned items / irregular conduct', 0], ['SATISFACTORY', 'Satisfactory', 6], ['EXCELLENT', 'Excellent, active account', 10]) },
      { code: 'PAYMENT_HISTORY', text: 'Payment history on existing facilities', options: opts(['DEFAULT', 'Past due or restructured', 0], ['NEW', 'No prior facility with the Bank', 5], ['GOOD', 'Always met obligations as they fell due', 10]) },
    ] },
    { code: 'GOVERNANCE', name: 'Governance & compliance', weight: 15, questions: [
      { code: 'FIN_REPORTING', text: 'Quality of financial reporting', options: opts(['WEAK', 'Unaudited or qualified opinion', 2], ['ADEQUATE', 'Audited by a mid-tier firm, unqualified', 7], ['STRONG', 'Audited by a reputable firm, unqualified', 10]) },
      { code: 'REGULATORY', text: 'Regulatory and tax compliance', options: opts(['ISSUES', 'Known compliance issues', 1], ['MINOR', 'Minor, resolved issues', 6], ['CLEAN', 'No known issues', 10]) },
    ] },
    { code: 'PURPOSE', name: 'Transaction structure', weight: 15, questions: [
      { code: 'SELF_LIQUIDATING', text: 'Is the transaction self-liquidating?', options: opts(['NO', 'Relies on general cash flow', 3], ['PARTLY', 'Partly self-liquidating', 6], ['YES', 'Self-liquidating with domiciled proceeds', 10]) },
      { code: 'CONTROL', text: 'Bank control over the underlying asset or cash flow', options: opts(['NONE', 'No control', 2], ['PARTIAL', 'Partial control', 6], ['FULL', 'Full control (title, domiciliation)', 10]) },
    ] },
  ],
  grades: [{ grade: 'ORR1', minScore: 80, description: 'Excellent' }, { grade: 'ORR2', minScore: 65, description: 'Good' }, { grade: 'ORR3', minScore: 50, description: 'Acceptable' }, { grade: 'ORR4', minScore: 35, description: 'Watch' }, { grade: 'ORR5', minScore: 0, description: 'Unacceptable' }],
} };
const industry: BaselineItem = { kind: 'scorecard', key: 'INDUSTRY_STANDARD', title: 'Industry analysis — standard', payload: {
  kind: 'INDUSTRY', name: 'Industry analysis — standard', sectors: [],
  sections: [{ code: 'INDUSTRY', name: 'Industry outlook', weight: 100, questions: [
    { code: 'OUTLOOK', text: 'Sector outlook over the facility tenor', options: opts(['NEGATIVE', 'Negative', 2], ['STABLE', 'Stable', 6], ['POSITIVE', 'Positive', 10]) },
    { code: 'FX_SENSITIVITY', text: 'Sensitivity to foreign exchange movements', options: opts(['HIGH', 'High', 2], ['MEDIUM', 'Medium', 6], ['LOW', 'Low', 10]) },
    { code: 'REGULATION', text: 'Regulatory and policy risk', options: opts(['HIGH', 'High', 2], ['MEDIUM', 'Medium', 6], ['LOW', 'Low', 10]) },
    { code: 'COMPETITION', text: 'Competitive intensity', options: opts(['INTENSE', 'Intense', 3], ['MODERATE', 'Moderate', 6], ['LOW', 'Low', 10]) },
  ] }],
  grades: [{ grade: 'IND-LOW', minScore: 70, description: 'Low industry risk' }, { grade: 'IND-MED', minScore: 45, description: 'Moderate industry risk' }, { grade: 'IND-HIGH', minScore: 0, description: 'High industry risk' }],
} };
const collateralCard: BaselineItem = { kind: 'scorecard', key: 'COLLATERAL_STANDARD', title: 'Collateral analysis — standard', payload: {
  kind: 'COLLATERAL', name: 'Collateral analysis — standard', sectors: [],
  sections: [{ code: 'COLLATERAL', name: 'Security quality', weight: 100, questions: [
    { code: 'COVERAGE', text: 'Eligible collateral coverage (system-computed; confirm)', guidance: 'Pre-selected from the collateral module. Change only with justification.', options: opts(['LT50', 'Below 50%', 1], ['50_100', '50%–99%', 4], ['100_150', '100%–149%', 7], ['GE150', '150% or more', 10]) },
    { code: 'LIQUIDITY', text: 'Ease of realisation', options: opts(['ILLIQUID', 'Illiquid / specialised', 2], ['MODERATE', 'Moderately liquid', 6], ['LIQUID', 'Cash or near-cash', 10]) },
    { code: 'PERFECTION', text: 'Perfection status', options: opts(['NOT_STARTED', 'Not started', 2], ['IN_PROGRESS', 'In progress', 5], ['PERFECTED', 'Perfected / will be perfected pre-disbursement', 10]) },
  ] }],
  grades: [{ grade: 'COL-STRONG', minScore: 70, description: 'Strong security' }, { grade: 'COL-ADEQUATE', minScore: 45, description: 'Adequate security' }, { grade: 'COL-WEAK', minScore: 0, description: 'Weak security' }],
} };
const ratingModel: BaselineItem = { kind: 'rating_model', key: 'COMBINED', title: 'Combined risk rating model', payload: {
  components: [{ kind: 'ORR', weight: 35 }, { kind: 'FRR', weight: 35 }, { kind: 'INDUSTRY', weight: 15 }, { kind: 'COLLATERAL', weight: 15 }],
  grades: [
    { grade: 'AAA', minScore: 85, description: 'Exceptional', riskLevel: 'LOW' }, { grade: 'AA', minScore: 78, description: 'Very strong', riskLevel: 'LOW' },
    { grade: 'A', minScore: 70, description: 'Strong', riskLevel: 'LOW' }, { grade: 'BBB', minScore: 62, description: 'Good', riskLevel: 'MODERATE' },
    { grade: 'BB', minScore: 54, description: 'Satisfactory', riskLevel: 'MODERATE' }, { grade: 'B', minScore: 45, description: 'Fair', riskLevel: 'ELEVATED' },
    { grade: 'CCC', minScore: 35, description: 'Weak', riskLevel: 'HIGH' }, { grade: 'C', minScore: 0, description: 'Unacceptable', riskLevel: 'UNACCEPTABLE' },
  ],
  frrGrades: [{ grade: 'FRR1', minScore: 80, description: 'Strong financial condition' }, { grade: 'FRR2', minScore: 65, description: 'Good' }, { grade: 'FRR3', minScore: 50, description: 'Acceptable' }, { grade: 'FRR4', minScore: 35, description: 'Weak' }, { grade: 'FRR5', minScore: 0, description: 'Very weak' }],
} };

// ---------------------------------------------------------------------------
// Collateral types and limits
// ---------------------------------------------------------------------------
const col = (code: string, name: string, category: string, haircut: number, cash: boolean, valuation: boolean, perfection: boolean, counts = true, validity?: number): BaselineItem => ({
  kind: 'collateral_type', key: code, title: name,
  payload: { code, name, category, defaultHaircutPct: haircut, cashEquivalent: cash, shariahCompliant: true, requiresValuation: valuation, requiresPerfection: perfection, countsTowardsCoverage: counts, ...(validity ? { valuationValidityMonths: validity } : {}) },
});
// SWR §4: collateral types aligned with Islamic banking principles and the Bank's FIPG (13 types).
const collateralTypes: BaselineItem[] = [
  col('LEGAL_MORTGAGE', 'Legal Mortgage', 'REAL_ESTATE', 30, false, true, true, true, 36),
  col('EQUITABLE_MORTGAGE', 'Equitable Mortgage', 'REAL_ESTATE', 40, false, true, true, true, 36),
  col('CASH_DEPOSIT', 'Cash deposit — unrestricted profit-sharing investment account or cash deposit with the Bank', 'CASH', 0, true, false, true),
  col('SUKUK', 'Sukuk (rated or unrated)', 'SECURITIES', 10, false, true, true, true, 3),
  col('SHARIAH_EQUITIES', 'Shariah-compliant equities and units in Islamic collective investment schemes', 'SECURITIES', 40, false, true, true, true, 1),
  col('QUOTED_BLUE_CHIP_SHARES', 'Share certificates of quoted blue-chip companies whose businesses are Shariah-compliant', 'SECURITIES', 35, false, true, true, true, 1),
  col('DEBENTURE', 'Debenture', 'CHARGE', 50, false, true, true, true, 24),
  col('BANKERS_ACCEPTANCE', 'Bankers’ Acceptance', 'INSTRUMENT', 10, false, false, true),
  col('KAFALAH', 'Guarantees (Kafalah)', 'GUARANTEE', 100, false, false, true, false),
  col('CHARGE_ON_ASSETS', 'Charge on assets (fixed and/or floating)', 'CHARGE', 50, false, true, true, true, 24),
  col('NEGATIVE_PLEDGE', 'Negative pledge', 'NEGATIVE_PLEDGE', 100, false, false, false, false),
  col('LEASED_ASSET', 'Leased asset (Bank title under Ijarah)', 'LEASED_ASSET', 30, false, true, false, true, 12),
  col('ASSIGNMENT_OF_RECEIVABLES', 'Assignment of receivables', 'RECEIVABLES', 40, false, false, true),
];


// ---------------------------------------------------------------------------
// Workflow, authority, committees, SLA
// ---------------------------------------------------------------------------
const reviewActions = ['RECOMMEND', 'DECLINE', 'RETURN', 'REQUEST_CLARIFICATION', 'COMMENT'];
// SWR §7 / PRD: a "not recommended" from the RM, the E&S analyst or the credit analyst is recorded and the request still moves on;
// a decline by the TL, RBE or DH ends the workflow.
const assessment = { type: 'PARALLEL', key: 'ASSESSMENT', name: 'Credit analysis & E&S review (concurrent)', branches: [
  { key: 'CREDIT_ANALYSIS', name: 'Credit analysis', role: 'CREDIT_ANALYST', taskType: 'ANALYSIS', actions: ['COMPLETE', 'DECLINE', 'RETURN', 'REQUEST_CLARIFICATION', 'COMMENT'], onDecline: 'CONTINUE', slaPolicyKey: 'CREDIT_ANALYSIS', prerequisites: ['BUREAU', 'EXPOSURE', 'FINANCIAL_ANALYSIS', 'STATEMENT_ANALYSIS', 'COLLATERAL', 'RISK_RATING', 'RARORAC', 'CREDIT_MEMO'] },
  { key: 'ES_REVIEW', name: 'E&S risk review', role: 'ES_ANALYST', taskType: 'ANALYSIS', when: { fact: 'risk.esRequired', op: 'truthy' }, actions: ['COMPLETE', 'DECLINE', 'REQUEST_CLARIFICATION', 'COMMENT'], onDecline: 'CONTINUE', slaPolicyKey: 'ES_REVIEW', prerequisites: ['ES_ASSESSMENT'] },
] };
const businessReview = [
  { type: 'TASK', key: 'BM_REVIEW', name: 'Team Lead review', role: 'BM', taskType: 'REVIEW', assignTo: 'RM_LINE_MANAGER', actions: reviewActions, slaPolicyKey: 'BM_REVIEW', returnTargets: ['PREVIOUS', 'RM', 'CUSTOMER'] },
  { type: 'TASK', key: 'RBE_REVIEW', name: 'Regional Business Executive review', role: 'RBE', taskType: 'REVIEW', actions: reviewActions, slaPolicyKey: 'RBE_REVIEW', returnTargets: ['PREVIOUS', 'RM'] },
  { type: 'TASK', key: 'DH_REVIEW', name: 'Divisional Head review', role: 'DH', taskType: 'REVIEW', actions: reviewActions, slaPolicyKey: 'DH_REVIEW', returnTargets: ['PREVIOUS', 'RM'] },
];
const creditTail = [
  assessment,
  { type: 'TASK', key: 'CTL_REVIEW', name: 'Team Lead, Credit Analysis review', role: 'CREDIT_TEAM_LEAD', taskType: 'REVIEW', actions: reviewActions, slaPolicyKey: 'CTL_REVIEW', returnTargets: ['PREVIOUS', 'RM'] },
  // GH Credit Risk (HCR) onwards: the authority matrix for the workflow type decides who approves.
  { type: 'APPROVAL_CHAIN', key: 'APPROVAL', name: 'Approval' },
];
const workflows: BaselineItem[] = [
  { kind: 'workflow_definition', key: 'CREDIT_CUSTOMER_INITIATED', title: 'Credit approval — customer-initiated', payload: {
    kind: 'CREDIT_APPROVAL', appliesWhen: { fact: 'facility.origin', op: 'eq', value: 'CUSTOMER' }, priority: 10,
    stages: [
      { type: 'TASK', key: 'RM_REVIEW', name: 'Relationship Manager review', role: 'RM', taskType: 'REVIEW', assignTo: 'RELATIONSHIP_MANAGER', actions: reviewActions, onDecline: 'CONTINUE', slaPolicyKey: 'RM_REVIEW', returnTargets: ['CUSTOMER'], prerequisites: ['DOCUMENTS_VERIFIED'] },
      ...businessReview,
      ...creditTail,
    ], declineBehaviour: 'TERMINATE', resumeAfterReturn: 'RETURNING_STAGE' } },
  { kind: 'workflow_definition', key: 'CREDIT_RM_INITIATED', title: 'Credit approval — RM-initiated', payload: {
    kind: 'CREDIT_APPROVAL', appliesWhen: { fact: 'facility.origin', op: 'eq', value: 'RM' }, priority: 10,
    stages: [
      { ...businessReview[0], returnTargets: ['RM'] },
      ...businessReview.slice(1),
      ...creditTail,
    ], declineBehaviour: 'TERMINATE', resumeAfterReturn: 'RETURNING_STAGE' } },
  { kind: 'workflow_definition', key: 'FULFILMENT_STANDARD', title: 'Post-approval review & documentation', payload: {
    kind: 'FULFILMENT', appliesWhen: always, priority: 10,
    stages: [
      { type: 'PARALLEL', key: 'DOCUMENTATION', name: 'Legal & Shariah documentation', branches: [
        { key: 'LEGAL', name: 'Legal documentation & perfection', role: 'LEGAL', taskType: 'FULFILMENT', actions: ['COMPLETE', 'REQUEST_CLARIFICATION', 'COMMENT'], slaPolicyKey: 'LEGAL_REVIEW', prerequisites: ['CONDITIONS_LEGAL'] },
        { key: 'SHARIAH', name: 'Shariah review & sign-off', role: 'SHARIAH', taskType: 'FULFILMENT', actions: ['COMPLETE', 'REQUEST_CLARIFICATION', 'COMMENT'], slaPolicyKey: 'SHARIAH_REVIEW', prerequisites: ['CONDITIONS_SHARIAH'] },
      ] },
      { type: 'TASK', key: 'CREDIT_OPS', name: 'Credit Operations — conditions & disbursement set-up', role: 'CREDIT_OPS', taskType: 'FULFILMENT', actions: ['COMPLETE', 'REQUEST_CLARIFICATION', 'COMMENT'], slaPolicyKey: 'CREDIT_OPS_REVIEW', prerequisites: ['CONDITIONS_ALL_MANDATORY'] },
    ], declineBehaviour: 'TERMINATE', resumeAfterReturn: 'RETURNING_STAGE' } },
];

// ---------------------------------------------------------------------------
// Approval authority — PRD approval grid per workflow type (approved line direct, cash-backed direct,
// cash-backed contingent, non-cash-backed contingent). Combination approvals are modelled as levels that
// join above an amount: e.g. "ED + CRO + HCR up to ₦150m" — the CRO joins above ₦100m, the ED above ₦50m.
// Order follows the SWR route: GH Credit Risk (HCR) – CRO – ED – MD – MIC – BRMC – Board.
// ---------------------------------------------------------------------------
const MAX = 9_000_000_000_000_000;
const lvl = (code: string, name: string, kind: 'INDIVIDUAL' | 'COMMITTEE', who: string, limit: number, above: number | null, extra: Record<string, unknown> = {}) => ({
  code, name, kind, ...(kind === 'INDIVIDUAL' ? { role: who } : { committeeKey: who }), limitMinor: limit,
  ...(above !== null ? { participatesAboveMinor: above } : {}), slaPolicyKey: kind === 'INDIVIDUAL' ? 'APPROVAL_INDIVIDUAL' : 'APPROVAL_COMMITTEE', ...extra,
});
/**
 * Combination limits (₦) from the PRD grid: hcr = HCR (with RBE/TL and DH) limit, above which the Line ED joins;
 * ed = ED + HCR limit, above which the CRO joins; cro = ED + CRO + HCR limit, above which a second ED and the MD join;
 * md = MD + CRO + HCR limit, above which MIC joins; mic = MIC limit (BRMC joins above); brmc = BRMC limit; board = Board joins above.
 * null: the level is reached only through an override (e.g. insider-related).
 */
const ladder = (t: { hcr: number; ed: number; cro: number; md: number; mic: number; brmc: number | null; board: number | null }) => [
  lvl('HCR', 'Group Head, Credit Risk (HCR)', 'INDIVIDUAL', 'GH_CREDIT_RISK', N(t.hcr), null),
  lvl('CRO', 'Chief Risk Officer', 'INDIVIDUAL', 'CRO', N(t.cro), N(t.ed), { canBeFinal: false }),
  lvl('ED', 'Line Executive Director', 'INDIVIDUAL', 'ED', N(t.cro), N(t.hcr)),
  lvl('ED_CONCURRENCE', 'Executive Director (concurrence)', 'INDIVIDUAL', 'ED', N(t.md), N(t.cro), { canBeFinal: false }),
  lvl('MD', 'Managing Director', 'INDIVIDUAL', 'MD', N(t.md), N(t.cro)),
  lvl('MIC', 'Management Investment Committee', 'COMMITTEE', 'MIC', t.brmc === null ? MAX : N(t.mic), N(t.md)),
  lvl('BRMC', 'Board Risk Management Committee', 'COMMITTEE', 'BRMC', t.board === null ? MAX : N(t.brmc ?? 0), t.brmc === null ? null : N(t.mic), t.brmc === null ? { overrideOnly: true } : {}),
  lvl('BOARD', 'Board of Directors', 'COMMITTEE', 'BOARD', MAX, t.board === null ? null : N(t.board), t.board === null ? { overrideOnly: true } : {}),
];
const overrides = [
  { code: 'INSIDER_RELATED', reason: 'Insider-related: final approval by the Board of Directors irrespective of amount (PRD).', when: { fact: 'customer.isInsider', op: 'truthy' }, finalLevel: 'BOARD', fullChain: true },
  { code: 'PEP', reason: 'A principal officer or promoter is a PEP: standard workflow irrespective of obligor rating, final approval by the Board (PRD).', when: { fact: 'customer.isPep', op: 'truthy' }, finalLevel: 'BOARD', fullChain: true },
  { code: 'SOL_BREACH', reason: 'Aggregate exposure above the Single Obligor Limit requires Board approval.', when: { fact: 'risk.solBreached', op: 'truthy' }, finalLevel: 'BOARD', fullChain: true },
  { code: 'PRICING_EXCEPTION', reason: 'RARORAC below threshold — pricing exception requires at least Line ED approval.', when: { fact: 'risk.raroracWithinThreshold', op: 'falsy' }, minimumFinalLevel: 'ED' },
];
const isContingent = { fact: 'facility.category', op: 'eq', value: 'CONTINGENT' };
const notContingent = { fact: 'facility.category', op: 'ne', value: 'CONTINGENT' };
const cashBacked = { fact: 'facility.isCashBacked', op: 'truthy' };
const notCashBacked = { not: cashBacked };
const standardLadder = { hcr: 50_000_000, ed: 100_000_000, cro: 150_000_000, md: 500_000_000, mic: 750_000_000, brmc: 1_500_000_000, board: 1_500_000_000 };
const cashLadder = { hcr: 1_000_000_000, ed: 1_500_000_000, cro: 2_000_000_000, md: 2_500_000_000, mic: 2_500_000_000, brmc: null, board: null };
const matrix = (key: string, title: string, workflowType: string, appliesWhen: unknown, priority: number, t: typeof standardLadder | typeof cashLadder): BaselineItem => ({
  kind: 'approval_authority', key, title, payload: { workflowType, appliesWhen, priority, amountBasis: 'AGGREGATE_EXPOSURE', levels: ladder(t as any), overrides },
});
const authorities: BaselineItem[] = [
  matrix('APPROVED_LINE_DIRECT', 'Approval authority — approved line / direct facilities', 'APPROVED_LINE_DIRECT', { all: [notContingent, notCashBacked] }, 10, standardLadder),
  matrix('CASH_BACKED_DIRECT', 'Approval authority — cash-backed direct facilities', 'CASH_BACKED_DIRECT', { all: [notContingent, cashBacked] }, 20, cashLadder),
  matrix('CASH_BACKED_CONTINGENT', 'Approval authority — cash-backed contingent facilities', 'CASH_BACKED_CONTINGENT', { all: [isContingent, cashBacked] }, 20, cashLadder),
  matrix('NON_CASH_BACKED_CONTINGENT', 'Approval authority — non-cash-backed contingent (issuance and release of funds)', 'NON_CASH_BACKED_CONTINGENT', { all: [isContingent, notCashBacked] }, 10, standardLadder),
];
const committees: BaselineItem[] = [
  // PRD: minimum signatures 3 NEDs + 2 EDs including the MD; Credit Operations may record the decision from the signed minutes.
  { kind: 'committee', key: 'MIC', title: 'Management Investment Committee', payload: { code: 'MIC', name: 'Management Investment Committee', memberRoles: ['MD', 'ED', 'NED'], quorum: 5, requiredApprovals: 5, requiredRoles: ['MD'], requiredRoleCounts: { NED: 3, 'ED|MD': 2 }, voting: 'PARALLEL', serialOrder: [], recordedByRole: 'CREDIT_OPS' } },
  // PRD: minimum signatures 1 Chairman + 2 NEDs. SWR names the committee BRMC (PRD: BCC).
  { kind: 'committee', key: 'BRMC', title: 'Board Risk Management Committee', payload: { code: 'BRMC', name: 'Board Risk Management Committee', memberRoles: ['BRMC_CHAIR', 'BRMC_MEMBER'], quorum: 3, requiredApprovals: 3, requiredRoles: ['BRMC_CHAIR'], requiredRoleCounts: { NED: 2 }, voting: 'PARALLEL', serialOrder: [], recordedByRole: 'CREDIT_OPS' } },
  // PRD: minimum signature — Board Chairman.
  { kind: 'committee', key: 'BOARD', title: 'Board of Directors', payload: { code: 'BOARD', name: 'Board of Directors', memberRoles: ['BOARD_CHAIR', 'BOARD_MEMBER'], quorum: 1, requiredApprovals: 1, requiredRoles: ['BOARD_CHAIR'], voting: 'PARALLEL', serialOrder: [], recordedByRole: 'CREDIT_OPS' } },
];
// PRD: escalation to the CRO after 2 days of breach and to EXCO (MD and EDs) after 5 days. Breach hours are elapsed hours.
const esc = [{ afterBreachHours: 48, notifyRoles: ['CRO'], label: 'Breach over 2 days — CRO' }, { afterBreachHours: 120, notifyRoles: ['MD', 'ED'], label: 'Breach over 5 days — EXCO' }];
const sla = (key: string, hours: number, title: string, calendar = 'BUSINESS'): BaselineItem => ({ kind: 'sla_policy', key, title, payload: { durationHours: hours, calendar, warnAtPct: 75, pauseOnClarification: false, escalations: esc } });
// SWR §7 timelines (business hours): RM 12h, TL 3h, RBE 3h, DH 3h, credit & E&S analysts 24h, TL credit analysis 12h,
// GH Credit Risk 12h, CRO/ED/MD/Board 48h, post-approval review & documentation 48h (Legal ∥ Shariah 24h, then Credit Ops 24h).
const slas: BaselineItem[] = [
  sla('RM_REVIEW', 12, 'RM review'), sla('BM_REVIEW', 3, 'Team Lead review'), sla('RBE_REVIEW', 3, 'RBE review'), sla('DH_REVIEW', 3, 'DH review'),
  sla('CREDIT_ANALYSIS', 24, 'Credit analysis'), sla('ES_REVIEW', 24, 'E&S review'), sla('CTL_REVIEW', 12, 'Team Lead, Credit Analysis review'), sla('GH_CR_REVIEW', 12, 'GH Credit Risk review'),
  sla('APPROVAL_INDIVIDUAL', 48, 'Individual approval'), sla('APPROVAL_COMMITTEE', 48, 'Committee approval'),
  sla('LEGAL_REVIEW', 24, 'Legal documentation'), sla('SHARIAH_REVIEW', 24, 'Shariah review'), sla('CREDIT_OPS_REVIEW', 24, 'Credit operations'),
  sla('OFFER_CHECK', 8, 'Offer letter check'), sla('NEGOTIATION_REVIEW', 16, 'Negotiation review'), sla('CUSTOMER_REWORK', 120, 'Customer rework', 'CALENDAR'),
];
const calendar: BaselineItem = { kind: 'business_calendar', key: 'NG_HEAD_OFFICE', title: 'Nigeria — head office business calendar', payload: {
  timezoneOffsetMinutes: 60, workdays: [1, 2, 3, 4, 5], startHour: 8, endHour: 17,
  // Moveable Islamic holidays are provisional until declared by the Federal Government; administrators must confirm each year.
  holidays: ['2026-01-01', '2026-03-20', '2026-04-03', '2026-04-06', '2026-05-01', '2026-05-27', '2026-05-28', '2026-06-12', '2026-08-26', '2026-10-01', '2026-12-25', '2026-12-28',
    '2027-01-01', '2027-03-10', '2027-03-26', '2027-03-29', '2027-05-17', '2027-06-14', '2027-08-16', '2027-10-01', '2027-12-27', '2027-12-28'],
} };

// ---------------------------------------------------------------------------
// Policies
// ---------------------------------------------------------------------------
const policies: BaselineItem[] = [
  // PRD: cash (incl. lien on APG cash proceeds) must be at least 110% of the facility amount in NGN. Treasury bills are excluded (see D-25).
  { kind: 'policy_cash_backed', key: 'STANDARD', title: 'Cash-backed classification', payload: { minCashCoveragePct: 110, eligibleTypeCodes: ['CASH_DEPOSIT'] } },
  { kind: 'sol_limit', key: 'STANDARD', title: 'Single Obligor Limit', payload: { singleObligorLimitMinor: N(5_000_000_000), basisDescription: 'DEFAULT — set to the CBN single-obligor percentage of the Bank’s shareholders’ funds as advised by Finance (to be confirmed).', contingentConversionPct: 50, sectorLimitsMinor: { MANUFACTURING: N(40_000_000_000), OIL_GAS: N(25_000_000_000), REAL_ESTATE: N(15_000_000_000) } } },
  // SWR §7 & §10: requests of ₦100m and above in HEART (Health, Education, Agriculture, Renewable Energy, Transport),
  // Oil & Gas, Mining and Aviation are routed for E&S review; questions follow the Bank's E&S Risk Checklist Form (IFC Performance Standards).
  { kind: 'es_trigger', key: 'STANDARD', title: 'E&S assessment trigger and checklist', payload: {
    description: 'E&S review is required for requests of ₦100m and above in the HEART sectors (Health, Education, Agriculture, Renewable Energy, Transport), Oil & Gas, Mining and Aviation.',
    triggerWhen: { all: [{ fact: 'facility.amountNgn', op: 'gte', value: 100_000_000 }, { fact: 'customer.sector', op: 'in', value: ['HEALTHCARE', 'EDUCATION', 'AGRICULTURE', 'RENEWABLE_ENERGY', 'TRANSPORT', 'OIL_GAS', 'MINING', 'AVIATION'] }] },
    questionnaire: [
      { code: 'PERMITS', text: 'Does the company have the relevant regulatory permits in place?', options: [{ code: 'YES', label: 'Yes', weight: 0 }, { code: 'NO', label: 'No', weight: 3 }, { code: 'NA', label: 'Not applicable', weight: 0 }] },
      { code: 'FIRE_SAFETY', text: 'Does the company have a fire safety certificate?', options: [{ code: 'YES', label: 'Yes', weight: 0 }, { code: 'NO', label: 'No', weight: 1 }, { code: 'NA', label: 'Not applicable', weight: 0 }] },
      { code: 'ESMS', text: 'Does the company have an Environmental and Social Management System or policy addressing all relevant E&S issues?', options: [{ code: 'YES', label: 'Yes', weight: 0 }, { code: 'NO', label: 'No', weight: 2 }, { code: 'NA', label: 'Not applicable', weight: 0 }] },
      { code: 'HSE_POLICY', text: 'Does the company have a Health, Safety and Environment (HSE) policy in line with industry or legislated standards?', options: [{ code: 'YES', label: 'Yes', weight: 0 }, { code: 'NO', label: 'No', weight: 2 }, { code: 'NA', label: 'Not applicable', weight: 0 }] },
      { code: 'DISCLOSURE', text: 'Does the company publicly disclose relevant E&S information to stakeholders?', options: [{ code: 'YES', label: 'Yes', weight: 0 }, { code: 'NO', label: 'No', weight: 1 }, { code: 'NA', label: 'Not applicable', weight: 0 }] },
      { code: 'INCIDENT_RECORDS', text: 'Does the company keep a detailed record of accidents and incidents?', options: [{ code: 'YES', label: 'Yes', weight: 0 }, { code: 'NO', label: 'No', weight: 1 }, { code: 'NA', label: 'Not applicable', weight: 0 }] },
      { code: 'CONTINGENCY_PLAN', text: 'Does the company have a contingency or disaster preparedness plan?', options: [{ code: 'YES', label: 'Yes', weight: 0 }, { code: 'NO', label: 'No', weight: 1 }, { code: 'NA', label: 'Not applicable', weight: 0 }] },
      { code: 'STAFF_TRAINING', text: 'Are employees trained on safety procedures, fire drills and emergency response?', options: [{ code: 'YES', label: 'Yes', weight: 0 }, { code: 'NO', label: 'No', weight: 1 }, { code: 'NA', label: 'Not applicable', weight: 0 }] },
      { code: 'SUPPLY_CHAIN', text: 'Does the company manage E&S issues with its primary suppliers, contractors and other third parties?', options: [{ code: 'YES', label: 'Yes', weight: 0 }, { code: 'NO', label: 'No', weight: 1 }, { code: 'NA', label: 'Not applicable', weight: 0 }] },
      { code: 'HSE_OFFICER', text: 'Does the company have a designated Health, Safety and Environment officer?', options: [{ code: 'YES', label: 'Yes', weight: 0 }, { code: 'NO', label: 'No', weight: 1 }, { code: 'NA', label: 'Not applicable', weight: 0 }] },
      { code: 'SOP', text: 'Does the company have documented standard operating procedures?', options: [{ code: 'YES', label: 'Yes', weight: 0 }, { code: 'NO', label: 'No', weight: 1 }, { code: 'NA', label: 'Not applicable', weight: 0 }] },
      { code: 'MEDIA_3Y', text: 'Has the company been subject to negative E&S media attention in the last 3 years?', options: [{ code: 'YES', label: 'Yes', weight: 2 }, { code: 'NO', label: 'No', weight: 0 }, { code: 'NA', label: 'Not applicable', weight: 0 }] },
      { code: 'FINES_3Y', text: 'Has the company incurred material E&S fines or penalties in the last 3 years?', options: [{ code: 'YES', label: 'Yes', weight: 3 }, { code: 'NO', label: 'No', weight: 0 }, { code: 'NA', label: 'Not applicable', weight: 0 }] },
      { code: 'CAMPAIGNS_3Y', text: 'Has the company faced NGO campaigns, lawsuits, strikes or protests on E&S issues in the last 3 years?', options: [{ code: 'YES', label: 'Yes', weight: 3 }, { code: 'NO', label: 'No', weight: 0 }, { code: 'NA', label: 'Not applicable', weight: 0 }] },
      { code: 'ESIA', text: 'Is there an Environmental and Social Impact Assessment or audit report for this project or request?', options: [{ code: 'YES', label: 'Yes', weight: 0 }, { code: 'NO', label: 'No', weight: 2 }, { code: 'NA', label: 'Not applicable', weight: 0 }] },
      { code: 'CLIMATE_PLAN', text: 'Does the company have climate mitigation or adaptation plans?', options: [{ code: 'YES', label: 'Yes', weight: 0 }, { code: 'NO', label: 'No', weight: 1 }, { code: 'NA', label: 'Not applicable', weight: 0 }] },
      { code: 'ADVERSE_ENVIRONMENT', text: 'Does the project adversely affect air, water or soil conditions of local communities or ecosystems?', options: [{ code: 'YES', label: 'Yes', weight: 3 }, { code: 'NO', label: 'No', weight: 0 }, { code: 'NA', label: 'Not applicable', weight: 0 }] },
      { code: 'WASTE_PLAN', text: 'Does the company have a waste management plan?', options: [{ code: 'YES', label: 'Yes', weight: 0 }, { code: 'NO', label: 'No', weight: 2 }, { code: 'NA', label: 'Not applicable', weight: 0 }] },
      { code: 'GHG_MEASURES', text: 'Does the company have measures to manage greenhouse gas emissions from its operations?', options: [{ code: 'YES', label: 'Yes', weight: 0 }, { code: 'NO', label: 'No', weight: 1 }, { code: 'NA', label: 'Not applicable', weight: 0 }] },
      { code: 'PROHIBITED_AGROCHEMICALS', text: 'Does the company use WHO class Ia or Ib pesticides or agrochemicals (prohibited)?', options: [{ code: 'YES', label: 'Yes', weight: 10 }, { code: 'NO', label: 'No', weight: 0 }, { code: 'NA', label: 'Not applicable', weight: 0 }] },
      { code: 'CHILD_FORCED_LABOUR', text: 'Does the company employ child or forced labour?', options: [{ code: 'YES', label: 'Yes', weight: 10 }, { code: 'NO', label: 'No', weight: 0 }, { code: 'NA', label: 'Not applicable', weight: 0 }] },
      { code: 'GRIEVANCE_MECHANISM', text: 'Does the company have a grievance mechanism for employees and communities?', options: [{ code: 'YES', label: 'Yes', weight: 0 }, { code: 'NO', label: 'No', weight: 2 }, { code: 'NA', label: 'Not applicable', weight: 0 }] },
      { code: 'GENDER_EQUALITY', text: 'Do labour and working conditions promote gender equality?', options: [{ code: 'YES', label: 'Yes', weight: 0 }, { code: 'NO', label: 'No', weight: 1 }, { code: 'NA', label: 'Not applicable', weight: 0 }] },
      { code: 'DISPLACEMENT', text: 'Does the project involve physical or economic displacement from land acquisition?', options: [{ code: 'YES', label: 'Yes', weight: 4 }, { code: 'NO', label: 'No', weight: 0 }, { code: 'NA', label: 'Not applicable', weight: 0 }] },
      { code: 'HABITATS', text: 'Does the project adversely affect natural habitats or ecosystem services?', options: [{ code: 'YES', label: 'Yes', weight: 3 }, { code: 'NO', label: 'No', weight: 0 }, { code: 'NA', label: 'Not applicable', weight: 0 }] },
      { code: 'DEFORESTATION_CUTOFF', text: 'Has the company disclosed a deforestation and land-conversion cut-off date of 1 January 2014?', options: [{ code: 'YES', label: 'Yes', weight: 0 }, { code: 'NO', label: 'No', weight: 1 }, { code: 'NA', label: 'Not applicable', weight: 0 }] },
      { code: 'ENDANGERED_SPECIES', text: 'Does the project affect endangered species, critical habitats or legally protected areas?', options: [{ code: 'YES', label: 'Yes', weight: 4 }, { code: 'NO', label: 'No', weight: 0 }, { code: 'NA', label: 'Not applicable', weight: 0 }] },
      { code: 'INDIGENOUS_PEOPLES', text: 'Does the project adversely affect Indigenous Peoples?', options: [{ code: 'YES', label: 'Yes', weight: 4 }, { code: 'NO', label: 'No', weight: 0 }, { code: 'NA', label: 'Not applicable', weight: 0 }] },
      { code: 'CULTURAL_HERITAGE', text: 'Does the project adversely affect tangible or intangible cultural heritage?', options: [{ code: 'YES', label: 'Yes', weight: 3 }, { code: 'NO', label: 'No', weight: 0 }, { code: 'NA', label: 'Not applicable', weight: 0 }] },
    ],
    categoryThresholds: { A: 12, B: 5 },
  } },
  // PRD: offer letters of ₦2m and below — Relationship Officer signs, Team Lead countersigns; above ₦2m — the account
  // officer (Relationship / Branch Manager) signs and the RBE or Group Head countersigns.
  { kind: 'offer_signoff', key: 'STANDARD', title: 'Offer letter sign-off', payload: { bands: [
    { maxAmountMinor: N(2_000_000), label: 'Relationship Officer + Team Lead countersign', signRoles: ['RM'], countersignRoles: ['BM'], signerMustBeAssignedRm: true },
    { maxAmountMinor: 9_000_000_000_000_000, label: 'Relationship / Branch Manager + RBE or Group Head countersign', signRoles: ['RM', 'BM'], countersignRoles: ['RBE', 'DH'], signerMustBeAssignedRm: true },
  ] } },
  // DEFAULT pending the Bank's Information Security password standard (OQ-21).
  // Interim staff sign-in (Credit360 password + authenticator) until AD authentication; DEFAULT pending the InfoSec standard (OQ-21).
  { kind: 'password_policy', key: 'STAFF_INTERIM', title: 'Staff password policy (interim, until Active Directory)', payload: { minLength: 14, maxLength: 128, requireUpper: true, requireLower: true, requireDigit: true, requireSymbol: true, disallowPersonalInfo: true, maxFailedAttempts: 5, lockMinutes: 30, maxAgeDays: 90, historyCount: 5 } },
  { kind: 'password_policy', key: 'CUSTOMER_PORTAL', title: 'Customer portal password policy', payload: { minLength: 12, maxLength: 128, requireUpper: true, requireLower: true, requireDigit: true, requireSymbol: true, disallowPersonalInfo: true, maxFailedAttempts: 5, lockMinutes: 30 } },
  // Session timeout — DEFAULT pending the Bank's Information Security standard (OQ-21); administrators change it with maker-checker.
  { kind: 'session_policy', key: 'CUSTOMER_PORTAL', title: 'Customer portal session timeout', payload: { idleMinutes: 15, absoluteHours: 8, warningSeconds: 120 } },
  { kind: 'session_policy', key: 'STAFF', title: 'Staff session timeout', payload: { idleMinutes: 15, absoluteHours: 10, warningSeconds: 120 } },
  { kind: 'rarorac_threshold', key: 'STANDARD', title: 'RARORAC pricing threshold', payload: { hurdlePct: 15, minProfitRatePct: 18, minFeePct: 1, exceptionApproverRole: 'GH_CREDIT_RISK', justificationMinLength: 50 } },
  { kind: 'legal_terms', key: 'CUSTOMER_PORTAL', title: 'Customer portal terms & privacy notice', payload: {
    version: '2026.1',
    termsText: 'These terms govern your use of Credit360 by AltBank. Information you submit is used to assess requests for non-interest (Islamic) financing facilities. Submitting a request does not constitute an offer or commitment by the Bank. Any facility is subject to credit approval, Shariah compliance, documentation and the conditions stated in an offer letter accepted by you. You confirm that the information you provide is true and complete and that you are authorised to act for the business.',
    privacyText: 'The Bank processes personal data of your directors, shareholders, signatories and contacts in line with the Nigeria Data Protection Act 2023. Data is used for credit assessment, regulatory reporting, credit bureau enquiries and fraud prevention, and is retained for the period required by law. You may request access to or correction of personal data by contacting the Bank’s Data Protection Officer.',
  } },
];

// ---------------------------------------------------------------------------
// Notifications and templates
// ---------------------------------------------------------------------------
const notif = (event: string, audiences: string[], title: string, body: string, severity = 'INFO', channels = ['IN_APP', 'EMAIL']): BaselineItem => ({ kind: 'notification_rule', key: event, title: event, payload: { event, audiences, channels, title, body, severity } });
const notifications: BaselineItem[] = [
  notif('APPLICATION_CREATED', ['RM'], 'New draft facility request', '{{customerName}} has started facility request {{facilityRef}} ({{productName}}).', 'INFO', ['IN_APP']),
  notif('APPLICATION_SUBMITTED', ['CUSTOMER', 'RM'], 'Facility request submitted', 'Facility request {{facilityRef}} for {{amount}} has been submitted and is under review.'),
  notif('TASK_ASSIGNED', ['ASSIGNEES'], 'Task assigned: {{stageName}}', '{{facilityRef}} — {{customerName}} ({{amount}}) is awaiting your {{stageName}}.{{summary}}', 'ACTION'),
  notif('TASK_REASSIGNED', ['ASSIGNEES'], 'Task reassigned to you: {{stageName}}', '{{facilityRef}} — {{customerName}} has been reassigned to you.', 'ACTION'),
  notif('SLA_WARNING', ['ASSIGNEES'], 'SLA approaching: {{stageName}}', '{{facilityRef}} is due by {{dueAt}}.', 'WARNING'),
  notif('SLA_BREACHED', ['ASSIGNEES', 'ROLE:CREDIT_TEAM_LEAD'], 'SLA breached: {{stageName}}', '{{facilityRef}} has exceeded the {{stageName}} SLA.', 'CRITICAL'),
  notif('SLA_ESCALATED', ['ASSIGNEES'], 'SLA escalation: {{stageName}}', '{{facilityRef}} has been escalated ({{escalation}}).', 'CRITICAL'),
  notif('APPLICATION_RETURNED', ['CUSTOMER', 'RM'], 'Action required: facility request returned', 'Facility request {{facilityRef}} has been returned for your attention. Open the request to see exactly what is needed.', 'ACTION'),
  notif('CLARIFICATION_REQUESTED', ['ASSIGNEES'], 'Clarification requested on {{facilityRef}}', '{{actorName}} has asked: {{subject}}', 'ACTION'),
  notif('CLARIFICATION_ANSWERED', ['ASSIGNEES'], 'Clarification answered on {{facilityRef}}', '{{actorName}} replied to "{{subject}}".'),
  notif('FACILITY_APPROVED', ['CUSTOMER', 'RM'], 'Facility approved', 'Facility request {{facilityRef}} has been approved. Your offer letter will follow.'),
  notif('FACILITY_DECLINED', ['CUSTOMER', 'RM'], 'Facility request outcome', 'Facility request {{facilityRef}} was not approved. Your relationship manager will contact you.', 'WARNING'),
  notif('OFFER_SIGNOFF_REQUIRED', ['RM', 'ROLE:BM', 'ROLE:RBE'], 'Offer letter ready for sign-off', 'The offer letter for {{facilityRef}} — {{customerName}} has passed its check and needs signing ({{rule}}).', 'ACTION'),
  notif('OFFER_ISSUED', ['CUSTOMER', 'RM'], 'Offer letter ready', 'The offer letter for {{facilityRef}} is ready for your review and response.', 'ACTION'),
  notif('OFFER_ACCEPTED', ['RM', 'ROLE:CREDIT_OPS', 'ROLE:LEGAL', 'ROLE:SHARIAH'], 'Offer accepted', '{{customerName}} has accepted the offer for {{facilityRef}}.'),
  notif('OFFER_REJECTED', ['RM'], 'Offer rejected', '{{customerName}} has rejected the offer for {{facilityRef}}.', 'WARNING'),
  notif('OFFER_NEGOTIATION', ['RM', 'ROLE:GH_CREDIT_RISK'], 'Negotiation requested', '{{customerName}} has requested changes to the offer for {{facilityRef}}.', 'ACTION'),
  notif('DOCUMENTATION_PENDING', ['CUSTOMER'], 'Documents required', 'Conditions on {{facilityRef}} need documents from you.', 'ACTION'),
  notif('FACILITY_READY', ['ROLE:CREDIT_OPS', 'RM'], 'Facility ready for activation', 'All mandatory conditions on {{facilityRef}} are satisfied.', 'ACTION'),
  notif('FACILITY_ACTIVATED', ['CUSTOMER', 'RM'], 'Facility activated', 'Facility {{facilityRef}} is now active.'),
  notif('DISBURSEMENT_POSTED', ['CUSTOMER', 'RM'], 'Disbursement completed', '{{amount}} has been disbursed under {{facilityRef}}.'),
  notif('MONITORING_ALERT', ['RM'], 'Monitoring alert on {{facilityRef}}', '{{detail}}', 'WARNING'),
];
const templates: BaselineItem[] = [
  { kind: 'template', key: 'OFFER_LETTER_STANDARD', title: 'Offer letter — standard', payload: { kind: 'OFFER_LETTER', title: 'Offer of {{terms.productName}} Facility', sections: [
    { heading: 'Introduction', body: 'We are pleased to inform {{customer.name}} ("the Customer") that Alternative Bank Limited ("the Bank") has approved the facility described below ({{terms.productName}}), on the terms and conditions set out in this letter.' },
    { heading: 'Facility', body: 'Facility type: {{terms.productName}}\nFacility reference: {{facility.ref}}\nFacility amount: {{terms.amount}}\nTenor: {{terms.tenor}}\nPurpose: {{facility.purpose}}' },
    { heading: 'Pricing', body: '{{terms.pricingText}}\nManagement fee: {{terms.managementFee}}' },
    { heading: 'Payment', body: 'Payment frequency: {{terms.paymentFrequency}}\nMoratorium: {{terms.moratorium}}\nSource of payment: {{facility.sourceOfPayment}}' },
    { heading: 'Security', body: '{{terms.security}}' },
    { heading: 'Conditions precedent to drawdown', body: '{{terms.conditionsPrecedent}}' },
    { heading: 'Other conditions and covenants', body: '{{terms.otherConditions}}' },
    { heading: 'Shariah compliance', body: 'This facility is structured in accordance with the principles of non-interest banking and has been reviewed by the Bank’s Shariah compliance function. The Bank will not charge or accept any return that is not permissible under the approved structure.' },
    { heading: 'Acceptance', body: 'This offer is valid for 30 days from {{date}}. To accept, respond through Credit360. Acceptance is subject to the conditions precedent above being satisfied before any drawdown.' },
  ] } },
];
const conditionTemplates: BaselineItem[] = [
  { kind: 'condition_template', key: 'STANDARD', title: 'Standard conditions', payload: { appliesWhen: always, items: [
    { code: 'BOARD_RESOLUTION_FACILITY', description: 'Board resolution of the Customer accepting the facility and authorising signatories', category: 'PRECEDENT', ownerTeam: 'LEGAL', mandatory: true },
    { code: 'FACILITY_AGREEMENT', description: 'Execution of the facility agreement and all transaction documents', category: 'PRECEDENT', ownerTeam: 'LEGAL', mandatory: true },
    { code: 'SHARIAH_SIGN_OFF', description: 'Shariah compliance sign-off on the executed transaction documents', category: 'PRECEDENT', ownerTeam: 'SHARIAH', mandatory: true },
    { code: 'KYC_REFRESH', description: 'KYC documentation current and verified', category: 'PRECEDENT', ownerTeam: 'CREDIT_OPS', mandatory: true },
    { code: 'SECURITY_PERFECTION', description: 'Perfection of all security interests stated in the offer', category: 'PRECEDENT', ownerTeam: 'LEGAL', mandatory: true },
    { code: 'AUDITED_FS_ANNUAL', description: 'Submit audited financial statements within 6 months of financial year end', category: 'COVENANT', ownerTeam: 'CUSTOMER', mandatory: true, frequency: 'ANNUAL' },
    { code: 'DOMICILIATION', description: 'Domiciliation of contract proceeds to the Customer’s Alternative Bank account', category: 'SUBSEQUENT', ownerTeam: 'CREDIT_OPS', mandatory: false },
  ] } },
  { kind: 'condition_template', key: 'MURABAHA', title: 'Murabaha conditions', payload: { appliesWhen: { fact: 'facility.productFamily', op: 'eq', value: 'MURABAHA' }, items: [
    { code: 'WAKALAH_AGREEMENT', description: 'Execution of Wakalah (agency) agreement for purchase of goods', category: 'PRECEDENT', ownerTeam: 'LEGAL', mandatory: true },
    { code: 'BANK_TITLE_EVIDENCE', description: 'Evidence of the Bank’s ownership of the goods before sale to the Customer', category: 'PRECEDENT', ownerTeam: 'SHARIAH', mandatory: true },
    { code: 'SUPPLIER_INVOICE', description: 'Supplier invoice issued in the Bank’s name', category: 'PRECEDENT', ownerTeam: 'CREDIT_OPS', mandatory: true },
  ] } },
  { kind: 'condition_template', key: 'IJARAH', title: 'Ijarah conditions', payload: { appliesWhen: { fact: 'facility.productFamily', op: 'eq', value: 'IJARAH' }, items: [
    { code: 'LEASE_AGREEMENT', description: 'Execution of the Ijarah agreement', category: 'PRECEDENT', ownerTeam: 'LEGAL', mandatory: true },
    { code: 'TAKAFUL_COVER', description: 'Comprehensive Takaful cover on the leased asset with the Bank noted as owner', category: 'PRECEDENT', ownerTeam: 'CREDIT_OPS', mandatory: true },
  ] } },
  { kind: 'condition_template', key: 'CONTINGENT', title: 'Contingent facility conditions', payload: { appliesWhen: { fact: 'facility.category', op: 'eq', value: 'CONTINGENT' }, items: [
    { code: 'COUNTER_INDEMNITY', description: 'Executed counter-indemnity in favour of the Bank', category: 'PRECEDENT', ownerTeam: 'LEGAL', mandatory: true },
    { code: 'BENEFICIARY_FORMAT_APPROVED', description: 'Beneficiary’s format reviewed and approved by Legal', category: 'PRECEDENT', ownerTeam: 'LEGAL', mandatory: false },
  ] } },
  { kind: 'condition_template', key: 'CASH_BACKED', title: 'Cash-backed conditions', payload: { appliesWhen: { fact: 'facility.isCashBacked', op: 'truthy' }, items: [
    { code: 'LIEN_ON_DEPOSIT', description: 'Lien placed on the cash deposit for the facility amount', category: 'PRECEDENT', ownerTeam: 'CREDIT_OPS', mandatory: true },
  ] } },
];

export const BASELINE: BaselineItem[] = [
  ...products.map((p) => ({ ...p, kind: 'product' as ConfigKind })),
  ...documents, ...fipgRules, financialTemplate, ...ratios, orr, industry, collateralCard, ratingModel, ...collateralTypes,
  ...workflows, ...authorities, ...committees, ...slas, calendar, ...policies, ...notifications, ...templates, ...conditionTemplates,
];

/** Current baseline revision. Bump when the baseline changes so existing environments are reconciled. */
export const BASELINE_RELEASE = '2026.11-SWR.4';
/** Keys removed from the baseline (SWR §4 collateral clean-up; authority matrices split by workflow type; BCC renamed BRMC). */
export const BASELINE_RETIRED: { kind: ConfigKind; key: string }[] = [
  { kind: 'collateral_type', key: 'ISLAMIC_CIS' },
  { kind: 'collateral_type', key: 'QUALIFYING_SHARES' },
  { kind: 'collateral_type', key: 'KAFALAH_BANK' },
  { kind: 'collateral_type', key: 'KAFALAH_CORPORATE' },
  { kind: 'approval_authority', key: 'STANDARD' },
  { kind: 'committee', key: 'BCC' },
];
