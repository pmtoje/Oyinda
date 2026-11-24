import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { dateTime } from '../../lib/format';
import { Alert, Button, Drawer, Empty, ErrorAlert, KV, Loading, PageHeader, Panel, SelectInput, Status, Tabs, TextArea, useAction } from '../../components/ui';

/**
 * KYC / Compliance: promoter identity discrepancies. A reviewer proposes (clear, reject or escalate) with a reason;
 * a different reviewer approves or returns it. Identifiers are masked; the provider's record is revealed only on
 * request, and every reveal is audited.
 */
const STATUS: Record<string, [string, string]> = {
  OPEN: ['PENDING', 'Awaiting proposal'], PROPOSED: ['PENDING_CHECK', 'Awaiting second reviewer'], ESCALATED: ['WARNING', 'Escalated'],
  CLEARED: ['APPROVED', 'Cleared'], REJECTED: ['REJECTED', 'Rejected'],
};
const RESULT: Record<string, string> = { MATCH: 'APPROVED', PARTIAL: 'WARNING', MISMATCH: 'REJECTED', NOT_AVAILABLE: 'DRAFT' };
const AGAINST: Record<string, string> = { PROVIDED: 'Customer’s entry', BVN_RECORD: 'BVN record', BANK_RECORD: 'Bank record' };

function Review({ id, onClose }: { id: string; onClose: () => void }) {
  const { me } = useAuth();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['identity-review', id], queryFn: () => api.get<any>(`/api/identity-reviews/${id}`) });
  const [records, setRecords] = useState<any[] | null>(null);
  const [p, setP] = useState({ proposal: 'CLEAR', reason: '' });
  const [dReason, setDReason] = useState('');
  const done = async () => { await Promise.all([qc.invalidateQueries({ queryKey: ['identity-review', id] }), qc.invalidateQueries({ queryKey: ['identity-reviews'] })]); };
  const reveal = useAction(async () => setRecords(await api.post<any[]>(`/api/identity-reviews/${id}/reveal`)));
  const propose = useAction(async () => { await api.post(`/api/identity-reviews/${id}/propose`, p); await done(); });
  const decide = useAction(async (decision: 'APPROVE' | 'RETURN') => { await api.post(`/api/identity-reviews/${id}/decide`, { decision, reason: dReason }); await done(); });
  const r = q.data;
  const mine = r?.proposal?.byId === me?.user?.id;
  return (
    <Drawer title="Identity review" onClose={onClose}>
      {q.isLoading ? <Loading /> : q.error ? <ErrorAlert error={q.error} /> : (
        <div className="stack">
          <div className="row between"><h3 style={{ overflowWrap: 'anywhere' }}>{r.person.name}</h3><Status value={STATUS[r.status]?.[0]} label={STATUS[r.status]?.[1]} /></div>
          <KV items={[['Business', r.customer.name], ['Capacity', `${r.person.partyType.toLowerCase()}${r.person.ownershipPct ? ` · ${r.person.ownershipPct}%` : ''}`], ['Date of birth given', r.person.dateOfBirthProvided ?? '—'], ['BVN', r.person.bvn ?? '—'], ['NIN', r.person.nin ?? '—'], ['Opened', dateTime(r.createdAt)]]} />
          {r.customerNote && <Alert tone="info" title="Customer’s explanation">{r.customerNote}</Alert>}
          {r.checks.map((c: any) => (
            <Panel key={c.id} title={`${c.kind} check`} actions={<>{c.source === 'SANDBOX' && <span className="tag mock">SANDBOX</span>} <span className="xs muted">{c.provider} · {c.providerRef ?? 'no reference'}</span></>} flush>
              <div className="table-wrap"><table className="data"><thead><tr><th>Attribute</th><th>Compared with</th><th>Result</th></tr></thead>
                <tbody>{c.results.length ? c.results.map((x: any, i: number) => <tr key={i}><td>{x.attribute === 'fullName' ? 'Name' : 'Date of birth'}</td><td>{AGAINST[x.against] ?? x.against}</td><td><Status value={RESULT[x.result]} label={x.result.replace('_', ' ').toLowerCase()} /></td></tr>) : <tr><td colSpan={3} className="muted">No comparison — {c.error === 'NOT_FOUND' ? 'identifier not found' : c.error ?? c.status.toLowerCase()}</td></tr>}</tbody></table></div>
            </Panel>
          ))}
          {!records ? (
            <div><Button size="sm" loading={reveal.loading} onClick={() => reveal.run()}>Show identity records</Button> <span className="xs muted">Viewing is recorded in the audit trail.</span><ErrorAlert error={reveal.error} /></div>
          ) : (
            <Panel title="Identity records (provider)" flush><div className="table-wrap"><table className="data"><thead><tr><th>Source</th><th>Name</th><th>Date of birth</th></tr></thead>
              <tbody>{records.map((x) => <tr key={x.kind}><td>{x.kind}</td><td>{x.record?.fullName ?? '—'}</td><td>{x.record?.dateOfBirth ?? '—'}</td></tr>)}</tbody></table></div></Panel>
          )}
          {r.proposal && <Alert tone="info" title={`Proposed: ${r.proposal.decision.toLowerCase()} — ${r.proposal.by}`}>{r.proposal.reason}</Alert>}
          {r.decision && <Alert tone={r.status === 'CLEARED' ? 'ok' : 'danger'} title={`Decided by ${r.decision.by}`}>{r.decision.reason}</Alert>}

          {['OPEN', 'ESCALATED'].includes(r.status) && (
            <Panel title="Your proposal">
              <div className="stack">
                <SelectInput label="Outcome" value={p.proposal} options={[{ value: 'CLEAR', label: 'Clear — identity confirmed' }, { value: 'REJECT', label: 'Reject — identity not confirmed' }, { value: 'ESCALATE', label: 'Escalate to a senior reviewer' }]} onChange={(e) => setP({ ...p, proposal: e.target.value })} />
                <TextArea label="Reason and evidence" value={p.reason} onChange={(e) => setP({ ...p, reason: e.target.value })} hint="A second reviewer must approve. At least 10 characters." />
                <ErrorAlert error={propose.error} />
                <div><Button variant="primary" disabled={p.reason.trim().length < 10} loading={propose.loading} onClick={() => propose.run()}>Submit proposal</Button></div>
              </div>
            </Panel>
          )}
          {r.status === 'PROPOSED' && (mine ? <Alert tone="info" title="Waiting for a second reviewer">You made this proposal, so another reviewer must decide.</Alert> : (
            <Panel title="Second review">
              <div className="stack">
                <TextArea label="Reason" value={dReason} onChange={(e) => setDReason(e.target.value)} hint="At least 10 characters." />
                <ErrorAlert error={decide.error} />
                <div className="row"><Button disabled={dReason.trim().length < 10} loading={decide.loading} onClick={() => decide.run('RETURN')}>Return to proposer</Button><Button variant="primary" disabled={dReason.trim().length < 10} loading={decide.loading} onClick={() => decide.run('APPROVE')}>Approve proposal</Button></div>
              </div>
            </Panel>
          ))}
        </div>
      )}
    </Drawer>
  );
}

export default function IdentityReviews() {
  const [tab, setTab] = useState<'open' | 'closed'>('open');
  const [open, setOpen] = useState<string | null>(null);
  const q = useQuery({ queryKey: ['identity-reviews', tab], queryFn: () => api.get<any[]>(`/api/identity-reviews?status=${tab}`) });
  return (
    <>
      <PageHeader eyebrow="KYC & Compliance" title="Identity reviews" sub="Promoter BVN and NIN checks that need a person’s judgement. Every outcome needs two reviewers." />
      <Tabs tabs={[{ key: 'open', label: 'Open' }, { key: 'closed', label: 'Closed' }]} value={tab} onChange={(k) => setTab(k as 'open' | 'closed')} />
      <Panel flush>
        {q.isLoading ? <Loading /> : q.error ? <ErrorAlert error={q.error} /> : !q.data!.length ? <Empty title={tab === 'open' ? 'No identity reviews waiting' : 'No closed reviews yet'} /> : (
          <div className="table-wrap"><table className="data"><thead><tr><th>Person</th><th>Business</th><th>Status</th><th>Opened</th></tr></thead>
            <tbody>{q.data!.map((r) => (
              <tr key={r.id} className="clickable" tabIndex={0} onClick={() => setOpen(r.id)} onKeyDown={(e) => e.key === 'Enter' && setOpen(r.id)}>
                <td className="primary-cell">{r.person}<div className="xs muted">{r.partyType.toLowerCase()}</div></td><td>{r.customer}</td>
                <td><Status value={STATUS[r.status]?.[0]} label={STATUS[r.status]?.[1]} />{r.proposedBy && <div className="xs muted">by {r.proposedBy}</div>}</td><td className="small">{dateTime(r.createdAt)}</td>
              </tr>))}</tbody></table></div>)}
      </Panel>
      {open && <Review id={open} onClose={() => setOpen(null)} />}
    </>
  );
}
