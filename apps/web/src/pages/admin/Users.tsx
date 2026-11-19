import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { dateTime, money } from '../../lib/format';
import { Alert, Button, Drawer, Empty, ErrorAlert, KV, Loading, PageHeader, Panel, SelectInput, Status, Tabs, TextArea, TextInput, useAction } from '../../components/ui';
import { NairaField, useReference, useRoles } from './parts/common';
import { StaffImport } from './parts/StaffImport';

interface User { id: string; username: string; name: string; email: string; staffNumber: string | null; directorate: string | null; businessUnit: string | null; status: string; mfaEnrolled: boolean; lastLoginAt: string | null; isDemo: boolean; roles: string[]; limits: { role: string; limitMinor: number }[]; sectors?: string[] }

export default function Users() {
  const [tab, setTab] = useState('users');
  const reqs = useQuery({ queryKey: ['admin', 'access-requests'], queryFn: () => api.get<any[]>('/api/admin/access-requests') });
  const pending = reqs.data?.filter((r) => r.status === 'PENDING').length ?? 0;
  return (
    <>
      <PageHeader eyebrow="Control centre" title="Users & access" sub="Staff sign in through Active Directory with multi-factor authentication. Gazelle controls roles, limits and portfolios. Every change is audited."
        actions={<a className="btn" href="/api/admin/users/export.xlsx" download>Export users (Excel)</a>} />
      <Tabs value={tab} onChange={setTab} tabs={[{ key: 'users', label: 'Staff users' }, { key: 'requests', label: `Access requests${pending ? ` (${pending})` : ''}`, flag: pending > 0 }, { key: 'customers', label: 'Customer portfolios' }, { key: 'import', label: 'Import from spreadsheet' }]} />
      {tab === 'users' && <UserTable />}
      {tab === 'requests' && <AccessRequests q={reqs} />}
      {tab === 'customers' && <Portfolios />}
      {tab === 'import' && <StaffImport />}
    </>
  );
}

function UserTable() {
  const users = useQuery({ queryKey: ['admin', 'users'], queryFn: () => api.get<User[]>('/api/admin/users') });
  const [filter, setFilter] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const rows = useMemo(() => (users.data ?? []).filter((u) => !filter || `${u.name} ${u.username} ${u.roles.join(' ')} ${u.businessUnit}`.toLowerCase().includes(filter.toLowerCase())), [users.data, filter]);
  const sel = users.data?.find((u) => u.id === selected);
  return (
    <Panel title={`${users.data?.length ?? ''} staff users`} actions={<><input className="input" style={{ width: 220 }} aria-label="Filter users" placeholder="Filter by name, role or unit" value={filter} onChange={(e) => setFilter(e.target.value)} /><Button size="sm" variant="primary" onClick={() => setCreating(true)}>Add user</Button></>} flush>
      {users.isLoading ? <Loading rows={6} /> : users.error ? <ErrorAlert error={users.error} /> : !rows.length ? <Empty title="No users match" /> : (
        <div className="table-wrap"><table className="data">
          <thead><tr><th>Name</th><th>Roles</th><th>Business unit</th><th>Status</th><th>MFA</th><th>Last sign-in</th></tr></thead>
          <tbody>{rows.map((u) => (
            <tr key={u.id} className="clickable" onClick={() => setSelected(u.id)} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && setSelected(u.id)}>
              <td className="primary-cell">{u.name}<div className="xs muted">{u.username}{u.isDemo && ' · DEMO'}</div></td>
              <td className="small">{u.roles.join(', ') || <span className="muted">None</span>}</td>
              <td className="small">{u.businessUnit ?? '—'}</td>
              <td><Status value={u.status} /></td>
              <td>{u.mfaEnrolled ? <Status value="ACTIVE" label="Enrolled" /> : <Status value="PENDING" label="Not enrolled" />}</td>
              <td className="small nowrap">{dateTime(u.lastLoginAt)}</td>
            </tr>))}</tbody>
        </table></div>
      )}
      {sel && <UserDrawer user={sel} onClose={() => setSelected(null)} />}
      {creating && <CreateUser onClose={() => setCreating(false)} />}
    </Panel>
  );
}

function CreateUser({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const ref = useReference();
  const [f, setF] = useState({ username: '', name: '', email: '', staffNumber: '', directorate: '', businessUnit: '' });
  const save = useAction(async () => { await api.post('/api/admin/users', { ...f, staffNumber: f.staffNumber || undefined }); await qc.invalidateQueries({ queryKey: ['admin', 'users'] }); onClose(); });
  const bus = (ref.data?.businessUnits ?? []).filter((b) => !f.directorate || b.directorate === f.directorate);
  return (
    <Drawer title="Add staff user" onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={save.loading} onClick={() => save.run()} disabled={!f.username || !f.name || !f.email || !f.directorate || !f.businessUnit}>Create user</Button></>}>
      <div className="stack">
        <Alert tone="info">The username must match the officer's Active Directory account. Grant roles after creating the user.</Alert>
        <TextInput label="AD username" required value={f.username} onChange={(e) => setF({ ...f, username: e.target.value })} />
        <TextInput label="Full name" required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        <TextInput label="Email" type="email" required value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
        <TextInput label="Staff number" value={f.staffNumber} onChange={(e) => setF({ ...f, staffNumber: e.target.value })} />
        <SelectInput label="Directorate" required placeholder="Select" value={f.directorate} options={(ref.data?.directorates ?? []).map((d) => ({ value: d.code, label: d.name }))} onChange={(e) => setF({ ...f, directorate: e.target.value, businessUnit: '' })} />
        <SelectInput label="Business unit" required placeholder="Select" value={f.businessUnit} options={bus.map((b) => ({ value: b.code, label: b.name }))} onChange={(e) => setF({ ...f, businessUnit: e.target.value })} />
        <ErrorAlert error={save.error} />
      </div>
    </Drawer>
  );
}

function UserDrawer({ user, onClose }: { user: User; onClose: () => void }) {
  const qc = useQueryClient();
  const { me, meta } = useAuth();
  const ref = useReference();
  const localAuth = meta?.staffAuthMode === 'local';
  const sendLink = useAction(async (purpose: 'ACTIVATE' | 'RESET') => { const r = await api.post<any>(`/api/admin/users/${user.id}/credential-link`, { purpose }); setNotice(`${purpose === 'ACTIVATE' ? 'Activation' : 'Password reset'} link sent to ${r.sentTo}.${purpose === 'RESET' ? ' The current password no longer works and the user has been signed out.' : ''}`); });
  const roles = useRoles();
  const self = me?.user?.id === user.id;
  const refresh = () => qc.invalidateQueries({ queryKey: ['admin'] });
  const [details, setDetails] = useState({ name: user.name, directorate: user.directorate ?? '', businessUnit: user.businessUnit ?? '', status: user.status, reason: '' });
  const [roleForm, setRoleForm] = useState({ role: '', reason: '' });
  const [limit, setLimit] = useState<{ role: string; limitMinor?: number; reason: string }>({ role: user.roles[0] ?? '', reason: '' });
  const [sectors, setSectors] = useState<string[]>(user.sectors ?? []);
  const [notice, setNotice] = useState<string | null>(null);
  const saveDetails = useAction(async () => { await api.patch(`/api/admin/users/${user.id}`, { name: details.name, directorate: details.directorate || undefined, businessUnit: details.businessUnit || undefined, status: details.status, reason: details.reason }); setNotice('Details saved.'); await refresh(); });
  const changeRole = useAction(async (change: 'GRANT_ROLE' | 'REVOKE_ROLE', role: string) => {
    const r = await api.post<{ pendingApproval: boolean }>(`/api/admin/users/${user.id}/roles`, { change, role, reason: roleForm.reason });
    setNotice(r.pendingApproval ? `${role} is a privileged role: the request now needs approval by a second administrator.` : `${change === 'GRANT_ROLE' ? 'Granted' : 'Revoked'} ${role}. The user's sessions were ended so the change applies immediately.`);
    setRoleForm({ role: '', reason: roleForm.reason }); await refresh();
  });
  const saveLimit = useAction(async () => { await api.post(`/api/admin/users/${user.id}/limits`, { role: limit.role, limitMinor: limit.limitMinor ?? 0, reason: limit.reason }); setNotice('Approval limit recorded.'); await refresh(); });
  const saveSectors = useAction(async () => { await api.post(`/api/admin/users/${user.id}/sectors`, { sectors }); setNotice('Sector assignment saved.'); });
  const roleInfo = (code: string) => roles.data?.find((r) => r.code === code);
  const err = saveDetails.error ?? changeRole.error ?? saveLimit.error ?? saveSectors.error;
  return (
    <Drawer title={user.name} onClose={onClose}>
      <div className="stack">
        {self && <Alert tone="warn">This is your own account. You cannot change your own roles, limits or status.</Alert>}
        {notice && <Alert tone="ok">{notice}</Alert>}
        {localAuth && !self && (
          <div className="panel" style={{ padding: 12 }}>
            <div className="small" style={{ fontWeight: 500 }}>Interim Gazelle sign-in</div>
            <p className="xs muted" style={{ margin: '4px 0 8px' }}>The user sets their own password from a single-use link sent to their work e-mail. Administrators never see or set passwords.</p>
            <div className="row"><Button size="sm" onClick={() => sendLink.run('ACTIVATE')} loading={sendLink.loading}>Send activation link</Button><Button size="sm" variant="danger" onClick={() => sendLink.run('RESET')} loading={sendLink.loading}>Reset password</Button></div>
            <ErrorAlert error={sendLink.error} />
          </div>
        )}
        <ErrorAlert error={err} />
        <KV items={[['Username', user.username], ['Email', user.email], ['Staff number', user.staffNumber ?? '—'], ['MFA', user.mfaEnrolled ? 'Enrolled' : 'Not yet enrolled'], ['Last sign-in', dateTime(user.lastLoginAt)]]} />

        <h4>Details</h4>
        <TextInput label="Full name" value={details.name} onChange={(e) => setDetails({ ...details, name: e.target.value })} />
        <div className="grid cols-2">
          <SelectInput label="Directorate" value={details.directorate} options={(ref.data?.directorates ?? []).map((d) => ({ value: d.code, label: d.name }))} onChange={(e) => setDetails({ ...details, directorate: e.target.value })} />
          <SelectInput label="Business unit" value={details.businessUnit} options={(ref.data?.businessUnits ?? []).map((b) => ({ value: b.code, label: b.name }))} onChange={(e) => setDetails({ ...details, businessUnit: e.target.value })} />
        </div>
        <SelectInput label="Status" value={details.status} disabled={self} options={[{ value: 'ACTIVE', label: 'Active' }, { value: 'SUSPENDED', label: 'Suspended' }, { value: 'INACTIVE', label: 'Inactive' }]} onChange={(e) => setDetails({ ...details, status: e.target.value })} hint="Suspending or deactivating ends all of the user's sessions." />
        <TextArea label="Reason for change" rows={2} value={details.reason} onChange={(e) => setDetails({ ...details, reason: e.target.value })} />
        <div><Button variant="primary" loading={saveDetails.loading} disabled={details.reason.trim().length < 5} onClick={() => saveDetails.run()}>Save details</Button></div>

        <hr className="divider" />
        <h4>Roles</h4>
        <table className="data"><tbody>{user.roles.map((r) => (
          <tr key={r}><td>{roleInfo(r)?.name ?? r} <span className="xs muted mono">{r}</span>{roleInfo(r)?.privileged && <span className="tag" style={{ marginLeft: 6 }}>privileged</span>}</td>
            <td className="num"><Button size="sm" variant="danger" disabled={self || roleForm.reason.trim().length < 10} loading={changeRole.loading} onClick={() => changeRole.run('REVOKE_ROLE', r)}>Revoke</Button></td></tr>))}
          {!user.roles.length && <tr><td className="muted">No roles granted.</td></tr>}</tbody></table>
        <div className="grid cols-2" style={{ alignItems: 'end' }}>
          <SelectInput label="Grant role" placeholder="Select a role" value={roleForm.role} disabled={self}
            options={(roles.data ?? []).filter((r) => !user.roles.includes(r.code)).map((r) => ({ value: r.code, label: `${r.name}${r.privileged ? ' — requires second approval' : ''}` }))}
            onChange={(e) => setRoleForm({ ...roleForm, role: e.target.value })} />
          <Button disabled={self || !roleForm.role || roleForm.reason.trim().length < 10} loading={changeRole.loading} onClick={() => changeRole.run('GRANT_ROLE', roleForm.role)}>Grant</Button>
        </div>
        <TextArea label="Reason for role change" hint="Required for grants and revocations (min. 10 characters)." rows={2} value={roleForm.reason} onChange={(e) => setRoleForm({ ...roleForm, reason: e.target.value })} />

        <hr className="divider" />
        <h4>Personal approval limits</h4>
        <p className="small muted">A personal limit can only narrow the authority of the approval level. Above it, the officer may recommend but not approve.</p>
        {user.limits.length > 0 && <KV items={user.limits.map((l) => [l.role, money(l.limitMinor)])} />}
        <div className="grid cols-2">
          <SelectInput label="Role" value={limit.role} options={user.roles.map((r) => ({ value: r, label: r }))} onChange={(e) => setLimit({ ...limit, role: e.target.value })} />
          <NairaField label="Limit" minor={limit.limitMinor} onChange={(m) => setLimit({ ...limit, limitMinor: m })} />
        </div>
        <TextArea label="Reason" rows={2} value={limit.reason} onChange={(e) => setLimit({ ...limit, reason: e.target.value })} />
        <div><Button disabled={self || !limit.role || limit.limitMinor === undefined || limit.reason.trim().length < 10} loading={saveLimit.loading} onClick={() => saveLimit.run()}>Set limit</Button></div>

        <hr className="divider" />
        <h4>Sector assignment</h4>
        <p className="small muted">Replaces the officer's current sector assignment.</p>
        <div className="grid cols-2" style={{ gap: 6 }}>
          {(ref.data?.sectors ?? []).filter((s) => !s.code.startsWith('EXCLUDED_')).map((s) => (
            <label key={s.code} className="check small"><input type="checkbox" checked={sectors.includes(s.code)} onChange={(e) => setSectors(e.target.checked ? [...sectors, s.code] : sectors.filter((x) => x !== s.code))} /><span>{s.name}</span></label>
          ))}
        </div>
        <div><Button loading={saveSectors.loading} onClick={() => saveSectors.run()}>Save sectors</Button></div>
      </div>
    </Drawer>
  );
}

function AccessRequests({ q }: { q: ReturnType<typeof useQuery<any[]>> }) {
  const qc = useQueryClient();
  const { me } = useAuth();
  const decide = useAction(async (id: string, decision: 'APPROVED' | 'REJECTED') => { await api.post(`/api/admin/access-requests/${id}/decide`, { decision }); await qc.invalidateQueries({ queryKey: ['admin'] }); });
  return (
    <Panel title="Privileged access requests" flush>
      <div style={{ padding: '12px 18px' }}><Alert tone="info">Granting or revoking a privileged role (Administrator, Super Administrator) needs a second administrator. You cannot approve a request you raised or one that changes your own access.</Alert></div>
      <ErrorAlert error={decide.error} />
      {q.isLoading ? <Loading /> : !q.data?.length ? <Empty title="No access requests" /> : (
        <div className="table-wrap"><table className="data"><thead><tr><th>Officer</th><th>Change</th><th>Role</th><th>Reason</th><th>Raised by</th><th>Raised</th><th>Status</th><th /></tr></thead>
          <tbody>{q.data.map((r) => {
            const mine = r.maker === me?.user?.name;
            return (
              <tr key={r.id}><td className="primary-cell">{r.target}</td><td>{r.change === 'GRANT_ROLE' ? 'Grant' : 'Revoke'}</td><td className="mono small">{r.role}</td><td className="small" style={{ maxWidth: 260 }}>{r.reason}</td><td className="small">{r.maker}</td><td className="small nowrap">{dateTime(r.createdAt)}</td><td><Status value={r.status} /></td>
                <td className="num nowrap">{r.status === 'PENDING' && (mine ? <span className="xs muted">Awaiting another administrator</span> : <><Button size="sm" variant="primary" loading={decide.loading} onClick={() => decide.run(r.id, 'APPROVED')}>Approve</Button> <Button size="sm" variant="danger" onClick={() => decide.run(r.id, 'REJECTED')}>Reject</Button></>)}</td></tr>);
          })}</tbody></table></div>
      )}
    </Panel>
  );
}

function Portfolios() {
  const qc = useQueryClient();
  const customers = useQuery({ queryKey: ['admin', 'customers'], queryFn: () => api.get<any[]>('/api/admin/customers') });
  const users = useQuery({ queryKey: ['admin', 'users'], queryFn: () => api.get<User[]>('/api/admin/users') });
  const rms = (users.data ?? []).filter((u) => u.roles.includes('RM') && u.status === 'ACTIVE');
  const [target, setTarget] = useState<any>(null);
  const [form, setForm] = useState({ userId: '', reason: '' });
  const blocks = useQuery({ queryKey: ['admin', 'block-requests'], queryFn: () => api.get<any[]>('/api/admin/customer-block-requests'), retry: false });
  const [blockTarget, setBlockTarget] = useState<any>(null);
  const [blockReason, setBlockReason] = useState('');
  const refreshAll = () => Promise.all([qc.invalidateQueries({ queryKey: ['admin', 'customers'] }), qc.invalidateQueries({ queryKey: ['admin', 'block-requests'] })]);
  const block = useAction(async () => { await api.post(`/api/admin/customers/${blockTarget.id}/${blockTarget.status === 'SUSPENDED' ? 'unblock' : 'block'}`, { reason: blockReason }); setBlockTarget(null); await refreshAll(); });
  const decide = useAction(async (id: string, decision: 'APPROVE' | 'REJECT') => { await api.post(`/api/admin/customer-block-requests/${id}/decide`, { decision }); await refreshAll(); });
  const pendingUnblocks = (blocks.data ?? []).filter((r) => r.status === 'PENDING');
  const assign = useAction(async () => { await api.post(`/api/admin/customers/${target.id}/relationship-manager`, form); setTarget(null); await qc.invalidateQueries({ queryKey: ['admin', 'customers'] }); });
  return (
    <Panel title="Customer portfolios" flush>
      {customers.isLoading ? <Loading /> : customers.error ? <ErrorAlert error={customers.error} /> : !customers.data?.length ? <Empty title="No customers onboarded yet" /> : (
        <div className="table-wrap"><table className="data"><thead><tr><th>Customer</th><th>Reference</th><th>Relationship Manager</th><th>Business unit</th><th className="num">Requests</th><th>Status</th><th /></tr></thead>
          <tbody>{customers.data.map((c) => (
            <tr key={c.id}><td className="primary-cell">{c.name}{c.isDemo && <span className="xs muted"> · DEMO</span>}</td><td className="mono small">{c.ref}</td><td>{c.rm ?? <span className="muted">Unassigned</span>}</td><td className="small">{c.businessUnit ?? '—'}</td><td className="num">{c.facilities}</td><td><Status value={c.status} /></td>
              <td className="num"><div className="row end"><Button size="sm" onClick={() => { setTarget(c); setForm({ userId: '', reason: '' }); }}>Reassign</Button>
                <Button size="sm" variant={c.status === 'SUSPENDED' ? undefined : 'danger'} disabled={pendingUnblocks.some((r) => r.customerId === c.id)} onClick={() => { setBlockTarget(c); setBlockReason(''); }}>{c.status === 'SUSPENDED' ? 'Request unblock' : 'Block'}</Button></div></td></tr>))}</tbody></table></div>
      )}
      {pendingUnblocks.length > 0 && (
        <div className="panel-body">
          <h4>Unblock requests awaiting a second administrator</h4>
          <ErrorAlert error={decide.error} />
          <table className="data"><thead><tr><th>Customer</th><th>Reason</th><th>Requested by</th><th /></tr></thead>
            <tbody>{pendingUnblocks.map((r) => <tr key={r.id}><td>{r.customerName}</td><td className="small">{r.reason}</td><td className="small">{r.requestedBy} · {dateTime(r.createdAt)}</td>
              <td className="num"><div className="row end"><Button size="sm" onClick={() => decide.run(r.id, 'REJECT')}>Reject</Button><Button size="sm" variant="primary" onClick={() => decide.run(r.id, 'APPROVE')}>Approve unblock</Button></div></td></tr>)}</tbody></table>
        </div>
      )}
      {blockTarget && (
        <Drawer center title={`${blockTarget.status === 'SUSPENDED' ? 'Request unblock' : 'Block'} — ${blockTarget.name}`} onClose={() => setBlockTarget(null)}
          footer={<><Button onClick={() => setBlockTarget(null)}>Cancel</Button><Button variant={blockTarget.status === 'SUSPENDED' ? 'primary' : 'danger'} loading={block.loading} disabled={blockReason.trim().length < 10} onClick={() => block.run()}>{blockTarget.status === 'SUSPENDED' ? 'Submit for approval' : 'Block access now'}</Button></>}>
          <div className="stack">
            <p className="small muted">{blockTarget.status === 'SUSPENDED' ? 'Unblocking takes effect only after a second administrator approves.' : 'Blocking takes effect immediately and signs the customer out of every device.'}</p>
            <TextArea label="Reason" rows={3} value={blockReason} onChange={(e) => setBlockReason(e.target.value)} hint="At least 10 characters. Recorded in the audit log." />
            <ErrorAlert error={block.error} />
          </div>
        </Drawer>
      )}
      {target && (
        <Drawer center title={`Relationship Manager — ${target.name}`} onClose={() => setTarget(null)} footer={<><Button onClick={() => setTarget(null)}>Cancel</Button><Button variant="primary" loading={assign.loading} disabled={!form.userId || form.reason.trim().length < 5} onClick={() => assign.run()}>Assign</Button></>}>
          <div className="stack">
            <SelectInput label="Relationship Manager" placeholder="Select" value={form.userId} options={rms.map((u) => ({ value: u.id, label: `${u.name} (${u.businessUnit ?? '—'})` }))} onChange={(e) => setForm({ ...form, userId: e.target.value })} />
            <TextArea label="Reason" rows={2} value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} />
            <ErrorAlert error={assign.error} />
          </div>
        </Drawer>
      )}
    </Panel>
  );
}
