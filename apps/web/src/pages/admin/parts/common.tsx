import { useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../../lib/api';
import { Button, ErrorAlert, Field } from '../../../components/ui';

export type Condition = { all: Condition[] } | { any: Condition[] } | { not: Condition } | { always: true } | { fact: string; op: string; value?: unknown; label?: string };
export const OPS: { value: string; label: string; arity: 0 | 1 | 2 | 'list' }[] = [
  { value: 'eq', label: 'equals', arity: 1 }, { value: 'ne', label: 'does not equal', arity: 1 },
  { value: 'gt', label: 'greater than', arity: 1 }, { value: 'gte', label: 'at least', arity: 1 },
  { value: 'lt', label: 'less than', arity: 1 }, { value: 'lte', label: 'at most', arity: 1 },
  { value: 'between', label: 'between', arity: 2 }, { value: 'in', label: 'is one of', arity: 'list' }, { value: 'nin', label: 'is not one of', arity: 'list' },
  { value: 'contains', label: 'contains', arity: 1 }, { value: 'exists', label: 'is provided', arity: 0 }, { value: 'truthy', label: 'is true', arity: 0 }, { value: 'falsy', label: 'is false', arity: 0 },
];

export const useFacts = () => useQuery({ queryKey: ['admin', 'facts'], queryFn: () => api.get<{ fact: string; description: string }[]>('/api/admin/config/facts'), staleTime: Infinity });
export const useReference = () => useQuery({ queryKey: ['admin', 'reference'], queryFn: () => api.get<{ directorates: { code: string; name: string }[]; businessUnits: { code: string; name: string; directorate: string }[]; sectors: { code: string; name: string }[] }>('/api/admin/reference'), staleTime: 300_000 });
export const useRoles = () => useQuery({ queryKey: ['admin', 'roles'], queryFn: () => api.get<{ code: string; name: string; privileged: boolean; permissions: string[] }[]>('/api/admin/roles'), staleTime: 300_000, retry: false });

/** Parse a scalar typed into a condition value box. */
export const parseScalar = (s: string): unknown => {
  const t = s.trim();
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (t !== '' && Number.isFinite(Number(t))) return Number(t);
  return t;
};
const showScalar = (v: unknown) => (v === undefined || v === null ? '' : String(v));

const kindOf = (c: Condition) => ('all' in c ? 'all' : 'any' in c ? 'any' : 'not' in c ? 'not' : 'always' in c ? 'always' : 'rule');

/** Recursive visual editor for the Credit360 condition language. */
export function ConditionBuilder({ value, onChange, depth = 0, label }: { value: Condition; onChange: (c: Condition) => void; depth?: number; label?: string }) {
  const facts = useFacts();
  const k = kindOf(value);
  const setKind = (nk: string) => {
    if (nk === k) return;
    if (nk === 'always') onChange({ always: true });
    else if (nk === 'rule') onChange({ fact: facts.data?.[0]?.fact ?? 'facility.amountNgn', op: 'gte', value: 0 });
    else if (nk === 'not') onChange({ not: k === 'rule' ? value : { fact: 'facility.amountNgn', op: 'gte', value: 0 } });
    else {
      const children = 'all' in value ? value.all : 'any' in value ? value.any : [k === 'always' ? { fact: 'facility.amountNgn', op: 'gte', value: 0 } : value];
      onChange(nk === 'all' ? { all: children as Condition[] } : { any: children as Condition[] });
    }
  };
  const box = { border: '1px solid var(--line)', borderLeft: depth ? '2px solid var(--accent-500)' : '1px solid var(--line)', borderRadius: 'var(--radius)', padding: 10, background: depth % 2 ? 'var(--canvas)' : 'var(--surface)' } as const;
  return (
    <div style={box} role="group" aria-label={label ?? 'Condition'}>
      <div className="row" style={{ ['--gap' as any]: '8px', marginBottom: k === 'always' ? 0 : 8 }}>
        <select className="select" style={{ width: 'auto' }} aria-label="Condition type" value={k} onChange={(e) => setKind(e.target.value)}>
          <option value="rule">Rule</option><option value="all">All of (AND)</option><option value="any">Any of (OR)</option><option value="not">Not</option><option value="always">Always applies</option>
        </select>
      </div>
      {k === 'rule' && <RuleRow value={value as any} onChange={onChange} facts={facts.data ?? []} />}
      {(k === 'all' || k === 'any') && (
        <div className="stack" style={{ ['--gap' as any]: '8px' }}>
          {((value as any)[k] as Condition[]).map((c, i) => (
            <div key={i} className="row" style={{ alignItems: 'flex-start', ['--gap' as any]: '6px' }}>
              <div className="grow"><ConditionBuilder depth={depth + 1} value={c} onChange={(nc) => { const arr = [...(value as any)[k]]; arr[i] = nc; onChange({ [k]: arr } as Condition); }} /></div>
              <Button size="sm" variant="ghost" aria-label="Remove condition" onClick={() => { const arr = ((value as any)[k] as Condition[]).filter((_, j) => j !== i); onChange((arr.length ? { [k]: arr } : { always: true }) as Condition); }}>Remove</Button>
            </div>
          ))}
          <div><Button size="sm" onClick={() => onChange({ [k]: [...(value as any)[k], { fact: facts.data?.[0]?.fact ?? 'facility.amountNgn', op: 'gte', value: 0 }] } as Condition)}>Add condition</Button></div>
        </div>
      )}
      {k === 'not' && <ConditionBuilder depth={depth + 1} value={(value as any).not} onChange={(c) => onChange({ not: c })} />}
    </div>
  );
}

function RuleRow({ value, onChange, facts }: { value: { fact: string; op: string; value?: unknown }; onChange: (c: Condition) => void; facts: { fact: string; description: string }[] }) {
  const op = OPS.find((o) => o.value === value.op) ?? OPS[0]!;
  const known = facts.some((f) => f.fact === value.fact);
  const set = (patch: Partial<typeof value>) => {
    const next = { ...value, ...patch } as any;
    const no = OPS.find((o) => o.value === next.op)!;
    if (no.arity === 0) delete next.value;
    else if (no.arity === 'list' && !Array.isArray(next.value)) next.value = next.value === undefined || next.value === '' ? [] : [next.value];
    else if (no.arity === 2 && !Array.isArray(next.value)) next.value = [0, 0];
    else if (no.arity === 1 && Array.isArray(next.value)) next.value = next.value[0] ?? '';
    onChange(next);
  };
  return (
    <div className="grid cols-3" style={{ gap: 8 }}>
      <div>
        <select className="select" aria-label="Fact" value={value.fact} onChange={(e) => set({ fact: e.target.value })}>
          {!known && <option value={value.fact}>{value.fact} (unknown)</option>}
          {facts.map((f) => <option key={f.fact} value={f.fact}>{f.description}</option>)}
        </select>
        <div className="xs muted mono" style={{ marginTop: 2 }}>{value.fact}</div>
      </div>
      <select className="select" aria-label="Operator" value={value.op} onChange={(e) => set({ op: e.target.value })}>{OPS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select>
      <div>
        {op.arity === 1 && <input className="input" aria-label="Value" value={showScalar(value.value)} onChange={(e) => set({ value: parseScalar(e.target.value) })} />}
        {op.arity === 'list' && <input className="input" aria-label="Values (comma-separated)" value={Array.isArray(value.value) ? value.value.join(', ') : ''} onChange={(e) => set({ value: e.target.value.split(',').map((x) => x.trim()).filter(Boolean).map(parseScalar) })} placeholder="e.g. OIL_GAS, MINING" />}
        {op.arity === 2 && (
          <div className="row" style={{ ['--gap' as any]: '6px', flexWrap: 'nowrap' }}>
            <input className="input" aria-label="Minimum" value={showScalar((value.value as any[])?.[0])} onChange={(e) => set({ value: [parseScalar(e.target.value), (value.value as any[])?.[1] ?? 0] })} />
            <span className="muted small">and</span>
            <input className="input" aria-label="Maximum" value={showScalar((value.value as any[])?.[1])} onChange={(e) => set({ value: [(value.value as any[])?.[0] ?? 0, parseScalar(e.target.value)] })} />
          </div>
        )}
        {op.arity === 0 && <div className="small muted" style={{ paddingTop: 8 }}>No value needed</div>}
      </div>
    </div>
  );
}

/** Plain-language rendering of a condition for read-only views. */
export function describeCondition(c: any): string {
  if (!c) return '—';
  if ('always' in c) return 'Always';
  if ('all' in c) return c.all.map(describeCondition).map((s: string) => `(${s})`).join(' AND ');
  if ('any' in c) return c.any.map(describeCondition).map((s: string) => `(${s})`).join(' OR ');
  if ('not' in c) return `NOT (${describeCondition(c.not)})`;
  const op = OPS.find((o) => o.value === c.op);
  const v = op?.arity === 0 ? '' : Array.isArray(c.value) ? (c.op === 'between' ? ` ${c.value[0]} and ${c.value[1]}` : ` [${c.value.join(', ')}]`) : ` ${c.value}`;
  return `${c.fact} ${op?.label ?? c.op}${v}`;
}

/** Condition preview against admin-supplied sample facts (dotted keys). */
export function ConditionPreview({ condition }: { condition: unknown }) {
  const [text, setText] = useState('{\n  "facility": { "amountNgn": 150000000, "productFamily": "MURABAHA", "category": "DIRECT" },\n  "customer": { "sector": "MANUFACTURING", "isPep": false }\n}');
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState<unknown>(null);
  const [parseErr, setParseErr] = useState<string | null>(null);
  const run = async () => {
    setError(null); setResult(null); setParseErr(null);
    let facts: unknown;
    try { facts = JSON.parse(text); } catch { setParseErr('Sample facts must be valid JSON.'); return; }
    try { setResult(await api.post('/api/admin/config/preview-condition', { condition, facts })); } catch (e) { setError(e); }
  };
  return (
    <div className="stack" style={{ ['--gap' as any]: '8px' }}>
      <Field label="Sample facts (JSON)" hint="Evaluate the condition against example values before submitting." error={parseErr ?? undefined}>{(id, d) => <textarea id={id} aria-describedby={d} className="textarea mono" rows={6} value={text} onChange={(e) => setText(e.target.value)} />}</Field>
      <div><Button size="sm" onClick={run}>Preview condition</Button></div>
      <ErrorAlert error={error} />
      {result && (
        <div className="panel" style={{ padding: 10 }}>
          <div className="row"><strong>Result:</strong> <span className={`badge ${result.result ? 'ok' : 'danger'}`}>{result.result ? 'Applies / passes' : 'Does not apply / fails'}</span>{result.incomplete && <span className="badge warn">Incomplete — some facts missing</span>}</div>
          <div className="table-wrap"><table className="data" style={{ marginTop: 8 }}><thead><tr><th>Fact</th><th>Operator</th><th>Expected</th><th>Actual</th><th>Outcome</th></tr></thead>
            <tbody>{result.trace.map((t: any, i: number) => <tr key={i}><td className="mono">{t.fact}</td><td>{OPS.find((o) => o.value === t.op)?.label ?? t.op}</td><td className="mono">{JSON.stringify(t.expected) ?? '—'}</td><td className="mono">{t.missing ? 'missing' : JSON.stringify(t.actual)}</td><td>{t.passed ? <span className="badge ok">pass</span> : <span className="badge danger">fail</span>}</td></tr>)}</tbody></table></div>
        </div>
      )}
    </div>
  );
}

/** Validated JSON editor (fallback for every configuration kind). */
export function JsonEditor({ value, onChange, rows = 18 }: { value: unknown; onChange: (v: unknown, valid: boolean) => void; rows?: number }) {
  const [text, setText] = useState(() => JSON.stringify(value, null, 2));
  const [err, setErr] = useState<string | null>(null);
  return (
    <Field label="Configuration payload (JSON)" hint="Validated against the configuration schema on save." error={err ?? undefined}>{(id, d) => (
      <textarea id={id} aria-describedby={d} className="textarea mono" rows={rows} spellCheck={false} value={text}
        onChange={(e) => { setText(e.target.value); try { const v = JSON.parse(e.target.value); setErr(null); onChange(v, true); } catch (x) { setErr(`Invalid JSON: ${(x as Error).message}`); onChange(value, false); } }} />)}
    </Field>
  );
}

/** Comma-separated list input bound to a string array. */
export function ListInput({ label, value, onChange, hint, placeholder }: { label: string; value: string[]; onChange: (v: string[]) => void; hint?: string; placeholder?: string }) {
  const [text, setText] = useState(value.join(', '));
  return <Field label={label} hint={hint}>{(id, d) => <input id={id} aria-describedby={d} className="input" value={text} placeholder={placeholder} onChange={(e) => { setText(e.target.value); onChange(e.target.value.split(',').map((x) => x.trim()).filter(Boolean)); }} />}</Field>;
}

export function NumberField({ label, value, onChange, hint, step, min, max, required }: { label: string; value: number | undefined; onChange: (v: number | undefined) => void; hint?: string; step?: number; min?: number; max?: number; required?: boolean }) {
  return <Field label={label} hint={hint} required={required}>{(id, d) => <input id={id} aria-describedby={d} className="input" type="number" step={step ?? 'any'} min={min} max={max} value={value ?? ''} onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))} />}</Field>;
}

/** Naira major-unit input bound to a minor-unit integer. */
/** Naira amount input: thousands separators while reading, raw digits while typing; stored in kobo. Never truncates. */
export function NairaField({ label, minor, onChange, hint }: { label: string; minor: number | undefined; onChange: (m: number | undefined) => void; hint?: string }) {
  const [focused, setFocused] = useState(false);
  const naira = minor === undefined || minor === null ? '' : minor / 100;
  const shown = naira === '' ? '' : focused ? String(naira) : Number(naira).toLocaleString('en-NG', { maximumFractionDigits: 2 });
  return (
    <Field label={label} hint={hint}>{(id, d) => (
      <div className="input-affix"><span className="affix">₦</span>
        <input id={id} aria-describedby={d} className="input num-input" inputMode="decimal" value={shown} onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
          onChange={(e) => { const t = e.target.value.replace(/[,\s₦]/g, ''); onChange(t === '' ? undefined : Number.isFinite(Number(t)) ? Math.round(Number(t) * 100) : minor); }} />
      </div>)}
    </Field>
  );
}

/** Key-level diff between two JSON payloads. */
export function PayloadDiff({ before, after }: { before: unknown; after: unknown }) {
  const flat = (o: unknown, p = '', out: Record<string, string> = {}): Record<string, string> => {
    if (o !== null && typeof o === 'object' && !Array.isArray(o)) { for (const [k, v] of Object.entries(o as object)) flat(v, p ? `${p}.${k}` : k, out); }
    else if (Array.isArray(o) && o.some((x) => x !== null && typeof x === 'object')) o.forEach((v, i) => flat(v, `${p}[${i}]`, out));
    else out[p || '(value)'] = JSON.stringify(o);
    return out;
  };
  const a = flat(before ?? {}), b = flat(after ?? {});
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  const changed = keys.filter((k) => a[k] !== b[k]);
  if (!before) return <p className="muted small">There is no active version to compare with: this will be a new configuration item.</p>;
  if (!changed.length) return <p className="muted small">No differences from the active version.</p>;
  return (
    <div className="table-wrap"><table className="data"><thead><tr><th>Field</th><th>Active version</th><th>This version</th></tr></thead>
      <tbody>{changed.map((k) => <tr key={k}><td className="mono">{k}</td><td className="mono" style={{ color: 'var(--danger-700)' }}>{a[k] ?? <em className="muted">absent</em>}</td><td className="mono" style={{ color: 'var(--ok-700)' }}>{b[k] ?? <em className="muted">removed</em>}</td></tr>)}</tbody></table></div>
  );
}

export const Section = ({ title, children, intro }: { title: string; intro?: ReactNode; children: ReactNode }) => (
  <div className="form-section"><div className="intro"><h3>{title}</h3>{intro && <p>{intro}</p>}</div><div className="stack">{children}</div></div>
);

/** Serialise filter state to a query string, skipping empty values. */
export const qs = (o: Record<string, string | undefined>) => new URLSearchParams(Object.entries(o).filter(([, v]) => v !== undefined && v !== '') as [string, string][]).toString();
