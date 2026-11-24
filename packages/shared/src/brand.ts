/**
 * Product identity — the single source of truth for every customer- and staff-visible name.
 * Credit360 by AltBank (product owner direction, 24-Nov-2026). The former working name "Gazelle" survives only in
 * technical identifiers kept for compatibility (package names @gazelle/*, cookie and storage keys, reference
 * prefixes) and in historical records; see docs/credit360-gap-analysis.md.
 */
export const BRAND = {
  product: 'Credit360',
  endorsement: 'by AltBank',
  full: 'Credit360 by AltBank',
  bank: 'The Alternative Bank',
  bankLegal: 'The Alternative Bank Limited',
} as const;
