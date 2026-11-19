/** Organisation reference data (baseline, all environments). */
export const DIRECTORATES = [
  { code: 'CORP', name: 'Corporate & Institutional Banking' },
  { code: 'COMM', name: 'Commercial Banking' },
  { code: 'PUB', name: 'Public Sector' },
  { code: 'RISK', name: 'Risk Management' },
  { code: 'OPS', name: 'Operations' },
  { code: 'LEGAL', name: 'Legal & Company Secretariat' },
  { code: 'SHARIAH', name: 'Shariah Compliance' },
  { code: 'TECH', name: 'Technology' },
  { code: 'EXEC', name: 'Executive Office' },
];

export const BUSINESS_UNITS = [
  { code: 'LAG-CORP-1', name: 'Lagos Corporate 1', directorate: 'CORP' },
  { code: 'LAG-COMM-1', name: 'Lagos Commercial 1', directorate: 'COMM' },
  { code: 'ABJ-CORP-1', name: 'Abuja Corporate 1', directorate: 'CORP' },
  { code: 'KAN-COMM-1', name: 'Kano Commercial 1', directorate: 'COMM' },
  { code: 'CREDIT-RISK', name: 'Credit Risk Management', directorate: 'RISK' },
  { code: 'CREDIT-OPS', name: 'Credit Operations', directorate: 'OPS' },
  { code: 'LEGAL-SERV', name: 'Legal Services', directorate: 'LEGAL' },
  { code: 'SHARIAH-COMP', name: 'Shariah Compliance', directorate: 'SHARIAH' },
  { code: 'EXECUTIVE', name: 'Executive Office', directorate: 'EXEC' },
  { code: 'GAZELLE-ADMIN', name: 'Gazelle Administration', directorate: 'TECH' },
];

export const SECTORS = [
  { code: 'MANUFACTURING', name: 'Manufacturing' },
  { code: 'AGRICULTURE', name: 'Agriculture & Agro-allied' },
  { code: 'OIL_GAS', name: 'Oil & Gas' },
  { code: 'MINING', name: 'Mining & Quarrying' },
  { code: 'AVIATION', name: 'Aviation' },
  { code: 'HEALTHCARE', name: 'Healthcare' },
  { code: 'EDUCATION', name: 'Education' },
  { code: 'REAL_ESTATE', name: 'Real Estate & Construction' },
  { code: 'TRANSPORT', name: 'Transport & Logistics' },
  { code: 'TRADE', name: 'General Commerce & Trade' },
  { code: 'ICT', name: 'Information & Communication Technology' },
  { code: 'POWER', name: 'Power & Energy' },
  { code: 'HOSPITALITY', name: 'Hospitality' },
  { code: 'PUBLIC_SECTOR', name: 'Government & Public Sector' },
  { code: 'FINANCIAL_SERVICES', name: 'Non-interest Financial Services' },
  // Sectors excluded on Shariah grounds — present so that eligibility can decline them explicitly.
  { code: 'EXCLUDED_GAMBLING', name: 'Gambling & Betting (excluded)' },
  { code: 'EXCLUDED_ALCOHOL', name: 'Alcohol (excluded)' },
  { code: 'EXCLUDED_TOBACCO', name: 'Tobacco (excluded)' },
  { code: 'EXCLUDED_INTEREST_FINANCE', name: 'Interest-based finance (excluded)' },
  { code: 'EXCLUDED_ARMS', name: 'Arms & weapons (excluded)' },
];
