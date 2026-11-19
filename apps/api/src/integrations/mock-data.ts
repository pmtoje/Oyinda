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
