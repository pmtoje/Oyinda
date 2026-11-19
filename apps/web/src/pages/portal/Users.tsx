import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { dateTime } from '../../lib/format';
import { Alert, Button, Check, Drawer, Empty, ErrorAlert, Loading, PageHeader, Panel, Status, TextInput, useAction } from '../../components/ui';

const RIGHTS: [string, string, string][] = [
  ['SUBMIT_REQUESTS', 'Submit requests', 'Submit and resubmit facility requests to the Bank'],
  ['RESPOND_TO_OFFERS', 'Respond to offers', 'Accept, reject or negotiate offer letters on behalf of the business'],
  ['MANAGE_USERS', 'Manage users', 'Invite colleagues, change their access and deactivate them'],
];
const label = (p: string) => RIGHTS.find((r) => r[0] === p)?.[1] ?? p;

function RightsPicker({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  return <div className="stack" style={{ ['--gap' as any]: '6px' }}>{RIGHTS.map(([k, l, d]) => <Check key={k} label={<><strong>{l}</strong> <span className="muted small">— {d}</span></>} checked={value.includes(k)} onChange={(e) => onChange(e.target.checked ? [...value, k] : value.filter((x) => x !== k))} />)}
    <p className="xs muted">Everyone can prepare requests, upload documents, update the business profile and message the Bank.</p></div>;
}

export default function PortalUsers() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['portal-users'], queryFn: () => api.get<any>('/api/portal/users') });
  const [invite, setInvite] = useState(false);
  const [edit, setEdit] = useState<any>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['portal-users'] });
  const revoke = useAction(async (id: string) => { await api.post(`/api/portal/users/invites/${id}/revoke`); await refresh(); });
  const d = q.data;
  return (
    <div className="stack" style={{ ['--gap' as any]: '20px' }}>
      <PageHeader title="Users" sub="People from your business who can use Gazelle. Each person signs in with their own e-mail, password and mobile number."
        actions={d?.canManage && <Button variant="primary" onClick={() => setInvite(true)}>Invite a colleague</Button>} />
      {q.isLoading ? <Loading /> : q.error ? <ErrorAlert error={q.error} /> : (
        <>
          {!d.canManage && <Alert tone="info">Only colleagues with the “Manage users” right can invite people or change access.</Alert>}
          <Panel title="People with access" flush>
            <div className="table-wrap"><table className="data"><thead><tr><th>Name</th><th>Role in the company</th><th>Access</th><th>Status</th>{d.canManage && <th>Last sign-in</th>}<th /></tr></thead>
              <tbody>{d.users.map((u: any) => (
                <tr key={u.id}><td className="primary-cell">{u.name}{u.you && <span className="xs muted"> · you</span>}<div className="xs muted">{u.email}</div></td><td className="small">{u.roleInCompany ?? '—'}{u.primary && <div className="xs muted">First user (company e-mail)</div>}</td>
                  <td className="small">{u.permissions.length ? u.permissions.map(label).join(', ') : 'Prepare only'}</td><td><Status value={u.status === 'ACTIVE' ? 'ACTIVE' : 'INACTIVE'} label={u.status === 'ACTIVE' ? 'Active' : 'Deactivated'} /></td>
                  {d.canManage && <td className="small">{u.lastLoginAt ? dateTime(u.lastLoginAt) : '—'}</td>}
                  <td className="num">{d.canManage && !u.you && <Button size="sm" onClick={() => setEdit(u)}>Change</Button>}</td></tr>))}</tbody></table></div>
          </Panel>
          {d.canManage && (
            <Panel title="Open invitations" flush>
              {!d.invites.length ? <Empty title="No open invitations" /> : (
                <table className="data"><thead><tr><th>Invited</th><th>Access</th><th>Expires</th><th /></tr></thead>
                  <tbody>{d.invites.map((i: any) => <tr key={i.id}><td className="primary-cell">{i.name}<div className="xs muted">{i.email} · by {i.invitedBy}</div></td><td className="small">{i.permissions.length ? i.permissions.map(label).join(', ') : 'Prepare only'}</td><td className="small">{i.expired ? <Status value="EXPIRED" label="Expired" /> : dateTime(i.expiresAt)}</td><td className="num"><Button size="sm" variant="ghost" onClick={() => revoke.run(i.id)}>Withdraw</Button></td></tr>)}</tbody></table>
              )}
              <ErrorAlert error={revoke.error} />
            </Panel>
          )}
        </>
      )}
      {invite && <InviteDrawer onClose={() => setInvite(false)} onDone={async () => { setInvite(false); await refresh(); }} />}
      {edit && <EditDrawer user={edit} onClose={() => setEdit(null)} onDone={async () => { setEdit(null); await refresh(); }} />}
    </div>
  );
}

function InviteDrawer({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({ fullName: '', email: '', roleInCompany: '', permissions: [] as string[], currentPassword: '' });
  const [sent, setSent] = useState<string | null>(null);
  const go = useAction(async () => { const r = await api.post<any>('/api/portal/users/invites', f); setSent(r.sentTo); });
  return (
    <Drawer title="Invite a colleague" onClose={sent ? onDone : onClose} footer={sent ? <Button variant="primary" onClick={onDone}>Done</Button> : <><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={go.loading} disabled={!f.fullName || !f.email || !f.roleInCompany || !f.currentPassword} onClick={() => go.run()}>Send invitation</Button></>}>
      {sent ? <Alert tone="ok" title="Invitation sent">We e-mailed an invitation to {sent}. It is valid for 72 hours. Your colleague verifies their mobile number and sets a password.</Alert> : (
        <div className="stack">
          <TextInput label="Full name" required value={f.fullName} onChange={(e) => setF({ ...f, fullName: e.target.value })} />
          <TextInput label="Work e-mail" type="email" required value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} hint="Their sign-in username." />
          <TextInput label="Role in the company" required value={f.roleInCompany} onChange={(e) => setF({ ...f, roleInCompany: e.target.value })} />
          <RightsPicker value={f.permissions} onChange={(p) => setF({ ...f, permissions: p })} />
          <TextInput label="Your password" type="password" autoComplete="current-password" required value={f.currentPassword} onChange={(e) => setF({ ...f, currentPassword: e.target.value })} hint="Confirms it is you granting access." />
          <ErrorAlert error={go.error} />
        </div>
      )}
    </Drawer>
  );
}

function EditDrawer({ user, onClose, onDone }: { user: any; onClose: () => void; onDone: () => void }) {
  const [perms, setPerms] = useState<string[]>(user.permissions);
  const [pw, setPw] = useState('');
  const save = useAction(async (status?: string) => { await api.patch(`/api/portal/users/${user.id}`, { permissions: perms, ...(status ? { status } : {}), currentPassword: pw }); onDone(); });
  const active = user.status === 'ACTIVE';
  return (
    <Drawer title={`Access — ${user.name}`} onClose={onClose} footer={<><Button variant={active ? 'danger' : undefined} disabled={!pw} loading={save.loading} onClick={() => save.run(active ? 'DISABLED' : 'ACTIVE')}>{active ? 'Deactivate' : 'Reactivate'}</Button><Button variant="primary" disabled={!pw} loading={save.loading} onClick={() => save.run()}>Save access</Button></>}>
      <div className="stack">
        <RightsPicker value={perms} onChange={setPerms} />
        <p className="xs muted">Removing access or deactivating signs the person out immediately.</p>
        <TextInput label="Your password" type="password" autoComplete="current-password" required value={pw} onChange={(e) => setPw(e.target.value)} />
        <ErrorAlert error={save.error} />
      </div>
    </Drawer>
  );
}
