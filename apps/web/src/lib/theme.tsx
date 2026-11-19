import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';

export type ThemePref = 'light' | 'dark' | 'system';
type Ctx = { pref: ThemePref; resolved: 'light' | 'dark'; setPref: (p: ThemePref, opts?: { sync?: boolean }) => void };
const ThemeCtx = createContext<Ctx | null>(null);
const KEY = 'gz-theme';
const media = () => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null);
const read = (): ThemePref => { try { const v = localStorage.getItem(KEY); return v === 'light' || v === 'dark' ? v : 'system'; } catch { return 'system'; } };
const resolve = (p: ThemePref): 'light' | 'dark' => (p === 'system' ? (media()?.matches ? 'dark' : 'light') : p);

/**
 * Light, dark or system theme. Switching only changes an attribute on <html>: nothing re-mounts, so entered data,
 * uploads, scroll position and the current task are untouched. The choice is kept on this device and, when signed in,
 * on the user's account so it follows them between devices.
 */
export function ThemeProvider({ children, onChange }: { children: ReactNode; onChange?: (p: ThemePref) => void }) {
  const [pref, setPrefState] = useState<ThemePref>(read);
  const [resolved, setResolved] = useState<'light' | 'dark'>(() => resolve(read()));
  useEffect(() => {
    const apply = () => { const r = resolve(pref); setResolved(r); document.documentElement.setAttribute('data-theme', r); document.documentElement.setAttribute('data-theme-pref', pref); };
    apply();
    const m = media();
    if (pref !== 'system' || !m) return;
    m.addEventListener('change', apply);
    return () => m.removeEventListener('change', apply);
  }, [pref]);
  const setPref = useCallback((p: ThemePref, opts: { sync?: boolean } = {}) => {
    try { localStorage.setItem(KEY, p); } catch { /* private mode: still applies for this session */ }
    setPrefState(p);
    if (opts.sync !== false) onChange?.(p);
  }, [onChange]);
  return <ThemeCtx.Provider value={{ pref, resolved, setPref }}>{children}</ThemeCtx.Provider>;
}

export function useTheme() {
  const c = useContext(ThemeCtx);
  if (!c) throw new Error('useTheme outside ThemeProvider');
  return c;
}

const OPTIONS: [ThemePref, string, string][] = [['light', 'Light', 'M12 4V2m0 20v-2m8-8h2M2 12h2m13.66-5.66 1.41-1.41M4.93 19.07l1.41-1.41m0-11.32L4.93 4.93m14.14 14.14-1.41-1.41M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z'], ['dark', 'Dark', 'M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z'], ['system', 'System', 'M3 5h18v11H3zM8 20h8M12 16v4']];

/** Segmented Light / Dark / System control. `tone="chrome"` for the dark top bar. */
export function ThemeSwitch({ tone = 'surface' }: { tone?: 'surface' | 'chrome' }) {
  const { pref, setPref } = useTheme();
  return (
    <div className={`theme-switch ${tone}`} role="radiogroup" aria-label="Colour theme">
      {OPTIONS.map(([v, label, d]) => (
        <button key={v} type="button" role="radio" aria-checked={pref === v} title={`${label} theme`} onClick={() => setPref(v)}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d={d} /></svg>
          <span className="sr-only">{label}</span>
        </button>
      ))}
    </div>
  );
}

/** Keeps the device theme and the signed-in user's saved theme in step. */
export function ThemeAccountSync({ me, save }: { me: { preferences?: { theme: ThemePref } } | null | undefined; save: (p: ThemePref) => void }) {
  const { pref, setPref } = useTheme();
  const account = me?.preferences?.theme;
  useEffect(() => {
    if (!account) return;
    if (account !== 'system' && account !== pref) setPref(account, { sync: false }); // the account's explicit choice follows the user
    else if (account === 'system' && pref !== 'system') save(pref); // first sign-in after choosing on this device
  }, [account]); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}
