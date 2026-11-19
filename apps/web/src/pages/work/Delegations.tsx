import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { roleLabel, dateTime, humanize } from '../../lib/format';
import { Alert, Button, Drawer, Empty, ErrorAlert, Loading, PageHeader, Panel, SelectInput, Status, TextArea, TextInput, useAction } from '../../components/ui';

export default function Delegations() {
  const { can, me } = useAuth();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['delegations'], queryFn: () => api.get<any[]>('/api/delegations') });
  const [open, setOpen] = useState(false);
  const decide = useAction(async (id: string, decision: string) => { await api.post(`/api/delegations/${id}/decide`, { decision }); await qc.invalidateQueries({ queryKey: ['delegations'] }); });
  return (
    <>
      <PageHeader title="Delegated authority" sub="Delegate one of your roles for a fixed period (up to 31 days). An administrator must approve before it takes effect; your personal approval limit applies to the delegate." actions={can('task.work') && <Button variant="primary" onClick={() => setOpen(true)}>Request delegation</Button>} />
      <ErrorAlert error={decide.error} />
      <Panel flush>
        {q.isLoading ? <Loading /> : q.error ? <ErrorAlert error={q.error} /> : !q.data!.length ? <Empty title="No delegations" /> : (
          <div className="table-wrap"><table className="data"><thead><tr><th>Role</th><th>From</th><th>To</th><th>Period</th><th>Reason</th><th>Status</th><th /></tr></thead>
            <tbody>{q.data!.map((d) => <tr key={d.id}><td>{roleLabel(d.role)}</td><td>{d.from}</td><td>{d.to}</td><td className="small">{dateTime(d.startsAt)} – {dateTime(d.endsAt)}</td><td className="small">{d.reason}</td><td><Status value={d.status} /></td>
              <td className="num">{can('user.manage') && <div className="row end" style={{ ['--gap' as any]: '6px' }}>{d.status === 'PENDING' && <><Button size="sm" variant="danger" onClick={() => decide.run(d.id, 'REJECTED')}>Reject</Button><Button size="sm" variant="primary" onClick={() => decide.run(d.id, 'ACTIVE')}>Approve</Button></>}{d.status === 'ACTIVE' && <Button size="sm" onClick={() => decide.run(d.id, 'REVOKED')}>Revoke</Button>}</div>}</td></tr>)}</tbody></table></div>)}
      </Panel>
      {open && <RequestDrawer roles={me?.user?.roles ?? []} onClose={() => setOpen(false)} onDone={async () => { setOpen(false); await qc.invalidateQueries({ queryKey: ['delegations'] }); }} />}
    </>
  );
}

function RequestDrawer({ roles, onClose, onDone }: { roles: string[]; onClose: () => void; onDone: () => void }) {
  const staff = useQuery({ queryKey: ['staff-directory'], queryFn: () => api.get<any[]>('/api/staff/directory'), retry: false });
  const [v, setV] = useState({ role: roles[0] ?? '', toUserId: '', startsAt: '', endsAt: '', reason: '' });
  const go = useAction(async () => { await api.post('/api/delegations', { ...v, startsAt: new Date(v.startsAt).toISOString(), endsAt: new Date(v.endsAt).toISOString() }); onDone(); });
  const candidates = (staff.data ?? []).filter((u) => u.status === 'ACTIVE' && u.roles.includes(v.role) === false);
  return (
    <Drawer title="Request delegation" onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!v.toUserId || !v.startsAt || !v.endsAt || v.reason.trim().length < 10} loading={go.loading} onClick={() => go.run()}>Submit for approval</Button></>}>
      <div className="stack">
        <SelectInput label="Role to delegate" value={v.role} onChange={(e) => setV({ ...v, role: e.target.value })} options={roles.map((r) => ({ value: r, label: humanize(r) }))} />
        {staff.data ? <SelectInput label="Delegate to" value={v.toUserId} onChange={(e) => setV({ ...v, toUserId: e.target.value })} placeholder="Select officer" options={candidates.map((u) => ({ value: u.id, label: `${u.name} — ${u.businessUnit ?? ''}` }))} />
          : <Alert tone="info">The staff directory is available only to administrators. Ask your administrator to record the delegation on your behalf.</Alert>}
        <div className="grid cols-2"><TextInput label="From" type="datetime-local" value={v.startsAt} onChange={(e) => setV({ ...v, startsAt: e.target.value })} /><TextInput label="Until" type="datetime-local" value={v.endsAt} onChange={(e) => setV({ ...v, endsAt: e.target.value })} /></div>
        <TextArea label="Reason" value={v.reason} onChange={(e) => setV({ ...v, reason: e.target.value })} required hint="At least 10 characters, e.g. annual leave." />
        <ErrorAlert error={go.error} />
      </div>
    </Drawer>
  );
}
