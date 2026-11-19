import type { ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../../lib/api';
import { duration, humanize } from '../../../lib/format';
import { ErrorAlert, Loading } from '../../../components/ui';

/** All facility-scoped queries share the ['fac', id] prefix so one invalidation refreshes the workspace. */
export const fk = (id: string, ...rest: unknown[]) => ['fac', id, ...rest];
export function useFac<T = any>(id: string, part: string, url: string, enabled = true) {
  return useQuery<T>({ queryKey: fk(id, part), queryFn: () => api.get<T>(url), enabled });
}
export function useRefresh(id: string) {
  const qc = useQueryClient();
  return () => Promise.all([qc.invalidateQueries({ queryKey: ['fac', id] }), qc.invalidateQueries({ queryKey: ['tasks'] })]);
}

export function SlaBadge({ sla }: { sla?: { state: string; remainingMs?: number; paused?: boolean; escalationLevel?: number } }) {
  if (!sla || sla.state === 'NONE') return <span className="muted small">No SLA</span>;
  const tone = sla.state === 'BREACHED' ? 'danger' : sla.state === 'WARNING' ? 'warn' : 'ok';
  return (
    <span className={`badge ${tone}`} title={sla.paused ? 'SLA paused awaiting clarification' : undefined}>
      {sla.paused ? 'Paused' : sla.remainingMs !== undefined ? duration(sla.remainingMs) : humanize(sla.state)}
      {sla.escalationLevel ? ` · escalated ${sla.escalationLevel}` : ''}
    </span>
  );
}

export function QueryState({ q, children, empty }: { q: { isLoading: boolean; error: unknown; data?: unknown }; children: () => ReactNode; empty?: ReactNode }) {
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorAlert error={q.error} />;
  if (empty && (q.data === null || q.data === undefined || (Array.isArray(q.data) && !q.data.length))) return <>{empty}</>;
  return <>{children()}</>;
}

export const fmtRatio = (v: number | null | undefined, unit?: string) =>
  v === null || v === undefined ? '—' : unit === '%' ? `${Number(v).toFixed(1)}%` : unit === 'days' ? `${Math.round(v)} days` : unit === 'x' ? `${Number(v).toFixed(2)}×` : Number(v).toLocaleString('en-NG', { maximumFractionDigits: 2 });

export function Section({ title, sub, children, actions }: { title: string; sub?: ReactNode; children: ReactNode; actions?: ReactNode }) {
  return (
    <div className="stack" style={{ ['--gap' as any]: '10px' }}>
      <div className="row between"><div><h3>{title}</h3>{sub && <div className="small muted">{sub}</div>}</div>{actions && <div className="row">{actions}</div>}</div>
      {children}
    </div>
  );
}
