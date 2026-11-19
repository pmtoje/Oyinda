import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { date, humanize } from '../../lib/format';
import { Button, Drawer, Empty, ErrorAlert, Loading, PageHeader, Panel, Status, Tabs, TextArea, useAction } from '../../components/ui';

export default function Monitoring() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const [status, setStatus] = useState('OPEN');
  const [resolving, setResolving] = useState<any>(null);
  const q = useQuery({ queryKey: ['monitoring', status], queryFn: () => api.get<any[]>(`/api/monitoring?status=${status}`) });
  const rows = q.data ?? [];
  const count = (s: string) => rows.filter((r) => r.severity === s).length;
  return (
    <>
      <PageHeader title="Portfolio monitoring" sub="Overdue payments, maturities, reviews, covenants, security expiry and financial statement refresh." />
      <Tabs tabs={[{ key: 'OPEN', label: 'Open' }, { key: 'RESOLVED', label: 'Resolved' }]} value={status} onChange={setStatus} />
      {status === 'OPEN' && rows.length > 0 && <div className="grid cols-3" style={{ marginBottom: 16 }}><div className={count('CRITICAL') ? 'metric metric-alert' : 'metric'}><div className="label">Critical</div><div className="value">{count('CRITICAL')}</div></div><div className="metric"><div className="label">Warning</div><div className="value">{count('WARNING')}</div></div><div className="metric"><div className="label">Information</div><div className="value">{count('INFO')}</div></div></div>}
      <Panel flush>
        {q.isLoading ? <Loading /> : q.error ? <ErrorAlert error={q.error} /> : !rows.length ? <Empty title={status === 'OPEN' ? 'No open monitoring items' : 'Nothing resolved yet'} /> : (
          <div className="table-wrap"><table className="data"><thead><tr><th>Severity</th><th>Item</th><th>Facility</th><th>Due</th><th /></tr></thead>
            <tbody>{rows.map((m) => <tr key={m.id}><td><span className={`sev ${m.severity === 'CRITICAL' ? 'HIGH' : m.severity === 'WARNING' ? 'MEDIUM' : 'LOW'}`}>{m.severity}</span></td><td><strong className="small">{humanize(m.kind)}</strong><div className="small">{m.detail}</div></td><td><Link to={`/work/facilities/${m.facilityId}?tab=account`} className="mono small">{m.facilityRef}</Link><div className="xs muted">{m.customer}</div></td><td className="small">{date(m.dueDate)}</td>
              <td className="num">{status === 'OPEN' && can('monitoring.manage') ? <Button size="sm" onClick={() => setResolving(m)}>Resolve</Button> : <Status value={m.status} />}</td></tr>)}</tbody></table></div>)}
      </Panel>
      {resolving && <ResolveDrawer item={resolving} onClose={() => setResolving(null)} onDone={async () => { setResolving(null); await qc.invalidateQueries({ queryKey: ['monitoring'] }); }} />}
    </>
  );
}

function ResolveDrawer({ item, onClose, onDone }: { item: any; onClose: () => void; onDone: () => void }) {
  const [note, setNote] = useState('');
  const go = useAction(async () => { await api.post(`/api/monitoring/${item.id}/resolve`, { note }); onDone(); });
  return (
    <Drawer title={`Resolve: ${humanize(item.kind)}`} onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={note.trim().length < 5} loading={go.loading} onClick={() => go.run()}>Resolve</Button></>}>
      <div className="stack"><p className="small">{item.detail}</p><TextArea label="Resolution note" value={note} onChange={(e) => setNote(e.target.value)} required /><ErrorAlert error={go.error} /></div>
    </Drawer>
  );
}
