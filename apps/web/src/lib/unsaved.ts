/**
 * Keeps what a user typed when their session ends on its own (inactivity or maximum length), so nothing is lost.
 * Stored only in this browser tab (sessionStorage — gone when the tab closes), never sent anywhere, expires after
 * 12 hours, and never includes passwords, one-time codes, hidden fields or files.
 */
const KEY = 'gz-unsaved';
const MAX_AGE_MS = 12 * 3600_000;
type Field = { key: string; value: string };
type Snapshot = { path: string; at: number; fields: Field[] };

const FIELDS = 'main input, main textarea, main select';
const skip = (el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement) =>
  el.disabled || (el as HTMLInputElement).readOnly ||
  (el instanceof HTMLInputElement && (['password', 'hidden', 'file', 'checkbox', 'radio', 'submit', 'button'].includes(el.type) || el.autocomplete === 'one-time-code'));

function fieldKeys() {
  const seen = new Map<string, number>();
  const out: { el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement; key: string }[] = [];
  for (const el of Array.from(document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(FIELDS))) {
    if (skip(el)) continue;
    const label = (el.labels?.[0]?.textContent ?? el.getAttribute('aria-label') ?? '').trim();
    const base = `${label}|${el.name}|${el.tagName}`;
    const n = (seen.get(base) ?? 0) + 1; seen.set(base, n);
    out.push({ el, key: `${base}#${n}` });
  }
  return out;
}

const read = (): Snapshot | null => {
  try { const s = JSON.parse(sessionStorage.getItem(KEY) ?? 'null') as Snapshot | null; return s && Date.now() - s.at < MAX_AGE_MS ? s : null; } catch { return null; }
};

export function snapshotEntries(path: string) {
  try {
    const fields = fieldKeys().filter(({ el }) => el.value.trim() !== '').map(({ el, key }) => ({ key, value: el.value.slice(0, 20_000) }));
    if (fields.length) sessionStorage.setItem(KEY, JSON.stringify({ path, at: Date.now(), fields }));
  } catch { /* storage unavailable: nothing kept */ }
}

export const pendingEntries = (path: string) => { const s = read(); return s && s.path === path ? s : null; };
export const discardEntries = () => { try { sessionStorage.removeItem(KEY); } catch { /* ignore */ } };

/** Puts the kept values back into the matching fields (works with React-controlled inputs). Returns how many. */
export function restoreEntries(): number {
  const s = read();
  if (!s) return 0;
  const byKey = new Map(s.fields.map((f) => [f.key, f.value]));
  let n = 0;
  for (const { el, key } of fieldKeys()) {
    const v = byKey.get(key);
    if (v === undefined || el.value === v) continue;
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(el, v);
    el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
    n++;
  }
  discardEntries();
  return n;
}
