import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Check, Empty, ErrorAlert, KV, Loading, MoneyInput, Status, TextArea, TextInput, useAction } from '../../../components/ui';
import { api, openDocument } from '../../../lib/api';
import { date, dateTime, humanize, toMinor } from '../../../lib/format';
import { useAuth } from '../../../lib/auth';

export function OfferTab({ facilityId }: { facilityId: string }) {
  const qc = useQueryClient();
  const { me } = useAuth();
  const canRespond = (me?.user?.permissions ?? []).includes('RESPOND_TO_OFFERS');
  const q = useQuery({ queryKey: ['offer', facilityId], queryFn: () => api.get<any>(`/api/facilities/${facilityId}/offer`) });
  const [mode, setMode] = useState<null | 'ACCEPT' | 'REJECT' | 'NEGOTIATE'>(null);
  const [ack, setAck] = useState(false);
  const [note, setNote] = useState('');
  const [n, setN] = useState({ amount: '', tenorMonths: '', profitRatePct: '', other: '', justification: '' });
  const respond = useAction(async (offer: any) => {
    await api.post(`/api/offers/${offer.id}/respond`, {
      decision: mode, rowVersion: offer.rowVersion, note: note || undefined, acknowledgement: mode === 'ACCEPT' ? ack : undefined,
      negotiation: mode === 'NEGOTIATE' ? { amountMinor: n.amount ? toMinor(n.amount) ?? undefined : undefined, tenorMonths: n.tenorMonths ? Number(n.tenorMonths) : undefined, profitRatePct: n.profitRatePct ? Number(n.profitRatePct) : undefined, other: n.other || undefined, justification: n.justification } : undefined,
    });
    setMode(null);
    await Promise.all([qc.invalidateQueries({ queryKey: ['offer', facilityId] }), qc.invalidateQueries({ queryKey: ['facility', facilityId] })]);
  });
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorAlert error={q.error} />;
  const offers = q.data.offers as any[];
  if (!offers.length) return <Empty title="No offer yet">Once your request is approved, the Bank prepares and checks your offer letter. You will be notified when it is ready.</Empty>;
  const current = offers[0];
  return (
    <div className="stack" style={{ ['--gap' as any]: '20px' }}>
      <div className="row between">
        <div><h3>{current.title}</h3><div className="small muted">Terms version {current.termsVersion} · issued {dateTime(current.issuedAt)}{current.expiresAt ? ` · valid until ${date(current.expiresAt)}` : ''}</div></div>
        <div className="row"><Status value={current.status} /><Button size="sm" onClick={() => openDocument(current.documentId, 'attachment')}>Download (Word)</Button></div>
      </div>
      <div className="grid cols-4">
        <div className="metric"><div className="label">Amount</div><div className="value">{current.amount}</div></div>
        <div className="metric"><div className="label">Tenor</div><div className="value">{current.tenorMonths} months</div></div>
        <div className="metric"><div className="label">{current.pricingLabel ?? 'Profit rate'}</div><div className="value">{current.pricingBasis === 'NONE' ? 'None' : `${current.profitRatePct}%`}</div><div className="sub">{current.pricingBasis === 'FEE' ? 'of the guaranteed amount' : current.pricingBasis === 'NONE' ? 'no return is charged' : 'per annum'}</div></div>
        <div className="metric"><div className="label">Payment</div><div className="value" style={{ fontSize: '1.05rem' }}>{humanize(current.paymentFrequency)}</div></div>
      </div>
      <article className="panel"><div className="panel-body stack">
        {current.sections.map((s: any) => <section key={s.heading}><h4>{s.heading}</h4>{s.paragraphs.map((p: string, i: number) => <p key={i} style={{ whiteSpace: 'pre-wrap' }}>{p}</p>)}</section>)}
      </div></article>

      {current.status === 'ISSUED' && !canRespond && <Alert tone="info" title="Awaiting an authorised signatory">Your access does not include responding to offers on behalf of the business. A colleague with that right can accept, reject or request changes.</Alert>}
      {current.status === 'ISSUED' && canRespond && (
        <div className="panel"><div className="panel-head"><h3>Your response</h3></div><div className="panel-body stack">
          <div className="row">
            <Button variant={mode === 'ACCEPT' ? 'primary' : undefined} aria-pressed={mode === 'ACCEPT'} onClick={() => setMode('ACCEPT')}>Accept offer</Button>
            <Button aria-pressed={mode === 'NEGOTIATE'} variant={mode === 'NEGOTIATE' ? 'primary' : undefined} onClick={() => setMode('NEGOTIATE')}>Request changes</Button>
            <Button variant="danger" aria-pressed={mode === 'REJECT'} onClick={() => setMode('REJECT')}>Reject offer</Button>
          </div>
          <ErrorAlert error={respond.error} />
          {mode === 'ACCEPT' && <>
            <Check label="I have read the offer letter and, on behalf of the business, accept the facility on these terms and conditions." checked={ack} onChange={(e) => setAck(e.target.checked)} />
            <p className="small muted">After acceptance, the Bank's Legal, Shariah and Credit Operations teams complete documentation. Funds are released only when all conditions precedent are met.</p>
            <div><Button variant="primary" disabled={!ack} loading={respond.loading} onClick={() => respond.run(current)}>Confirm acceptance</Button></div>
          </>}
          {mode === 'REJECT' && <>
            <TextArea label="Reason for rejecting" required value={note} onChange={(e) => setNote(e.target.value)} />
            <div><Button variant="danger" disabled={note.trim().length < 5} loading={respond.loading} onClick={() => respond.run(current)}>Confirm rejection</Button></div>
          </>}
          {mode === 'NEGOTIATE' && <>
            <p className="small muted">The approved terms are not changed. Your request is reviewed by the Bank, which may agree, decline, or issue a revised offer.</p>
            <div className="grid cols-3">
              <MoneyInput label="Requested amount" value={n.amount} onChange={(e) => setN({ ...n, amount: e.target.value })} />
              <TextInput label="Requested tenor (months)" type="number" value={n.tenorMonths} onChange={(e) => setN({ ...n, tenorMonths: e.target.value })} />
              <TextInput label="Requested profit rate (% p.a.)" type="number" step="0.01" value={n.profitRatePct} onChange={(e) => setN({ ...n, profitRatePct: e.target.value })} />
            </div>
            <TextArea label="Other changes" value={n.other} onChange={(e) => setN({ ...n, other: e.target.value })} />
            <TextArea label="Justification" required value={n.justification} onChange={(e) => setN({ ...n, justification: e.target.value })} hint="At least 10 characters." />
            <div><Button variant="primary" disabled={n.justification.trim().length < 10} loading={respond.loading} onClick={() => respond.run(current)}>Send request</Button></div>
          </>}
        </div></div>
      )}
      {current.status === 'ACCEPTED' && <Alert tone="ok" title="You accepted this offer">{current.respondedAt && `Accepted ${dateTime(current.respondedAt)}.`} Documentation is now in progress.</Alert>}

      {q.data.negotiations.length > 0 && (
        <section><h4>Change requests</h4>
          <ul className="flag-list">{q.data.negotiations.map((x: any) => (
            <li key={x.id}><div className="row between"><span>{[x.requestedAmount && `Amount ${x.requestedAmount}`, x.requestedTenorMonths && `${x.requestedTenorMonths} months`, x.requestedProfitRatePct && `${x.requestedProfitRatePct}%`, x.requestedOther].filter(Boolean).join(' · ')}</span><Status value={x.status} /></div>
              <div className="small muted">{x.justification}</div>{x.decisionNote && <div className="small">Bank’s response: {x.decisionNote}</div>}</li>))}</ul>
        </section>
      )}
      {offers.length > 1 && <section><h4>Earlier offers</h4><KV items={offers.slice(1).map((o) => [`Terms v${o.termsVersion}`, <span key={o.id}>{o.amount} · {o.tenorMonths} months · <Status value={o.status} /></span>])} /></section>}
    </div>
  );
}

export function ConditionsTab({ facilityId }: { facilityId: string }) {
  const q = useQuery({ queryKey: ['conditions', facilityId], queryFn: () => api.get<any>(`/api/facilities/${facilityId}/conditions`) });
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const upload = async (cid: string, file: File) => {
    setBusy(cid); setErr(null);
    try { const r = await api.post<any>(`/api/conditions/${cid}/evidence`); await api.upload(`/api/documents/${r.documentId}/upload`, file); await q.refetch(); }
    catch (e) { setErr(e); } finally { setBusy(null); }
  };
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorAlert error={q.error} />;
  if (!q.data.items.length) return <Empty title="Nothing required from you">The Bank's teams are completing the remaining documentation.</Empty>;
  return (
    <div className="stack">
      <p className="small muted">These conditions in your offer letter need evidence from you. Credit Operations confirms each item once received.</p>
      <ErrorAlert error={err} />
      <div className="table-wrap"><table className="data"><thead><tr><th>Condition</th><th>Type</th><th>Status</th><th className="num" /></tr></thead>
        <tbody>{q.data.items.map((c: any) => (
          <tr key={c.id}><td className="primary-cell">{c.description}{c.nextDueDate && <div className="xs muted">Due {date(c.nextDueDate)}</div>}</td><td>{humanize(c.category)}</td><td><Status value={c.status} />{c.evidenceDocumentId && c.status === 'PENDING' && <div className="xs muted">Evidence received</div>}</td>
            <td className="num">{c.status === 'PENDING' && <label className="btn sm">{busy === c.id ? 'Uploading…' : 'Upload evidence'}<input type="file" hidden accept=".pdf,.png,.jpg,.jpeg" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void upload(c.id, f); }} /></label>}</td></tr>))}</tbody></table></div>
    </div>
  );
}

export function AccountTab({ facilityId }: { facilityId: string }) {
  const q = useQuery({ queryKey: ['account', facilityId], queryFn: () => api.get<any>(`/api/facilities/${facilityId}/account`) });
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorAlert error={q.error} />;
  const a = q.data;
  if (!a) return <Empty title="Facility not yet active">Your facility account appears here once Credit Operations activates the facility.</Empty>;
  const { money } = { money: (m: number) => new Intl.NumberFormat('en-NG', { style: 'currency', currency: a.currency }).format(m / 100) };
  return (
    <div className="stack" style={{ ['--gap' as any]: '20px' }}>
      <div className="grid cols-4">
        <div className="metric"><div className="label">Approved</div><div className="value">{money(a.approvedMinor)}</div></div>
        <div className="metric"><div className="label">Utilised</div><div className="value">{money(a.utilisedMinor)}</div></div>
        <div className="metric"><div className="label">Available</div><div className="value">{money(a.availableMinor)}</div></div>
        <div className="metric"><div className="label">Matures</div><div className="value" style={{ fontSize: '1.1rem' }}>{date(a.maturityDate)}</div><div className="sub">{a.profitRatePct}% profit rate</div></div>
      </div>
      <section><h4>Disbursements</h4>
        {!a.disbursements.length ? <p className="small muted">No disbursements yet.</p> : <div className="table-wrap"><table className="data"><thead><tr><th>Date</th><th>Beneficiary</th><th>Narrative</th><th className="num">Amount</th><th>Status</th></tr></thead>
          <tbody>{a.disbursements.map((d: any) => <tr key={d.id}><td>{dateTime(d.postedAt ?? d.requestedAt)}</td><td>{d.beneficiary}</td><td>{d.narrative}</td><td className="num">{d.amount}</td><td><Status value={d.status} /></td></tr>)}</tbody></table></div>}
      </section>
      <section><h4>Payment schedule</h4>
        {!a.schedule.length ? <p className="small muted">No scheduled payments for this facility.</p> : <div className="table-wrap"><table className="data"><thead><tr><th>#</th><th>Due date</th><th className="num">Cost</th><th className="num">Profit</th><th className="num">Total</th><th className="num">Paid</th><th>Status</th></tr></thead>
          <tbody>{a.schedule.map((s: any) => <tr key={s.seq}><td>{s.seq}</td><td>{date(s.dueDate)}</td><td className="num">{money(s.principalMinor)}</td><td className="num">{money(s.profitMinor)}</td><td className="num">{money(s.totalMinor)}</td><td className="num">{money(s.paidMinor)}</td><td><Status value={s.status} /></td></tr>)}</tbody></table></div>}
      </section>
    </div>
  );
}
