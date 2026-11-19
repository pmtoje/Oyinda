import { formatMoney } from '../../lib/money.js';

export interface Issue { step: string; field: string; message: string }

/** Validate a facility request against its (frozen) product configuration. Pure function. */
export function validateFacility(product: any, f: any): Issue[] {
  const issues: Issue[] = [];
  const add = (step: string, field: string, message: string) => issues.push({ step, field, message });
  if (!f.amount_minor) add('DETAILS', 'amountMinor', 'Enter the facility amount.');
  else {
    if (f.amount_minor < product.minAmountMinor) add('DETAILS', 'amountMinor', `The minimum for ${product.name} is ${formatMoney(product.minAmountMinor, f.currency)}.`);
    if (f.amount_minor > product.maxAmountMinor) add('DETAILS', 'amountMinor', `The maximum for ${product.name} is ${formatMoney(product.maxAmountMinor, f.currency)}.`);
  }
  if (!product.currencies.includes(f.currency)) add('DETAILS', 'currency', `${product.name} is available in ${product.currencies.join(', ')}.`);
  if (!f.tenor_months) add('DETAILS', 'tenorMonths', 'Enter the tenor.');
  else if (f.tenor_months < product.minTenorMonths || f.tenor_months > product.maxTenorMonths) add('DETAILS', 'tenorMonths', `Tenor must be between ${product.minTenorMonths} and ${product.maxTenorMonths} months.`);
  if (!f.purpose || f.purpose.trim().length < 10) add('DETAILS', 'purpose', 'Describe the purpose of the facility (at least 10 characters).');
  if (!f.payment_frequency) add('DETAILS', 'paymentFrequency', 'Select a payment frequency.');
  else if (!product.paymentFrequencies.includes(f.payment_frequency)) add('DETAILS', 'paymentFrequency', 'This payment frequency is not available for the selected product.');
  if (product.category !== 'CONTINGENT' && (!f.source_of_payment || f.source_of_payment.trim().length < 10)) add('DETAILS', 'sourceOfPayment', 'Describe the source of payment.');
  if (product.requiresSupplier && !f.supplier_name) add('PRODUCT_INFO', 'supplierName', 'Enter the supplier or vendor.');
  if (product.requiresAsset && !f.underlying_asset) add('PRODUCT_INFO', 'underlyingAsset', 'Describe the underlying asset.');
  if (product.requiresProject && !f.project_details) add('PRODUCT_INFO', 'projectDetails', 'Provide the project details.');
  const pf = f.product_fields ?? {};
  for (const fld of product.fields) {
    const v = pf[fld.key];
    const empty = v === undefined || v === null || v === '';
    if (fld.required && empty && fld.type !== 'boolean') { add('PRODUCT_INFO', fld.key, `${fld.label} is required.`); continue; }
    if (empty) continue;
    if ((fld.type === 'number' || fld.type === 'money') && (typeof v !== 'number' || !Number.isFinite(v))) add('PRODUCT_INFO', fld.key, `${fld.label} must be a number.`);
    else if (fld.type === 'money' && (!Number.isInteger(v) || v < 0)) add('PRODUCT_INFO', fld.key, `${fld.label} must be a positive amount.`);
    else if (typeof v === 'number' && ((fld.min !== undefined && v < fld.min) || (fld.max !== undefined && v > fld.max))) add('PRODUCT_INFO', fld.key, `${fld.label} must be between ${fld.min ?? '−∞'} and ${fld.max ?? '∞'}.`);
    if (fld.type === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(String(v))) add('PRODUCT_INFO', fld.key, `${fld.label} must be a date.`);
    if (fld.type === 'select' && !fld.options?.some((o: any) => o.value === v)) add('PRODUCT_INFO', fld.key, `Select a valid ${fld.label.toLowerCase()}.`);
    if (fld.type === 'boolean' && typeof v !== 'boolean') add('PRODUCT_INFO', fld.key, `${fld.label} must be yes or no.`);
    if ((fld.type === 'text' || fld.type === 'textarea') && (typeof v !== 'string' || v.length > (fld.maxLength ?? 500))) add('PRODUCT_INFO', fld.key, `${fld.label} is too long.`);
  }
  for (const k of Object.keys(pf)) if (!product.fields.some((x: any) => x.key === k)) add('PRODUCT_INFO', k, 'Unknown field for this product.');
  if (!f.proposed_security && product.category !== 'INVESTMENT') add('SECURITY', 'proposedSecurity', 'Describe the security you propose to offer.');
  return issues;
}
