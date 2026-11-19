import { ROLE_LABEL } from '@gazelle/shared';
export function money(minor: number | null | undefined, ccy = 'NGN', opts: { compact?: boolean } = {}) {
  if (minor === null || minor === undefined || Number.isNaN(minor)) return '—';
  const major = minor / 100;
  const sym = ccy === 'NGN' ? '₦' : ccy === 'USD' ? '$' : `${ccy} `;
  if (opts.compact) {
    const a = Math.abs(major);
    const [d, s] = a >= 1e9 ? [1e9, 'bn'] : a >= 1e6 ? [1e6, 'm'] : a >= 1e3 ? [1e3, 'k'] : [1, ''];
    return `${major < 0 ? '-' : ''}${sym}${(a / d).toLocaleString('en-NG', { maximumFractionDigits: a >= d * 100 ? 0 : 1 })}${s}`;
  }
  return `${major < 0 ? '-' : ''}${sym}${Math.abs(major).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
export const toMinor = (major: string) => { const n = Number(String(major).replace(/[₦,\s]/g, '')); return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : null; };
export const majorInput = (minor?: number | null) => (minor ? (minor / 100).toLocaleString('en-NG', { maximumFractionDigits: 2 }) : '');
const TZ = 'Africa/Lagos';
export const date = (d?: string | Date | null) => (d ? new Date(d).toLocaleDateString('en-NG', { day: 'numeric', month: 'short', year: 'numeric', timeZone: TZ }) : '—');
export const dateTime = (d?: string | Date | null) => (d ? new Date(d).toLocaleString('en-NG', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: TZ }) : '—');
export const pct = (v?: number | null, dp = 1) => (v === null || v === undefined ? '—' : `${Number(v).toFixed(dp)}%`);
export const humanize = (s?: string | null) => (s ? s.replace(/_/g, ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase()) : '—');
export function duration(ms: number) {
  const neg = ms < 0; const a = Math.abs(ms);
  const h = Math.floor(a / 3600_000); const d = Math.floor(h / 24);
  const text = d >= 2 ? `${d}d ${h % 24}h` : h >= 1 ? `${h}h ${Math.floor((a % 3600_000) / 60_000)}m` : `${Math.max(1, Math.floor(a / 60_000))}m`;
  return neg ? `${text} overdue` : `${text} left`;
}
export const bytes = (n?: number) => (!n ? '—' : n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.ceil(n / 1024)} KB`);

export const roleLabel = (code?: string | null) => (code ? ROLE_LABEL[code] ?? humanize(code) : '—');
