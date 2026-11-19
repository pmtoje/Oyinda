/** Masking helpers — show only what a user needs. */
export const maskTail = (v: string | null | undefined, visible = 4, ch = '•') =>
  !v ? '' : v.length <= visible ? ch.repeat(v.length) : ch.repeat(Math.max(0, v.length - visible)) + v.slice(-visible);

export const maskAccount = (v: string | null | undefined) => (v ? `${'•'.repeat(6)}${v.slice(-4)}` : '');
export const maskBvn = (last4: string | null | undefined) => (last4 ? `•••••••${last4}` : '');
export const maskPhone = (v: string | null | undefined) => {
  if (!v) return '';
  const d = v.replace(/\D/g, '');
  return d.length < 7 ? maskTail(d, 2) : `${d.slice(0, 4)}•••••${d.slice(-2)}`;
};
export const maskEmail = (v: string | null | undefined) => {
  if (!v || !v.includes('@')) return '';
  const [user, domain] = v.split('@') as [string, string];
  return `${user.slice(0, 1)}${'•'.repeat(Math.max(1, user.length - 1))}@${domain}`;
};
