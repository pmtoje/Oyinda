import { useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { dateTime, humanize } from '../../lib/format';
import { Empty, ErrorAlert, Loading, PageHeader, Panel, Status, Tabs } from '../../components/ui';
import { SlaBadge } from './parts/common';

export default function Tasks() {
  const loc = useLocation();
  const nav = useNavigate();
  const initial = loc.pathname.endsWith('/queue') ? 'queue' : 'mine';
  const [scope, setScope] = useState(initial);
  const [path, setPath] = useState(loc.pathname);
  if (path !== loc.pathname) { setPath(loc.pathname); setScope(initial); }
  const q = useQuery({ queryKey: ['tasks', scope], queryFn: () => api.get<any[]>(`/api/tasks?scope=${scope}`), refetchInterval: 60_000 });
  const rows = q.data ?? [];
  const breached = rows.filter((t) => t.sla.state === 'BREACHED').length;
  const warning = rows.filter((t) => t.sla.state === 'WARNING').length;
  const titles: Record<string, [string, string]> = { mine: ['My tasks', 'Tasks you hold or that are assigned to you, most urgent first.'], queue: ['Team queue', 'Unclaimed tasks for your roles. Claim a task to work on it.'], completed: ['Completed', 'Tasks you completed recently.'] };
  return (
    <>
      <PageHeader title={titles[scope][0]} sub={titles[scope][1]} />
      <Tabs tabs={[{ key: 'mine', label: 'My tasks' }, { key: 'queue', label: 'Team queue' }, { key: 'completed', label: 'Completed' }]} value={scope} onChange={setScope} />
      {scope !== 'completed' && rows.length > 0 && (
        <div className="grid cols-3" style={{ marginBottom: 16 }}>
          <div className="metric"><div className="label">Open</div><div className="value">{rows.length}</div></div>
          <div className={warning ? 'metric' : 'metric'}><div className="label">Approaching SLA</div><div className="value">{warning}</div></div>
          <div className={breached ? 'metric metric-alert' : 'metric'}><div className="label">SLA breached</div><div className="value">{breached}</div></div>
        </div>)}
      <Panel flush>
        {q.isLoading ? <Loading /> : q.error ? <ErrorAlert error={q.error} /> : !rows.length ? <Empty title={scope === 'mine' ? 'No tasks with you' : scope === 'queue' ? 'The queue is clear' : 'Nothing completed yet'}>{scope === 'mine' ? 'New tasks appear here and in your notifications.' : undefined}</Empty> : (
          <div className="table-wrap"><table className="data">
            <thead><tr><th>Facility</th><th>Customer</th><th>Stage</th><th className="num">Amount</th><th>Holder</th><th>{scope === 'completed' ? 'Outcome' : 'SLA'}</th><th>{scope === 'completed' ? 'Completed' : 'Opened'}</th></tr></thead>
            <tbody>{rows.map((t) => (
              <tr key={t.id} className="clickable" tabIndex={0} onClick={() => nav(`/work/facilities/${t.facilityId}?task=${t.id}`)} onKeyDown={(e) => e.key === 'Enter' && nav(`/work/facilities/${t.facilityId}?task=${t.id}`)}>
                <td className="primary-cell mono">{t.facilityRef}</td><td>{t.customerName}<div className="xs muted">{t.productName}</div></td>
                <td>{t.stageName}<div className="xs muted">{humanize(t.taskType)}</div></td><td className="num">{t.amountText}</td>
                <td className="small">{t.claimedBy ?? t.assignedTo ?? <Status value="OPEN" label="Unclaimed" />}</td>
                <td>{scope === 'completed' ? <Status value={t.outcome === 'APPROVE' ? 'APPROVED' : t.outcome === 'DECLINE' ? 'DECLINED' : 'COMPLETED'} label={humanize(t.outcome)} /> : <SlaBadge sla={t.sla} />}</td>
                <td className="small">{dateTime(scope === 'completed' ? t.completedAt : t.createdAt)}</td>
              </tr>))}</tbody></table></div>)}
      </Panel>
    </>
  );
}
