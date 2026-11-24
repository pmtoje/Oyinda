import { Link, useNavigate } from 'react-router-dom';
import { useQueries, useQuery } from '@tanstack/react-query';
import { Button, Empty, ErrorAlert, KV, Loading, PageHeader, Panel, Status } from '../../components/ui';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { dateTime } from '../../lib/format';
import { EmailVerifyCard } from './parts/EmailVerify';

const ACTIVE = new Set(['DRAFT', 'SUBMITTED', 'IN_REVIEW', 'RETURNED', 'APPROVED', 'OFFER_ISSUED', 'IN_NEGOTIATION', 'OFFER_ACCEPTED', 'FULFILMENT', 'READY_FOR_ACTIVATION']);

export default function Dashboard() {
  const { me } = useAuth();
  const nav = useNavigate();
  const cid = me!.customer!.id;
  const profile = useQuery({ queryKey: ['profile', cid], queryFn: () => api.get<any>(`/api/customers/${cid}/profile`) });
  const facilities = useQuery({ queryKey: ['facilities'], queryFn: () => api.get<any[]>('/api/facilities') });
  const notes = useQuery({ queryKey: ['notifications', 'recent'], queryFn: () => api.get<any>('/api/notifications?limit=6') });
  const list = facilities.data ?? [];
  const active = list.filter((f) => ACTIVE.has(f.status));
  const past = list.filter((f) => !ACTIVE.has(f.status));
  const inFulfilment = active.filter((f) => f.status === 'FULFILMENT' || f.status === 'OFFER_ACCEPTED');
  const conds = useQueries({ queries: inFulfilment.map((f) => ({ queryKey: ['conditions', f.id], queryFn: () => api.get<any>(`/api/facilities/${f.id}/conditions`) })) });
  const details = useQueries({ queries: active.filter((f) => f.status !== 'DRAFT').map((f) => ({ queryKey: ['facility', f.id], queryFn: () => api.get<any>(`/api/facilities/${f.id}`) })) });
  const withProgress = new Map(details.map((d) => d.data).filter(Boolean).map((d: any) => [d.facility.id, d.progress]));

  const actions: { key: string; text: string; to: string; tone: string }[] = [];
  for (const f of active) {
    if (f.status === 'RETURNED') actions.push({ key: `r${f.id}`, text: `${f.ref} was returned for your attention. Review the flagged items and resubmit.`, to: `/portal/facilities/${f.id}/apply`, tone: 'RETURNED' });
    if (f.status === 'OFFER_ISSUED') actions.push({ key: `o${f.id}`, text: `An offer letter is ready for ${f.ref}. Review and respond.`, to: `/portal/facilities/${f.id}/offer`, tone: 'OFFER_ISSUED' });
    if (f.status === 'DRAFT') actions.push({ key: `d${f.id}`, text: `Continue your ${f.productName} request (${f.ref}).`, to: `/portal/facilities/${f.id}/apply`, tone: 'DRAFT' });
  }
  inFulfilment.forEach((f, i) => {
    const pending = (conds[i]?.data?.items ?? []).filter((c: any) => c.status === 'PENDING');
    if (pending.length) actions.push({ key: `c${f.id}`, text: `${pending.length} condition(s) on ${f.ref} need documents from you.`, to: `/portal/facilities/${f.id}/conditions`, tone: 'PENDING' });
  });
  const missing = (profile.data?.completeness.sections ?? []).filter((s: any) => !s.done);

  return (
    <div className="stack" style={{ ['--gap' as any]: '20px' }}>
      <PageHeader eyebrow={`Welcome back, ${(me!.user?.name ?? '').split(' ')[0] || 'there'}`} title="Your financing journey" sub={<><span className="business-line"><strong>{me!.customer!.name}</strong> · {me!.customer!.ref}</span>{' '}{profile.data?.customer.relationshipManager ? <>Relationship Manager: <strong>{profile.data.customer.relationshipManager.name}</strong> · <a href={`mailto:${profile.data.customer.relationshipManager.email}`}>{profile.data.customer.relationshipManager.email}</a></> : 'A relationship manager will be assigned to your business.'}</>}
        actions={<Button variant="primary" size="lg" onClick={() => nav('/portal/facilities/new')}>Start new facility request</Button>} />
      {!me!.user.emailVerified && <EmailVerifyCard />}
      {profile.data?.banking && (
        <Panel title="Your business on the Bank's records">
          <div className="grid cols-3">
            <KV items={[['Account name', profile.data.banking.accountName], ['Account number', <span className="mono" key="a">{profile.data.banking.accountNumber ?? '—'}</span>]]} />
            <KV items={[['Sector', profile.data.banking.sector ?? <span className="muted" key="s">Add in your business profile</span>], ['Branch', profile.data.banking.branch ?? '—']]} />
            <KV items={[['TIN', <span className="mono" key="t">{profile.data.banking.tin ?? '—'}</span>], ['RC number', <span className="mono" key="r">{profile.data.banking.rcNumber ?? '—'}</span>]]} />
          </div>
        </Panel>
      )}

      <div className="grid cols-3">
        <div className="metric"><div className="label">Active requests</div><div className="value">{facilities.isLoading ? '…' : active.length}</div><div className="sub">{past.length} completed or closed</div></div>
        <div className="metric"><div className="label">Actions for you</div><div className="value">{actions.length}</div><div className="sub">{actions.length ? 'See below' : 'Nothing outstanding'}</div></div>
        <div className="metric"><div className="label">Business profile</div><div className="value">{profile.data ? `${profile.data.completeness.pct}%` : '…'}</div><div className="progress" style={{ marginTop: 8 }} aria-hidden><span style={{ width: `${profile.data?.completeness.pct ?? 0}%` }} /></div></div>
      </div>

      {actions.length > 0 && (
        <Panel title="What needs your attention">
          <ul className="flag-list">{actions.map((a) => <li key={a.key} className="row between"><span className="row"><Status value={a.tone} label={a.tone === 'RETURNED' ? 'Returned' : a.tone === 'OFFER_ISSUED' ? 'Offer' : a.tone === 'DRAFT' ? 'Draft' : 'Documents'} />{a.text}</span><Link className="btn sm" to={a.to}>Open</Link></li>)}</ul>
        </Panel>
      )}

      <div className="grid" style={{ gridTemplateColumns: 'minmax(0, 2fr) minmax(0, 1fr)' }}>
        <Panel title="Your facility requests" flush>
          {facilities.isLoading ? <Loading /> : facilities.error ? <ErrorAlert error={facilities.error} /> : !list.length ? (
            <Empty title="No facility requests yet" action={<Button variant="primary" onClick={() => nav('/portal/facilities/new')}>Start new facility request</Button>}>Start a request for Murabaha, Ijarah, a guarantee or another Shariah-compliant facility.</Empty>
          ) : (
            <div className="table-wrap"><table className="data">
              <thead><tr><th>Reference</th><th>Facility</th><th className="num">Amount</th><th>Status</th><th>Currently with</th></tr></thead>
              <tbody>{list.map((f) => (
                <tr key={f.id} className="clickable" onClick={() => nav(f.status === 'DRAFT' ? `/portal/facilities/${f.id}/apply` : `/portal/facilities/${f.id}`)}>
                  <td><Link to={f.status === 'DRAFT' ? `/portal/facilities/${f.id}/apply` : `/portal/facilities/${f.id}`} className="primary-cell mono" onClick={(e) => e.stopPropagation()}>{f.ref}</Link></td>
                  <td>{f.productName}</td><td className="num">{f.amountText ?? '—'}</td><td><Status value={f.status} label={f.statusLabel} /></td>
                  <td className="small muted">{f.status === 'DRAFT' ? 'You' : withProgress.get(f.id)?.currentlyWith ?? '—'}</td>
                </tr>))}</tbody>
            </table></div>
          )}
        </Panel>
        <div className="stack">
          <Panel title="Profile completion" actions={<Link to="/portal/profile" className="btn sm">Update</Link>}>
            {profile.isLoading ? <Loading /> : missing.length ? <><p className="small muted">A complete profile speeds up review. Still to add:</p><ul className="small" style={{ margin: 0, paddingLeft: 18 }}>{missing.map((s: any) => <li key={s.name}>{s.name}</li>)}</ul></> : <p className="small">Your business profile is complete. It is reused for every request.</p>}
          </Panel>
          <Panel title="Recent activity" actions={<Link to="/portal/notifications" className="btn ghost sm">All</Link>}>
            {notes.isLoading ? <Loading /> : !notes.data?.items.length ? <p className="small muted">No recent activity.</p> : (
              <ul className="flag-list">{notes.data.items.map((n: any) => <li key={n.id}><Link to={n.link ?? '/portal'} style={{ fontWeight: n.readAt ? 400 : 600 }}>{n.title}</Link><div className="xs muted">{dateTime(n.createdAt)}</div></li>)}</ul>
            )}
          </Panel>
        </div>
      </div>
    </div>
  );
}
