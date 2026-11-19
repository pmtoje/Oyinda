import { useMemo } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { dateTime, humanize } from '../../lib/format';
import { Button, Empty, ErrorAlert, Loading, PageHeader, Panel, SelectInput, Status, Tabs, TextInput } from '../../components/ui';
import { SlaBadge } from './parts/common';

/**
 * My tasks / Team queue / Completed. Search, filters and sort live in the URL, so a view can be shared and
 * survives going back from a facility. Lists are bounded per user, so sorting and filtering happen in the browser.
 */
type Task = {
  id: string; facilityId: string; facilityRef: string; customerName: string; productName: string; amountText: string | null; amountMinor: number | null; currency: string;
  stageName: string; taskType: string; role: string; outcome?: string; assignedTo: string | null; claimedBy: string | null; createdAt: string; completedAt?: string;
  sla: { state: 'NONE' | 'ON_TRACK' | 'WARNING' | 'BREACHED'; dueAt?: string; remainingMs?: number; escalationLevel?: number };
};
type SortKey = 'urgency' | 'facility' | 'customer' | 'stage' | 'amount' | 'holder' | 'opened';
const SORTS: { value: SortKey; label: string }[] = [
  { value: 'urgency', label: 'Most urgent first' }, { value: 'opened', label: 'Opened' }, { value: 'amount', label: 'Amount' },
  { value: 'customer', label: 'Customer' }, { value: 'facility', label: 'Facility reference' }, { value: 'stage', label: 'Stage' }, { value: 'holder', label: 'Holder' },
];
const SLA_RANK: Record<string, number> = { BREACHED: 0, WARNING: 1, ON_TRACK: 2, NONE: 3 };
const SLA_FILTERS = [{ value: 'BREACHED', label: 'SLA breached' }, { value: 'WARNING', label: 'Approaching SLA' }, { value: 'ON_TRACK', label: 'On track' }, { value: 'NONE', label: 'No SLA' }];

/** Priority shown to the user: escalated or breached → High; approaching → Medium; otherwise Normal. */
export const priorityOf = (t: Task) => (t.sla.state === 'BREACHED' || (t.sla.escalationLevel ?? 0) > 0 ? 'HIGH' : t.sla.state === 'WARNING' ? 'MEDIUM' : 'NORMAL');
const PRIORITY_LABEL = { HIGH: 'High', MEDIUM: 'Medium', NORMAL: 'Normal' } as const;
const PRIORITY_STATUS = { HIGH: 'BREACHED', MEDIUM: 'WARNING', NORMAL: 'ON_TRACK' } as const;

const text = (s: string | null | undefined) => (s ?? '').toLocaleLowerCase();
function compare(a: Task, b: Task, key: SortKey, completed: boolean): number {
  switch (key) {
    case 'urgency': {
      if (completed) return new Date(b.completedAt ?? 0).getTime() - new Date(a.completedAt ?? 0).getTime();
      const r = SLA_RANK[a.sla.state]! - SLA_RANK[b.sla.state]!;
      return r || (a.sla.remainingMs ?? Infinity) - (b.sla.remainingMs ?? Infinity);
    }
    case 'opened': return new Date(completed ? a.completedAt ?? 0 : a.createdAt).getTime() - new Date(completed ? b.completedAt ?? 0 : b.createdAt).getTime();
    // Amounts compare within a currency; currencies group alphabetically (no implicit FX conversion in a list).
    case 'amount': return a.currency !== b.currency ? a.currency.localeCompare(b.currency) : (a.amountMinor ?? 0) - (b.amountMinor ?? 0);
    case 'customer': return text(a.customerName).localeCompare(text(b.customerName));
    case 'facility': return a.facilityRef.localeCompare(b.facilityRef);
    case 'stage': return text(a.stageName).localeCompare(text(b.stageName));
    case 'holder': return text(a.claimedBy ?? a.assignedTo ?? '~').localeCompare(text(b.claimedBy ?? b.assignedTo ?? '~'));
  }
}

export default function Tasks() {
  const loc = useLocation();
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const scope = params.get('view') ?? (loc.pathname.endsWith('/queue') ? 'queue' : 'mine');
  const completed = scope === 'completed';
  const search = params.get('q') ?? '';
  const sla = params.get('sla') ?? '';
  const stage = params.get('stage') ?? '';
  const product = params.get('product') ?? '';
  const sort = (params.get('sort') as SortKey) || 'urgency';
  const dir = params.get('dir') === 'desc' ? -1 : 1;
  const set = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) { if (v) next.set(k, v); else next.delete(k); }
    setParams(next, { replace: true });
  };

  const q = useQuery({ queryKey: ['tasks', scope], queryFn: () => api.get<Task[]>(`/api/tasks?scope=${scope}`, { passive: true }), refetchInterval: 60_000 });
  const all = useMemo(() => q.data ?? [], [q.data]);
  const stages = useMemo(() => [...new Set(all.map((t) => t.stageName))].sort(), [all]);
  const products = useMemo(() => [...new Set(all.map((t) => t.productName))].sort(), [all]);
  const rows = useMemo(() => {
    const needle = text(search.trim());
    return all
      .filter((t) => !needle || [t.facilityRef, t.customerName, t.productName, t.stageName, t.claimedBy, t.assignedTo, t.amountText].some((v) => text(v).includes(needle)))
      .filter((t) => !sla || t.sla.state === sla)
      .filter((t) => !stage || t.stageName === stage)
      .filter((t) => !product || t.productName === product)
      .sort((a, b) => dir * compare(a, b, sort, completed) || a.facilityRef.localeCompare(b.facilityRef));
  }, [all, search, sla, stage, product, sort, dir, completed]);
  const filtered = !!(search || sla || stage || product);
  const breached = all.filter((t) => t.sla.state === 'BREACHED').length;
  const warning = all.filter((t) => t.sla.state === 'WARNING').length;

  const titles: Record<string, [string, string]> = {
    mine: ['My tasks', 'Tasks you hold or that are assigned to you, most urgent first.'],
    queue: ['Team queue', 'Unclaimed tasks for your roles. Claim a task to work on it.'],
    completed: ['Completed', 'Tasks you completed recently.'],
  };
  const header = (key: SortKey, label: string, cls?: string) => {
    const active = sort === key;
    return (
      <th className={cls} aria-sort={active ? (dir === 1 ? 'ascending' : 'descending') : 'none'}>
        <button type="button" className="th-sort" onClick={() => set({ sort: key === 'urgency' && !active ? null : key, dir: active && dir === 1 ? 'desc' : null })}>
          {label}<span aria-hidden className="sort-mark">{active ? (dir === 1 ? '▲' : '▼') : '↕'}</span>
        </button>
      </th>
    );
  };

  return (
    <>
      <PageHeader title={titles[scope]![0]} sub={titles[scope]![1]} />
      <Tabs tabs={[{ key: 'mine', label: 'My tasks' }, { key: 'queue', label: 'Team queue' }, { key: 'completed', label: 'Completed' }]} value={scope}
        onChange={(k) => setParams(k === (loc.pathname.endsWith('/queue') ? 'queue' : 'mine') ? {} : { view: k }, { replace: true })} />
      {!completed && all.length > 0 && (
        <div className="grid cols-3" style={{ marginBottom: 16 }}>
          <button type="button" className={`metric metric-button${!sla ? ' selected' : ''}`} onClick={() => set({ sla: null })}><div className="label">Open</div><div className="value">{all.length}</div></button>
          <button type="button" className={`metric metric-button${sla === 'WARNING' ? ' selected' : ''}`} aria-pressed={sla === 'WARNING'} onClick={() => set({ sla: sla === 'WARNING' ? null : 'WARNING' })}><div className="label">Approaching SLA</div><div className="value">{warning}</div></button>
          <button type="button" className={`metric metric-button${breached ? ' metric-alert' : ''}${sla === 'BREACHED' ? ' selected' : ''}`} aria-pressed={sla === 'BREACHED'} onClick={() => set({ sla: sla === 'BREACHED' ? null : 'BREACHED' })}><div className="label">SLA breached</div><div className="value">{breached}</div></button>
        </div>)}
      <Panel flush>
        {all.length > 0 && (
          <div className="queue-filters" role="search" aria-label="Filter tasks">
            <TextInput label="Search" type="search" placeholder="Reference, customer, product, stage, holder" value={search} onChange={(e) => set({ q: e.target.value })} />
            {!completed && <SelectInput label="SLA" value={sla} placeholder="All" options={SLA_FILTERS} onChange={(e) => set({ sla: e.target.value })} />}
            <SelectInput label="Stage" value={stage} placeholder="All stages" options={stages.map((s) => ({ value: s, label: s }))} onChange={(e) => set({ stage: e.target.value })} />
            <SelectInput label="Product" value={product} placeholder="All products" options={products.map((s) => ({ value: s, label: s }))} onChange={(e) => set({ product: e.target.value })} />
            <SelectInput label="Sort by" value={sort} options={completed ? [{ value: 'urgency', label: 'Most recent first' }, ...SORTS.slice(1)] : SORTS} onChange={(e) => set({ sort: e.target.value === 'urgency' ? null : e.target.value, dir: null })} />
          </div>
        )}
        {q.isLoading ? <Loading /> : q.error ? <ErrorAlert error={q.error} /> : !all.length ? (
          <Empty title={scope === 'mine' ? 'No tasks with you' : scope === 'queue' ? 'The queue is clear' : 'Nothing completed yet'}>{scope === 'mine' ? 'New tasks appear here when they are assigned to you or you claim them from the team queue.' : undefined}</Empty>
        ) : (
          <>
            <p className="queue-count small muted" role="status" aria-live="polite">
              {filtered ? `Showing ${rows.length} of ${all.length} tasks` : `${all.length} ${all.length === 1 ? 'task' : 'tasks'}`}
              {filtered && <> · <Button size="sm" variant="ghost" onClick={() => set({ q: null, sla: null, stage: null, product: null })}>Clear filters</Button></>}
            </p>
            {!rows.length ? <Empty title="No tasks match">Change the search or filters.</Empty> : (
              <div className="table-wrap"><table className="data">
                <thead><tr>
                  {header('facility', 'Facility')}{header('customer', 'Customer')}{header('stage', 'Stage')}{header('amount', 'Amount', 'num')}{header('holder', 'Holder')}
                  {completed ? <th>Outcome</th> : header('urgency', 'Priority / SLA')}{header('opened', completed ? 'Completed' : 'Opened')}
                </tr></thead>
                <tbody>{rows.map((t) => {
                  const p = priorityOf(t);
                  const open = () => nav(`/work/facilities/${t.facilityId}?task=${t.id}`);
                  return (
                    <tr key={t.id} className="clickable" tabIndex={0} onClick={open} onKeyDown={(e) => e.key === 'Enter' && open()}>
                      <td className="primary-cell mono">{t.facilityRef}</td><td>{t.customerName}<div className="xs muted">{t.productName}</div></td>
                      <td>{t.stageName}<div className="xs muted">{humanize(t.taskType)}</div></td><td className="num">{t.amountText}</td>
                      <td className="small">{t.claimedBy ?? t.assignedTo ?? <Status value="OPEN" label="Unclaimed" />}</td>
                      <td>{completed ? <Status value={t.outcome === 'APPROVE' ? 'APPROVED' : t.outcome === 'DECLINE' ? 'DECLINED' : 'COMPLETED'} label={humanize(t.outcome)} /> : (
                        <div className="stack-xs">{p !== 'NORMAL' && <Status value={PRIORITY_STATUS[p]} label={`${PRIORITY_LABEL[p]} priority`} />}<SlaBadge sla={t.sla} /></div>)}</td>
                      <td className="small">{dateTime(completed ? t.completedAt : t.createdAt)}</td>
                    </tr>);
                })}</tbody></table></div>)}
          </>
        )}
      </Panel>
    </>
  );
}
