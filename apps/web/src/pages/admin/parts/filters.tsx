import { useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../../lib/api';
import { Button, MoneyInput, Panel, SelectInput, TextInput } from '../../../components/ui';
import { useReference } from './common';

export const FILTER_KEYS = ['from', 'to', 'product', 'sector', 'directorate', 'status', 'minAmount', 'maxAmount'] as const;
const STATUSES = ['SUBMITTED', 'IN_REVIEW', 'RETURNED', 'APPROVED', 'DECLINED', 'OFFER_ISSUED', 'OFFER_ACCEPTED', 'FULFILMENT', 'ACTIVE', 'WITHDRAWN'];

/** Current filters from the URL as an API query string (amount filters converted ₦ → kobo). */
export function useReportFilters() {
  const [sp] = useSearchParams();
  const out = new URLSearchParams();
  for (const k of FILTER_KEYS) { const v = sp.get(k); if (v) out.set(k, k.endsWith('Amount') ? String(Math.round(Number(v) * 100)) : v); }
  return out.toString();
}

export function ReportFilters({ extra }: { extra?: ReactNode }) {
  const [sp, setSp] = useSearchParams();
  const ref = useReference();
  const products = useQuery({ queryKey: ['products'], queryFn: () => api.get<any[]>('/api/products'), staleTime: 300_000 });
  const [f, setF] = useState<Record<string, string>>(() => Object.fromEntries(FILTER_KEYS.map((k) => [k, sp.get(k) ?? ''])));
  const apply = () => { const n = new URLSearchParams(sp); for (const k of FILTER_KEYS) { if (f[k]) n.set(k, f[k]!); else n.delete(k); } setSp(n); };
  const clear = () => { const e = Object.fromEntries(FILTER_KEYS.map((k) => [k, ''])); setF(e); const n = new URLSearchParams(sp); FILTER_KEYS.forEach((k) => n.delete(k)); setSp(n); };
  const set = (k: string) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const active = FILTER_KEYS.filter((k) => sp.get(k)).length;
  return (
    <Panel title="Filters" actions={active ? <span className="small muted">{active} applied</span> : undefined}>
      <form className="grid cols-4" onSubmit={(e) => { e.preventDefault(); apply(); }}>
        <TextInput label="Submitted from" type="date" value={f.from} onChange={set('from')} />
        <TextInput label="Submitted to" type="date" value={f.to} onChange={set('to')} />
        <SelectInput label="Product" placeholder="All products" value={f.product} options={(products.data ?? []).map((p) => ({ value: p.code, label: p.name }))} onChange={set('product')} />
        <SelectInput label="Sector" placeholder="All sectors" value={f.sector} options={(ref.data?.sectors ?? []).filter((s) => !s.code.startsWith('EXCLUDED_')).map((s) => ({ value: s.code, label: s.name }))} onChange={set('sector')} />
        <SelectInput label="Directorate" placeholder="All directorates" value={f.directorate} options={(ref.data?.directorates ?? []).map((d) => ({ value: d.code, label: d.name }))} onChange={set('directorate')} />
        <SelectInput label="Status" placeholder="All statuses" value={f.status} options={STATUSES.map((s) => ({ value: s, label: s.replace(/_/g, ' ').toLowerCase() }))} onChange={set('status')} />
        <MoneyInput label="Minimum amount" value={f.minAmount} onChange={set('minAmount')} />
        <MoneyInput label="Maximum amount" value={f.maxAmount} onChange={set('maxAmount')} />
        <div className="row" style={{ gridColumn: '1 / -1' }}><Button type="submit" variant="primary">Apply</Button><Button onClick={clear}>Clear</Button>{extra}</div>
      </form>
    </Panel>
  );
}

/** Restrained horizontal bars (no chart library). */
export function Bars({ rows, label, value, format, sub, tone }: { rows: any[]; label: (r: any) => string; value: (r: any) => number; format?: (v: number, r: any) => string; sub?: (r: any) => string; tone?: (r: any) => '' | 'accent' | 'danger' }) {
  if (!rows.length) return <p className="small muted" style={{ margin: 0 }}>No data for the selected filters.</p>;
  const max = Math.max(...rows.map(value), 1);
  return (
    <div role="list">
      {rows.map((r, i) => (
        <div className="bar-row" role="listitem" key={i}>
          <span className="small" title={label(r)} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label(r)}{sub && <span className="xs muted"> · {sub(r)}</span>}</span>
          <span aria-hidden><span className={`bar ${tone?.(r) ?? ''}`} style={{ display: 'block', width: `${(value(r) / max) * 100}%` }} /></span>
          <span className="num small">{format ? format(value(r), r) : value(r).toLocaleString()}</span>
        </div>
      ))}
    </div>
  );
}
