import type { CbaCustomer, CbaExposureLine } from './types.js';

/**
 * DEMO / NON-PRODUCTION fixture for the mock core-banking adapter.
 * Fictitious businesses only. Never load real customer data in development.
 */
export const DEMO_CBA_CUSTOMERS: CbaCustomer[] = [
  {
    cbaCustomerId: 'DEMO-CIF-100001',
    customerType: 'CORPORATE',
    businessName: 'ABC Manufacturing Ltd',
    rcNumber: 'RC1234567',
    tin: '12345678-0001',
    incorporationDate: '2011-03-14',
    address: '14 Industrial Estate Road, Ikeja',
    city: 'Lagos',
    state: 'Lagos',
    registeredPhone: '08030000001',
    registeredEmail: 'treasury@abc-manufacturing.demo',
    relationshipManagerStaffNumber: 'DEMO-RM-01',
    businessUnitCode: 'LAG-CORP-1',
    customerSince: '2018-06-01',
    accounts: [
      { accountNumber: '0100000001', accountName: 'ABC MANUFACTURING LTD', currency: 'NGN', productName: 'Corporate Current Account', status: 'ACTIVE' },
      { accountNumber: '0100000002', accountName: 'ABC MANUFACTURING LTD - DOM', currency: 'USD', productName: 'Domiciliary Account', status: 'ACTIVE' },
    ],
  },
  {
    cbaCustomerId: 'DEMO-CIF-100002',
    customerType: 'CORPORATE',
    businessName: 'Kano Agro-Allied Processing Ltd',
    rcNumber: 'RC7654321',
    tin: '87654321-0001',
    incorporationDate: '2016-09-02',
    address: '7 Zoo Road',
    city: 'Kano',
    state: 'Kano',
    registeredPhone: '08030000002',
    registeredEmail: 'finance@kano-agro.demo',
    relationshipManagerStaffNumber: 'DEMO-RM-01',
    businessUnitCode: 'LAG-CORP-1',
    customerSince: '2021-01-15',
    accounts: [{ accountNumber: '0100000003', accountName: 'KANO AGRO-ALLIED PROCESSING LTD', currency: 'NGN', productName: 'Corporate Current Account', status: 'ACTIVE' }],
  },
  {
    cbaCustomerId: 'DEMO-CIF-100004',
    customerType: 'CORPORATE',
    businessName: 'Lagos Health Services Ltd',
    rcNumber: 'RC2468024',
    tin: '24680246-0001',
    incorporationDate: '2014-05-20',
    address: '3 Hospital Road, Yaba',
    city: 'Lagos',
    state: 'Lagos',
    registeredPhone: '08030000004',
    registeredEmail: 'admin@lagos-health.demo',
    relationshipManagerStaffNumber: 'DEMO-RM-01',
    businessUnitCode: 'LAG-COMM-1',
    customerSince: '2019-03-01',
    accounts: [{ accountNumber: '0100000005', accountName: 'LAGOS HEALTH SERVICES LTD', currency: 'NGN', productName: 'Corporate Current Account', status: 'ACTIVE' }],
  },
  {
    cbaCustomerId: 'DEMO-CIF-100003',
    customerType: 'INDIVIDUAL',
    businessName: 'Retail Individual',
    registeredPhone: '08030000003',
    accounts: [{ accountNumber: '0100000004', accountName: 'DEMO INDIVIDUAL', currency: 'NGN', productName: 'Savings', status: 'ACTIVE' }],
  },
];

export const DEMO_EXPOSURE: Record<string, { lines: CbaExposureLine[]; groupLines: CbaExposureLine[] }> = {
  'DEMO-CIF-100001': {
    lines: [
      { reference: 'DEMO-MUR-2025-0091', product: 'Murabaha (working capital)', kind: 'DIRECT', currency: 'NGN', approvedMinor: 250_000_000_00, outstandingMinor: 180_000_000_00, maturityDate: '2027-04-30', classification: 'PERFORMING' },
      { reference: 'DEMO-APG-2025-0014', product: 'Advance Payment Guarantee', kind: 'CONTINGENT', currency: 'NGN', approvedMinor: 60_000_000_00, outstandingMinor: 60_000_000_00, maturityDate: '2026-12-31', classification: 'PERFORMING' },
    ],
    groupLines: [
      { reference: 'DEMO-IJR-2024-0033', product: 'Ijarah (vehicles)', kind: 'DIRECT', currency: 'NGN', approvedMinor: 40_000_000_00, outstandingMinor: 22_500_000_00, maturityDate: '2027-02-28', classification: 'PERFORMING', relatedParty: 'ABC Logistics Ltd (DEMO)' },
    ],
  },
};

/**
 * SANDBOX identity registry — synthetic test identities only (no real people). Used by the sandbox BVN/NIN
 * adapter in non-production; every result it produces is recorded and shown as SANDBOX, never as a live check.
 *  - 2229 9999 999 / NIN 1009 9999 999 make the provider "unavailable" (outage testing).
 */
export const SANDBOX_IDENTITIES: { bvn?: string; nin?: string; fullName: string; dateOfBirth: string }[] = [
  { bvn: '22212345678', nin: '10012345678', fullName: 'Ade Johnson', dateOfBirth: '1974-03-18' },
  { bvn: '22287654321', nin: '10087654321', fullName: 'Hauwa Garba', dateOfBirth: '1981-11-02' },
  { bvn: '22211122233', nin: '10011122233', fullName: 'Ngozi Peters', dateOfBirth: '1986-06-25' },
  { bvn: '22233344455', nin: '10033344455', fullName: 'Kemi Adeyemi', dateOfBirth: '1979-09-09' },
  { bvn: '22255566677', nin: '10055566677', fullName: 'Bello Musa', dateOfBirth: '1968-01-30' },
  { bvn: '22266677788', nin: '10066677788', fullName: 'Tobiloba Ajayi', dateOfBirth: '1972-07-14' },
  // BVN and NIN records that disagree with each other (date of birth), for discrepancy testing
  { bvn: '22244455566', fullName: 'Ifeoma Chukwu', dateOfBirth: '1990-04-04' },
  { nin: '10044455566', fullName: 'Ifeoma Chukwu', dateOfBirth: '1991-04-04' },
];
export const SANDBOX_UNAVAILABLE = { bvn: '22299999999', nin: '10099999999' };
/** SANDBOX: people the (mock) core banking system already knows, keyed by BVN. */
export const DEMO_CBA_PEOPLE: { bvn: string; cbaCustomerId: string; fullName: string; dateOfBirth: string }[] = [
  { bvn: '22212345678', cbaCustomerId: 'CBA-IND-000101', fullName: 'Ade Johnson', dateOfBirth: '1974-03-18' },
  { bvn: '22255566677', cbaCustomerId: 'CBA-IND-000102', fullName: 'Bello Musa', dateOfBirth: '1968-02-28' }, // bank DOB differs
];
