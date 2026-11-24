import { useEffect, useId, useRef, useState, type ReactNode, type ButtonHTMLAttributes, type InputHTMLAttributes, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { createPortal } from 'react-dom';
import { ApiError } from '../lib/api';
import { humanize } from '../lib/format';

export function Button({ variant, size, loading, children, ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'accent' | 'danger' | 'ghost'; size?: 'sm' | 'lg'; loading?: boolean }) {
  return <button type="button" {...p} className={['btn', variant, size, p.className].filter(Boolean).join(' ')} disabled={p.disabled || loading} aria-busy={loading || undefined}>{loading && <span className="spinner" aria-hidden />}{children}</button>;
}

export function Field({ label, hint, error, required, children, id }: { label: ReactNode; hint?: ReactNode; error?: string; required?: boolean; id?: string; children: (id: string, describedBy?: string) => ReactNode }) {
  const auto = useId(); const fid = id ?? auto;
  const hid = hint ? `${fid}-hint` : undefined; const eid = error ? `${fid}-err` : undefined;
  return (
    <div className="field">
      <label htmlFor={fid}>{label}{required && <span className="req" aria-hidden>*</span>}</label>
      {children(fid, [hid, eid].filter(Boolean).join(' ') || undefined)}
      {hint && !error && <span className="hint" id={hid}>{hint}</span>}
      {error && <span className="error" id={eid} role="alert">{error}</span>}
    </div>
  );
}
type L = { label: ReactNode; hint?: ReactNode; error?: string };
export const TextInput = ({ label, hint, error, ...p }: L & InputHTMLAttributes<HTMLInputElement>) => <Field label={label} hint={hint} error={error} required={p.required}>{(id, d) => <input id={id} className="input" aria-invalid={!!error} aria-describedby={d} {...p} />}</Field>;
export const TextArea = ({ label, hint, error, ...p }: L & TextareaHTMLAttributes<HTMLTextAreaElement>) => <Field label={label} hint={hint} error={error} required={p.required}>{(id, d) => <textarea id={id} className="textarea" aria-invalid={!!error} aria-describedby={d} {...p} />}</Field>;
export const SelectInput = ({ label, hint, error, options, placeholder, ...p }: L & SelectHTMLAttributes<HTMLSelectElement> & { options: { value: string; label: string }[]; placeholder?: string }) => (
  <Field label={label} hint={hint} error={error} required={p.required}>{(id, d) => (
    <select id={id} className="select" aria-invalid={!!error} aria-describedby={d} {...p}>
      {placeholder !== undefined && <option value="">{placeholder}</option>}
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>)}</Field>
);
export const MoneyInput = ({ label, hint, error, currency = 'NGN', ...p }: L & InputHTMLAttributes<HTMLInputElement> & { currency?: string }) => (
  <Field label={label} hint={hint} error={error} required={p.required}>{(id, d) => (
    <div className="input-affix"><span className="affix">{currency === 'NGN' ? '₦' : currency}</span><input id={id} className="input" inputMode="decimal" aria-invalid={!!error} aria-describedby={d} {...p} /></div>)}</Field>
);
export const Check = ({ label, ...p }: { label: ReactNode } & InputHTMLAttributes<HTMLInputElement>) => <label className="check"><input type="checkbox" {...p} /><span>{label}</span></label>;

export function Panel({ title, actions, children, footer, flush, id }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; footer?: ReactNode; flush?: boolean; id?: string }) {
  return (
    <section className="panel" id={id} aria-label={typeof title === 'string' ? title : undefined}>
      {(title || actions) && <div className="panel-head"><h3>{title}</h3>{actions && <div className="row">{actions}</div>}</div>}
      <div className={flush ? 'panel-body flush' : 'panel-body'}>{children}</div>
      {footer && <div className="panel-foot">{footer}</div>}
    </section>
  );
}

export const PageHeader = ({ eyebrow, title, sub, actions, crumbs }: { eyebrow?: string; title: ReactNode; sub?: ReactNode; actions?: ReactNode; crumbs?: ReactNode }) => (
  <header className="page-header"><div>{crumbs && <div className="crumbs">{crumbs}</div>}{eyebrow && <div className="eyebrow">{eyebrow}</div>}<h1>{title}</h1>{sub && <p>{sub}</p>}</div>{actions && <div className="row">{actions}</div>}</header>
);

export function Alert({ tone = 'info', title, children }: { tone?: 'info' | 'warn' | 'danger' | 'ok'; title?: ReactNode; children?: ReactNode }) {
  return <div className={`alert ${tone}`} role={tone === 'danger' ? 'alert' : 'status'}><div>{title && <div className="alert-title">{title}</div>}{children}</div></div>;
}

/** Render an API error with field details, never raw internals. */
export function ErrorAlert({ error, title }: { error: unknown; title?: string }) {
  if (!error) return null;
  const e = error instanceof ApiError ? error : null;
  const details: any[] = Array.isArray(e?.details) ? e!.details : e?.details?.points ? e.details.points.map((p: string) => ({ message: p })) : [];
  return (
    <Alert tone="danger" title={title ?? (e ? e.message : 'Something went wrong. Please try again.')}>
      {title && e && <div>{e.message}</div>}
      {details.length > 0 && <ul>{details.slice(0, 12).map((d, i) => <li key={i}>{typeof d === 'string' ? d : d.message ?? d.label ?? d.description ?? JSON.stringify(d)}</li>)}</ul>}
      {e?.requestId && e.status >= 500 && <div className="xs muted">Reference: {e.requestId}</div>}
    </Alert>
  );
}

const TONES: Record<string, string> = {
  APPROVED: 'ok', ACTIVE: 'ok', VERIFIED: 'ok', SATISFIED: 'ok', POSTED: 'ok', COMPLETED: 'ok', PAID: 'ok', ELIGIBLE: 'ok', ON_TRACK: 'ok', CLEAN: 'ok', OFFER_ACCEPTED: 'ok', VALIDATED: 'ok', PARSED: 'ok', ACCEPTED: 'ok', MEETS_INITIAL_CRITERIA: 'ok', RESOLVED: 'ok', PERFECTED: 'ok',
  RETURNED: 'warn', WARNING: 'warn', UNDER_REVIEW: 'warn', UPLOADED: 'info', IN_REVIEW: 'info', SUBMITTED: 'info', OFFER_ISSUED: 'brand', IN_NEGOTIATION: 'warn', REFER: 'warn', EXCEPTION_REQUIRED: 'warn', NEEDS_REVIEW: 'warn', PENDING_CHECK: 'warn', PENDING_APPROVAL: 'warn', FULFILMENT: 'brand', READY_FOR_ACTIVATION: 'brand', CLAIMED: 'info', OPEN: 'info', PENDING: 'warn', FURTHER_REVIEW: 'warn', PARTIAL: 'warn', DRAFT: '', REQUIRED: '', QUEUED: 'info', PROCESSING: 'info', IN_PROGRESS: 'info', WAIVED: 'info', DUE: '',
  DECLINED: 'danger', REJECTED: 'danger', EXPIRED: 'danger', BREACHED: 'danger', FAILED: 'danger', INELIGIBLE: 'danger', OVERDUE: 'danger', CRITICAL: 'danger', OFFER_REJECTED: 'danger', DOES_NOT_MEET_CRITERIA: 'danger', DUPLICATE: 'danger', INFECTED: 'danger',
};
export const Status = ({ value, label }: { value?: string | null; label?: string }) => value ? <span className={`badge ${TONES[value] ?? ''}`}>{label ?? humanize(value)}</span> : null;

export const Empty = ({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) => (
  <div className="empty"><div className="title">{title}</div>{children && <div className="small">{children}</div>}{action && <div style={{ marginTop: 12 }}>{action}</div>}</div>
);
export const Loading = ({ rows = 3, label = 'Loading' }: { rows?: number; label?: string }) => (
  <div className="stack" style={{ ['--gap' as any]: '10px', padding: 8 }} role="status" aria-busy="true" aria-label={label}>{Array.from({ length: rows }).map((_, i) => <div key={i} className="skeleton" style={{ width: `${90 - i * 12}%` }} />)}</div>
);

export function KV({ items }: { items: [ReactNode, ReactNode][] }) {
  return <dl className="kv">{items.map(([k, v], i) => <div key={i} style={{ display: 'contents' }}><dt>{k}</dt><dd>{v ?? '—'}</dd></div>)}</dl>;
}

export function Tabs({ tabs, value, onChange }: { tabs: { key: string; label: string; flag?: boolean }[]; value: string; onChange: (k: string) => void }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((t) => <button key={t.key} role="tab" aria-selected={value === t.key} onClick={() => onChange(t.key)}>{t.label}{t.flag && <span className="flag" aria-label="needs attention" />}</button>)}
    </div>
  );
}

export function Drawer({ title, onClose, children, footer, center }: { title: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; center?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>('input,select,textarea,button')?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); prev?.focus(); };
  }, [onClose]);
  // Rendered at the document root so a dialog opened from inside a table cell or panel never inherits its layout
  // (nowrap, alignment, overflow clipping).
  return createPortal(
    <div className={center ? 'overlay center' : 'overlay'} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={center ? 'dialog' : 'drawer'} role="dialog" aria-modal="true" aria-label={typeof title === 'string' ? title : 'Dialog'} ref={ref}>
        <div className={center ? 'dialog-head' : 'drawer-head'}><h3>{title}</h3><Button variant="ghost" size="sm" onClick={onClose} aria-label="Close">Close</Button></div>
        {/* focusable so keyboard users can scroll long content (WCAG 2.1.1) */}
        <div className={center ? 'dialog-body' : 'drawer-body'} tabIndex={0}>{children}</div>
        {footer && <div className={center ? 'dialog-foot' : 'drawer-foot'}>{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

/** Simple async action state for forms and buttons. */
export function useAction<A extends any[], R>(fn: (...a: A) => Promise<R>) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const run = async (...a: A): Promise<R | undefined> => {
    setLoading(true); setError(null);
    try { return await fn(...a); } catch (e) { setError(e); return undefined; } finally { setLoading(false); }
  };
  return { run, loading, error, setError };
}

export const fieldError = (error: unknown, field: string) => {
  if (!(error instanceof ApiError) || !Array.isArray(error.details)) return undefined;
  return error.details.find((d: any) => d.path === field || d.field === field)?.message;
};

export function MockTag({ mode }: { mode?: string | null }) {
  return mode === 'MOCK' || mode === 'mock' ? <span className="tag mock" title="Development integration — not live bank data">MOCK</span> : null;
}
