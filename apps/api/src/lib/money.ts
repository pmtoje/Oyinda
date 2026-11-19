/** Money is held as integer minor units (kobo / cents). */
export const toMinor = (major: number) => Math.round(major * 100);
export const toMajor = (minor: number) => minor / 100;

export function formatMoney(minor: number, currency = 'NGN'): string {
  const sym = currency === 'NGN' ? '₦' : currency === 'USD' ? '$' : `${currency} `;
  const sign = minor < 0 ? '-' : '';
  return `${sign}${sym}${(Math.abs(minor) / 100).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Multiply minor units by a rate using banker-safe rounding (half away from zero). */
export function convertMinor(minor: number, rate: number): number {
  const v = minor * rate;
  return v < 0 ? -Math.round(-v) : Math.round(v);
}
