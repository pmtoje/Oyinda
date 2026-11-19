import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { api, ApiError } from './api';
import { useAuth } from './auth';
import { Button } from '../components/ui';
import { discardEntries, pendingEntries, restoreEntries, snapshotEntries } from './unsaved';

/**
 * Inactivity timeout with an advance warning (session policy is configured by administrators, maker-checker).
 *
 *  - The server is the source of truth: the browser reads the real expiry with a passive status check, which
 *    never extends the session. Background polling is passive too, so it cannot keep an idle session alive.
 *  - Real use (typing, clicking, scrolling) counts as activity even between saves: it extends the session at most
 *    once a minute. While the warning is open only an explicit "Stay signed in" extends it.
 *  - All open tabs agree: an extension or sign-out in one tab is broadcast to the others.
 *  - When the session ends, anything typed on the page is kept on this device so it can be restored after
 *    signing in again (see lib/unsaved.ts).
 */
interface Status { idleExpiresAt: string; absoluteExpiresAt: string; serverTime: string; idleMinutes: number; warningSeconds: number }
type Timing = { idleAt: number; absoluteAt: number; warningMs: number; idleMinutes: number };

const ACTIVITY_EVENTS = ['keydown', 'pointerdown', 'wheel', 'touchstart'] as const;
const KEEPALIVE_EVERY_MS = 60_000;
const POLL_MS = 60_000;

const mmss = (ms: number) => { const s = Math.max(0, Math.ceil(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

export function SessionTimeout({ kind }: { kind: 'CUSTOMER' | 'STAFF' }) {
  const { logout } = useAuth();
  const nav = useNavigate();
  const loc = useLocation();
  const [timing, setTiming] = useState<Timing | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const lastExtend = useRef(Date.now());
  const ending = useRef(false);
  const channel = useRef<BroadcastChannel | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  const apply = useCallback((s: Status) => {
    const skew = new Date(s.serverTime).getTime() - Date.now(); // server clock minus this device's clock
    setTiming({ idleAt: new Date(s.idleExpiresAt).getTime() - skew, absoluteAt: new Date(s.absoluteExpiresAt).getTime() - skew, warningMs: s.warningSeconds * 1000, idleMinutes: s.idleMinutes });
  }, []);

  const end = useCallback(async (reason: 'timeout' | 'max' | 'elsewhere') => {
    if (ending.current) return;
    ending.current = true;
    if (reason !== 'elsewhere') channel.current?.postMessage({ type: 'ended', reason });
    snapshotEntries(loc.pathname);
    // Leave the protected page first (so the shell's guard does not race this navigation), then end the session.
    nav(kind === 'STAFF' ? '/staff/login' : '/login', { replace: true, state: { from: loc.pathname + loc.search, reason } });
    await logout();
  }, [kind, loc.pathname, loc.search, logout, nav]);

  const check = useCallback(async () => {
    try { apply(await api.get<Status>('/api/auth/session/status', { passive: true })); }
    catch (e) { if (e instanceof ApiError && e.status === 401) void end(timing && Date.now() >= timing.absoluteAt - 1000 ? 'max' : 'timeout'); }
  }, [apply, end, timing]);

  const extend = useCallback(async () => {
    lastExtend.current = Date.now();
    try { apply(await api.post<Status>('/api/auth/session/keep-alive')); channel.current?.postMessage({ type: 'extended' }); }
    catch (e) { if (e instanceof ApiError && e.status === 401) void end('timeout'); }
  }, [apply, end]);

  // First read, slow passive poll, and cross-tab coordination
  useEffect(() => {
    void check();
    const poll = setInterval(() => void check(), POLL_MS);
    if ('BroadcastChannel' in window) {
      channel.current = new BroadcastChannel('gz-session');
      channel.current.onmessage = (m) => { if (m.data?.type === 'extended') void check(); if (m.data?.type === 'ended') void end('elsewhere'); };
    }
    return () => { clearInterval(poll); channel.current?.close(); channel.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Any successful (active) API call slid the server's window: re-read it shortly after
  useEffect(() => {
    // The server slid its window on that request; mirror it locally (no extra request), capped at the maximum.
    const onActivity = () => {
      lastExtend.current = Date.now();
      setTiming((cur) => (cur ? { ...cur, idleAt: Math.min(cur.absoluteAt, Date.now() + cur.idleMinutes * 60_000) } : cur));
    };
    window.addEventListener('gz:activity', onActivity);
    return () => window.removeEventListener('gz:activity', onActivity);
  }, []);

  const warning = !!timing && Math.min(timing.idleAt, timing.absoluteAt) - now <= timing.warningMs;
  const atMax = !!timing && timing.absoluteAt <= timing.idleAt;

  // Real use of the page counts as activity (throttled), except while the warning asks for an explicit choice
  useEffect(() => {
    const onUse = () => { if (!warning && Date.now() - lastExtend.current > KEEPALIVE_EVERY_MS) void extend(); };
    for (const ev of ACTIVITY_EVENTS) window.addEventListener(ev, onUse, { passive: true });
    return () => { for (const ev of ACTIVITY_EVENTS) window.removeEventListener(ev, onUse); };
  }, [warning, extend]);

  // Clock tick; at expiry confirm with the server (another tab may have extended) before ending
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const expired = !!timing && Math.min(timing.idleAt, timing.absoluteAt) <= now;
  useEffect(() => { if (expired) void check(); }, [expired, check]);
  useEffect(() => { if (warning) { void check(); { const d = dialogRef.current; (d?.querySelector<HTMLElement>('.btn.primary') ?? d?.querySelector<HTMLElement>('.btn'))?.focus(); } } }, [warning]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!timing || !warning) return null;
  const left = Math.min(timing.idleAt, timing.absoluteAt) - now;
  return (
    <div className="overlay center session-overlay">
      <div ref={dialogRef} className="dialog" role="alertdialog" aria-modal="true" aria-labelledby="session-warning-title" aria-describedby="session-warning-text">
        <div className="dialog-head"><h3 id="session-warning-title">{atMax ? 'Your session is about to reach its time limit' : 'Are you still there?'}</h3></div>
        <div className="dialog-body stack">
          <p id="session-warning-text">
            {atMax
              ? 'For your security, sessions have a maximum length. Save your work now; you will need to sign in again.'
              : `For your security you will be signed out after ${timing.idleMinutes} minutes without activity.`}
          </p>
          <p className="session-countdown" aria-hidden>Signing out in <strong className="num">{mmss(left)}</strong></p>
          <p className="small muted">Anything you have typed on this page is kept on this device and can be restored after you sign in again.</p>
        </div>
        <div className="dialog-foot row">
          <Button variant="ghost" onClick={() => void end(atMax ? 'max' : 'timeout')}>Sign out now</Button>
          {!atMax && <Button variant="primary" onClick={() => void extend()}>Stay signed in</Button>}
        </div>
      </div>
    </div>
  );
}

/** Shown on the sign-in pages after a session ended on its own. */
export function SignedOutNotice({ reason }: { reason?: string }) {
  if (!reason) return null;
  const text = reason === 'max'
    ? 'Your session reached its maximum length, so you were signed out. Please sign in again.'
    : reason === 'elsewhere'
      ? 'You were signed out in another tab.'
      : 'You were signed out after a period of inactivity, to protect your information. Please sign in again.';
  return <div className="alert info" role="status"><div><div className="alert-title">Signed out</div>{text}</div></div>;
}

/** After signing back in: offers to put back what was typed on this page before the session ended. */
export function RestoreUnsaved() {
  const loc = useLocation();
  const [pending, setPending] = useState(() => pendingEntries(loc.pathname));
  const [done, setDone] = useState<number | null>(null);
  useEffect(() => { setPending(pendingEntries(loc.pathname)); setDone(null); }, [loc.pathname]);
  if (done !== null) return <div className="alert ok restore-unsaved" role="status"><div>{done ? `Restored ${done} ${done === 1 ? 'entry' : 'entries'}. Check them, then save.` : 'Nothing to restore: the page has changed since you were signed out.'}</div></div>;
  if (!pending) return null;
  return (
    <div className="alert info restore-unsaved" role="status">
      <div style={{ flex: 1 }}>
        <div className="alert-title">You were signed out before saving</div>
        We kept what you had typed on this page ({pending.fields.length} {pending.fields.length === 1 ? 'entry' : 'entries'}). Open the same form, then restore it.
      </div>
      <div className="row" style={{ alignSelf: 'center' }}>
        <Button size="sm" variant="ghost" onClick={() => { discardEntries(); setPending(null); }}>Discard</Button>
        <Button size="sm" variant="primary" onClick={() => setDone(restoreEntries())}>Restore</Button>
      </div>
    </div>
  );
}
