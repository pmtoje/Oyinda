import { useMemo, useState } from 'react';
import { api, idem, openDocument } from '../../../lib/api';
import { useAuth } from '../../../lib/auth';
import { date, dateTime, humanize, money, pct, toMinor } from '../../../lib/format';
import { Alert, Button, Drawer, Empty, ErrorAlert, KV, MockTag, MoneyInput, Panel, SelectInput, Status, TextArea, TextInput, useAction } from '../../../components/ui';
import { QueryState, useFac, useRefresh } from './common';

export function OfferTab({ id, status }: { id: string; status: string }) {
  const { can } = useAuth();
  const q = useFac<any>(id, 'offer', `/api/facilities/${id}/offer`);
  const refresh = useRefresh(id);
  const prepare = useAction(async () => { await api.post(`/api/facilities/${id}/offer`); await refresh(); });
  const check = useAction(async (oid: string, decision: string, note?: string) => { await api.post(`/api/offers/${oid}/check`, { decision, note }); await refresh(); });
  const sign = useAction(async (oid: string, kind: 'SIGN' | 'COUNTERSIGN') => { await api.post(`/api/offers/${oid}/sign`, { kind }); await refresh(); });
  const [neg, setNeg] = useState<any>(null);
  return (
    <QueryState q={q}>{() => {
      const { offers, negotiations, termsVersions } = q.data;
      const live = offers.find((o: any) => ['PENDING_CHECK', 'PENDING_SIGNOFF', 'ISSUED', 'NEGOTIATING'].includes(o.status));
      return (
        <div className="stack">
          {status === 'APPROVED' && !live && can('offer.make') && <Alert tone="info" title="Offer letter needed">The facility is approved. Prepare the offer letter from the approved template; a second officer must check it before it is issued. <div style={{ marginTop: 8 }}><Button variant="primary" onClick={() => prepare.run()} loading={prepare.loading}>Prepare offer letter</Button></div></Alert>}
          <ErrorAlert error={prepare.error ?? check.error ?? sign.error} />
          {negotiations.filter((n: any) => n.status === 'OPEN').map((n: any) => (
            <Alert key={n.id} tone="warn" title="Customer negotiation request">
              <KV items={[['Requested amount', n.requestedAmount], ['Requested tenor', n.requestedTenorMonths ? `${n.requestedTenorMonths} months` : null], ['Requested rate', n.requestedProfitRatePct !== null ? pct(n.requestedProfitRatePct, 2) : null], ['Other', n.requestedOther], ['Justification', n.justification], ['Received', dateTime(n.createdAt)]]} />
              {can('negotiation.review') && <div style={{ marginTop: 8 }}><Button variant="primary" onClick={() => setNeg(n)}>Review request</Button></div>}
            </Alert>))}
          {!offers.length ? <Panel><Empty title="No offer letter yet" /></Panel> : offers.map((o: any) => (
            <Panel key={o.id} title={`${o.title} — terms v${o.termsVersion}`} actions={<><Status value={o.status} /><Button size="sm" onClick={() => openDocument(o.documentId, 'attachment')}>Download</Button></>}
              footer={o.status === 'PENDING_CHECK' && can('offer.check') && <div className="row end"><Button variant="danger" onClick={() => check.run(o.id, 'RETURN', 'Returned to maker for correction')}>Return to maker</Button><Button variant="primary" onClick={() => check.run(o.id, 'ISSUE')} loading={check.loading}>Check and send for sign-off</Button></div>}>
              <div className="grid cols-2">
                <KV items={[['Amount', o.amount], ['Tenor', `${o.tenorMonths} months`], ['Profit rate', pct(o.profitRatePct, 2)], ['Payment', humanize(o.paymentFrequency)]]} />
                <KV items={[['Maker', o.maker], ['Checker', o.checker], ['Issued', dateTime(o.issuedAt)], ['Expires', date(o.expiresAt)], ['Customer response', o.respondedAt ? `${dateTime(o.respondedAt)}${o.responseNote ? ` — ${o.responseNote}` : ''}` : null]]} />
              </div>
              {o.status === 'PENDING_CHECK' && <p className="xs muted" style={{ marginTop: 8 }}>Maker-checker: the officer who prepared the offer cannot check it. After the check, the offer goes for business sign-off before it is issued.</p>}
              {o.signoff && (
                <div className="panel" style={{ marginTop: 12, padding: 12 }}>
                  <div className="row between"><strong className="small">Sign-off — {o.signoff.rule}</strong>{o.status === 'PENDING_SIGNOFF' && <Status value="PENDING" label="Awaiting signatures" />}</div>
                  <KV items={[
                    [`Signed (${o.signoff.signRoles.join(' / ')})`, o.signoff.signedBy ? `${o.signoff.signedBy} · ${dateTime(o.signoff.signedAt)}` : null],
                    [`Countersigned (${o.signoff.countersignRoles.join(' / ')})`, o.signoff.countersignedBy ? `${o.signoff.countersignedBy} · ${dateTime(o.signoff.countersignedAt)}` : null],
                  ]} />
                  {o.status === 'PENDING_SIGNOFF' && can('offer.sign') && (
                    <div className="row end" style={{ marginTop: 8 }}>
                      {!o.signoff.signedBy && <Button size="sm" variant="primary" loading={sign.loading} onClick={() => sign.run(o.id, 'SIGN')}>Sign offer</Button>}
                      {!o.signoff.countersignedBy && <Button size="sm" loading={sign.loading} onClick={() => sign.run(o.id, 'COUNTERSIGN')}>Countersign</Button>}
                    </div>
                  )}
                </div>
              )}
            </Panel>))}
          {termsVersions.length > 0 && <Panel title="Approved terms versions" flush><table className="data"><thead><tr><th>Version</th><th>Source</th><th className="num">Amount</th><th className="num">Tenor</th><th className="num">Rate</th><th>Approved by</th><th>Date</th></tr></thead><tbody>{termsVersions.map((t: any) => <tr key={t.id}><td>v{t.version}</td><td>{humanize(t.source)}</td><td className="num">{money(t.amountMinor)}</td><td className="num">{t.tenorMonths}m</td><td className="num">{pct(t.profitRatePct, 2)}</td><td className="small">{t.approvedBy.join(', ')}</td><td className="small">{dateTime(t.createdAt)}</td></tr>)}</tbody></table></Panel>}
          {neg && <NegotiationDrawer n={neg} onClose={() => setNeg(null)} onDone={async () => { setNeg(null); await refresh(); }} />}
        </div>
      );
    }}</QueryState>
  );
}

function NegotiationDrawer({ n, onClose, onDone }: { n: any; onClose: () => void; onDone: () => void }) {
  const [note, setNote] = useState(''); const [amount, setAmount] = useState(''); const [tenor, setTenor] = useState(n.requestedTenorMonths ? String(n.requestedTenorMonths) : ''); const [rate, setRate] = useState(n.requestedProfitRatePct !== null ? String(n.requestedProfitRatePct) : '');
  const go = useAction(async (decision: string) => { await api.post(`/api/negotiations/${n.id}/decide`, { decision, note, ...(decision === 'APPROVE' ? { amountMinor: toMinor(amount) ?? undefined, tenorMonths: tenor ? Number(tenor) : undefined, profitRatePct: rate ? Number(rate) : undefined } : {}) }); onDone(); });
  return (
    <Drawer title="Review negotiation request" onClose={onClose} footer={<><Button variant="danger" disabled={note.trim().length < 5} onClick={() => go.run('DECLINE')} loading={go.loading}>Decline</Button><Button variant="primary" disabled={note.trim().length < 5} onClick={() => go.run('APPROVE')} loading={go.loading}>Agree revised terms</Button></>}>
      <div className="stack">
        <Alert tone="info">Approved terms are never edited. Agreeing creates a new terms version and supersedes the current offer. Increases above the approved amount need fresh credit approval.</Alert>
        <p className="small">{n.justification}</p>
        <MoneyInput label="Agreed amount (leave blank for the customer's request or current amount)" value={amount} onChange={(e) => setAmount(e.target.value)} />
        <div className="grid cols-2"><TextInput label="Agreed tenor (months)" type="number" value={tenor} onChange={(e) => setTenor(e.target.value)} /><TextInput label="Agreed profit rate (%)" type="number" step="0.01" value={rate} onChange={(e) => setRate(e.target.value)} /></div>
        <TextArea label="Decision note" value={note} onChange={(e) => setNote(e.target.value)} required hint="Shared with the customer." />
        <ErrorAlert error={go.error} />
      </div>
    </Drawer>
  );
}

const TEAM_PERM: Record<string, string> = { LEGAL: 'condition.legal', SHARIAH: 'condition.shariah', CREDIT_OPS: 'condition.creditops', CUSTOMER: 'condition.creditops', RM: 'condition.creditops' };

export function ConditionsTab({ id }: { id: string }) {
  const { can } = useAuth();
  const q = useFac<any>(id, 'conditions', `/api/facilities/${id}/conditions`);
  const [edit, setEdit] = useState<any>(null);
  const refresh = useRefresh(id);
  return (
    <QueryState q={q}>{() => {
      if (!q.data.termsVersion) return <Panel><Empty title="No conditions yet">Conditions are generated when the facility is approved.</Empty></Panel>;
      const teams = ['LEGAL', 'SHARIAH', 'CREDIT_OPS', 'CUSTOMER', 'RM'].filter((t) => q.data.items.some((i: any) => i.ownerTeam === t));
      return (
        <div className="stack">
          {q.data.blocking > 0 ? <Alert tone="warn" title={`${q.data.blocking} mandatory condition(s) precedent outstanding`}>Activation and disbursement are blocked until these are satisfied or formally waived.</Alert> : <Alert tone="ok">All mandatory conditions precedent are satisfied or waived (terms v{q.data.termsVersion}).</Alert>}
          {teams.map((team) => (
            <Panel key={team} title={humanize(team)} flush>
              <div className="table-wrap"><table className="data"><thead><tr><th>Condition</th><th>Type</th><th>Status</th><th>Actioned</th><th /></tr></thead>
                <tbody>{q.data.items.filter((i: any) => i.ownerTeam === team).map((c: any) => (
                  <tr key={c.id}><td className="primary-cell">{c.description}{c.mandatory && <span className="req" title="Mandatory">*</span>}{c.comment && <div className="xs muted">{c.comment}</div>}</td>
                    <td className="small">{humanize(c.category)}{c.frequency ? ` · ${humanize(c.frequency)}` : ''}{c.nextDueDate && <div className="xs muted">Due {date(c.nextDueDate)}</div>}</td>
                    <td><Status value={c.status} /></td>
                    <td className="small">{c.actionedBy ? <>{c.actionedBy}<div className="xs muted">{dateTime(c.actionedAt)}</div></> : '—'}{c.waiverApprovedBy && <div className="xs muted">Waiver: {c.waiverApprovedBy}</div>}</td>
                    <td className="num"><div className="row end" style={{ ['--gap' as any]: '6px' }}>{c.evidenceDocumentId && <Button size="sm" onClick={() => openDocument(c.evidenceDocumentId).catch(() => undefined)}>Evidence</Button>}{can(TEAM_PERM[c.ownerTeam] ?? 'condition.creditops') && <Button size="sm" onClick={() => setEdit(c)}>Update</Button>}</div></td></tr>))}</tbody></table></div>
            </Panel>))}
          {edit && <ConditionDrawer id={id} c={edit} canWaive={can('condition.waive')} onClose={() => setEdit(null)} onDone={async () => { setEdit(null); await refresh(); }} />}
        </div>
      );
    }}</QueryState>
  );
}

function ConditionDrawer({ id, c, canWaive, onClose, onDone }: { id: string; c: any; canWaive: boolean; onClose: () => void; onDone: () => void }) {
  const [status, setStatus] = useState(c.status === 'PENDING' ? 'SATISFIED' : c.status);
  const [comment, setComment] = useState(''); const [file, setFile] = useState<File | null>(null); const [due, setDue] = useState(c.nextDueDate ?? '');
  const go = useAction(async () => {
    let evidenceDocumentId: string | undefined;
    if (file) {
      const d = await api.post<{ id: string }>(`/api/facilities/${id}/documents`, { title: `Evidence: ${c.description.slice(0, 120)}`, customerVisible: false });
      await api.upload(`/api/documents/${d.id}/upload`, file);
      evidenceDocumentId = d.id;
    }
    await api.patch(`/api/conditions/${c.id}`, { status, comment, evidenceDocumentId: evidenceDocumentId ?? c.evidenceDocumentId ?? undefined, nextDueDate: due || undefined });
    onDone();
  });
  const opts = [{ value: 'SATISFIED', label: 'Satisfied' }, { value: 'PENDING', label: 'Pending' }, ...(canWaive || !c.mandatory ? [{ value: 'NOT_APPLICABLE', label: 'Not applicable' }] : []), ...(canWaive ? [{ value: 'WAIVED', label: 'Waived (waiver authority)' }] : [])];
  return (
    <Drawer title="Update condition" onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={comment.trim().length < 5} loading={go.loading} onClick={() => go.run()}>Save</Button></>}>
      <div className="stack">
        <p>{c.description}</p>
        <SelectInput label="Status" value={status} onChange={(e) => setStatus(e.target.value)} options={opts} />
        {status === 'SATISFIED' && c.category === 'PRECEDENT' && c.mandatory && !c.evidenceDocumentId && <Alert tone="info">Attach the executed document as evidence.</Alert>}
        <div className="field"><label htmlFor="cond-ev">Evidence document</label><input id="cond-ev" type="file" accept=".pdf,.png,.jpg,.jpeg,.docx" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />{c.evidenceDocumentId && <span className="hint">Evidence already attached; uploading replaces the reference.</span>}</div>
        {c.category === 'COVENANT' && <TextInput label="Next due date" type="date" value={due} onChange={(e) => setDue(e.target.value)} />}
        <TextArea label="Comment" value={comment} onChange={(e) => setComment(e.target.value)} required />
        <ErrorAlert error={go.error} />
      </div>
    </Drawer>
  );
}

export function AccountTab({ id, status }: { id: string; status: string }) {
  const { can } = useAuth();
  const q = useFac<any>(id, 'account', `/api/facilities/${id}/account`);
  const refresh = useRefresh(id);
  const activate = useAction(async () => { await api.post(`/api/facilities/${id}/activate`); await refresh(); });
  const decide = useAction(async (did: string, decision: string) => { await api.post(`/api/disbursements/${did}/decide`, { decision }); await refresh(); });
  const resolve = useAction(async (mid: string) => { const note = window.prompt('Resolution note'); if (!note) return; await api.post(`/api/monitoring/${mid}/resolve`, { note }); await refresh(); });
  const [disb, setDisb] = useState(false); const [pay, setPay] = useState(false);
  return (
    <QueryState q={q}>{() => {
      const a = q.data;
      if (!a) return (
        <Panel title="Facility account">
          {status === 'READY_FOR_ACTIVATION' ? (
            <div className="stack"><Alert tone="ok" title="Ready for activation">All mandatory conditions are satisfied. Activation books the facility on core banking and generates the payment schedule.</Alert>
              {can('facility.activate') && <div><Button variant="primary" onClick={() => activate.run()} loading={activate.loading}>Activate facility</Button></div>}<ErrorAlert error={activate.error} /></div>
          ) : <Empty title="Not yet activated">The facility is activated after documentation and conditions precedent are complete.</Empty>}
        </Panel>);
      const overdue = a.schedule.filter((s: any) => s.status === 'OVERDUE').length;
      return (
        <div className="stack">
          <div className="grid cols-4">
            <div className="metric"><div className="label">Approved</div><div className="value">{money(a.approvedMinor, a.currency, { compact: true })}</div><div className="sub">{a.tenorMonths} months at {pct(a.profitRatePct, 2)}</div></div>
            <div className="metric"><div className="label">Utilised</div><div className="value">{money(a.utilisedMinor, a.currency, { compact: true })}</div><div className="sub">Available {money(a.availableMinor, a.currency, { compact: true })}</div></div>
            <div className="metric"><div className="label">Outstanding</div><div className="value">{money(a.outstandingMinor, a.currency, { compact: true })}</div></div>
            <div className={overdue ? 'metric alert' : 'metric'}><div className="label">Maturity</div><div className="value">{date(a.maturityDate)}</div><div className="sub">{overdue ? `${overdue} instalment(s) overdue` : `Review ${date(a.nextReviewDate)}`}</div></div>
          </div>
          <Panel title={<>Core banking <MockTag mode={a.cbaMode} /></>}><KV items={[['CBA reference', <span className="mono">{a.cbaReference}</span>], ['Status', <Status value={a.status} />], ['Start', date(a.startDate)]]} /></Panel>
          <ErrorAlert error={decide.error ?? resolve.error} />
          <Panel title="Disbursements" flush actions={can('disbursement.make') && a.status === 'ACTIVE' && <Button size="sm" variant="primary" onClick={() => setDisb(true)}>Request disbursement</Button>}>
            {!a.disbursements.length ? <Empty title="No disbursements" /> : <div className="table-wrap"><table className="data"><thead><tr><th>Requested</th><th className="num">Amount</th><th>Beneficiary</th><th>Maker / checker</th><th>Status</th><th /></tr></thead>
              <tbody>{a.disbursements.map((d: any) => <tr key={d.id}><td className="small">{dateTime(d.requestedAt)}<div className="xs muted">{d.narrative}</div></td><td className="num">{d.amount}</td><td className="small">{d.beneficiary}</td><td className="small">{d.maker}{d.checker && <div className="xs muted">checked by {d.checker}</div>}</td><td><Status value={d.status === 'PENDING_APPROVAL' ? 'PENDING' : d.status} label={humanize(d.status)} />{d.cbaReference && <div className="xs mono muted">{d.cbaReference}</div>}{d.failureReason && <div className="xs" style={{ color: 'var(--danger-700)' }}>{d.failureReason}</div>}</td>
                <td className="num">{d.status === 'PENDING_APPROVAL' && can('disbursement.check') && <div className="row end" style={{ ['--gap' as any]: '6px' }}><Button size="sm" variant="danger" onClick={() => decide.run(d.id, 'REJECT')}>Reject</Button><Button size="sm" variant="primary" onClick={() => decide.run(d.id, 'APPROVE')}>Approve & post</Button></div>}</td></tr>)}</tbody></table></div>}
          </Panel>
          <Panel title="Payment schedule" flush actions={can('monitoring.manage') && <Button size="sm" onClick={() => setPay(true)}>Record payment</Button>}>
            {!a.schedule.length ? <Empty title="No schedule">Contingent facilities have no payment schedule.</Empty> : <div className="table-wrap" style={{ maxHeight: 420, overflowY: 'auto' }}><table className="data"><thead><tr><th>#</th><th>Due</th><th className="num">Cost</th><th className="num">Profit</th><th className="num">Total</th><th className="num">Paid</th><th>Status</th></tr></thead>
              <tbody>{a.schedule.map((s: any) => <tr key={s.seq}><td>{s.seq}</td><td>{date(s.dueDate)}</td><td className="num">{money(s.principalMinor, a.currency)}</td><td className="num">{money(s.profitMinor, a.currency)}</td><td className="num">{money(s.totalMinor, a.currency)}</td><td className="num">{money(s.paidMinor, a.currency)}</td><td><Status value={s.status} /></td></tr>)}</tbody></table></div>}
          </Panel>
          <Panel title="Monitoring" flush>
            {!a.monitoring?.length ? <Empty title="No monitoring items" /> : <table className="data"><tbody>{a.monitoring.map((m: any) => <tr key={m.id}><td><span className={`sev ${m.severity === 'CRITICAL' ? 'HIGH' : m.severity === 'WARNING' ? 'MEDIUM' : 'LOW'}`}>{m.severity}</span></td><td className="small"><strong>{humanize(m.kind)}</strong> · due {date(m.dueDate)}<div>{m.detail}</div>{m.resolutionNote && <div className="xs muted">Resolved: {m.resolutionNote}</div>}</td><td><Status value={m.status} /></td><td className="num">{m.status === 'OPEN' && can('monitoring.manage') && <Button size="sm" onClick={() => resolve.run(m.id)}>Resolve</Button>}</td></tr>)}</tbody></table>}
          </Panel>
          {disb && <DisbursementDrawer id={id} available={a.availableMinor} currency={a.currency} onClose={() => setDisb(false)} onDone={async () => { setDisb(false); await refresh(); }} />}
          {pay && <PaymentDrawer accountId={a.id} currency={a.currency} onClose={() => setPay(false)} onDone={async () => { setPay(false); await refresh(); }} />}
        </div>
      );
    }}</QueryState>
  );
}

function DisbursementDrawer({ id, available, currency, onClose, onDone }: { id: string; available: number; currency: string; onClose: () => void; onDone: () => void }) {
  const [v, setV] = useState({ amount: '', beneficiaryAccount: '', beneficiaryName: '', narrative: '' });
  const key = useMemo(() => idem(), []); // stable key: a double click cannot create two disbursements
  const go = useAction(async () => { await api.post(`/api/facilities/${id}/disbursements`, { amountMinor: toMinor(v.amount), beneficiaryAccount: v.beneficiaryAccount, beneficiaryName: v.beneficiaryName, narrative: v.narrative, idempotencyKey: key }); onDone(); });
  const amt = toMinor(v.amount);
  return (
    <Drawer title="Request disbursement" onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!amt || amt > available || !/^\d{10}$/.test(v.beneficiaryAccount) || v.beneficiaryName.length < 2 || v.narrative.length < 5} loading={go.loading} onClick={() => go.run()}>Submit for approval</Button></>}>
      <div className="stack">
        <Alert tone="info">Available: {money(available, currency)}. A second Credit Operations officer must approve before posting to core banking.</Alert>
        <MoneyInput label="Amount" currency={currency} value={v.amount} onChange={(e) => setV({ ...v, amount: e.target.value })} required error={amt && amt > available ? 'Exceeds the available limit.' : undefined} />
        <TextInput label="Beneficiary account (NUBAN)" inputMode="numeric" maxLength={10} value={v.beneficiaryAccount} onChange={(e) => setV({ ...v, beneficiaryAccount: e.target.value.replace(/\D/g, '') })} required />
        <TextInput label="Beneficiary name" value={v.beneficiaryName} onChange={(e) => setV({ ...v, beneficiaryName: e.target.value })} required />
        <TextInput label="Narrative" value={v.narrative} onChange={(e) => setV({ ...v, narrative: e.target.value })} required />
        <ErrorAlert error={go.error} />
      </div>
    </Drawer>
  );
}

function PaymentDrawer({ accountId, currency, onClose, onDone }: { accountId: string; currency: string; onClose: () => void; onDone: () => void }) {
  const [v, setV] = useState({ amount: '', valueDate: new Date().toISOString().slice(0, 10), reference: '' });
  const go = useAction(async () => { await api.post(`/api/facility-accounts/${accountId}/payments`, { amountMinor: toMinor(v.amount), valueDate: v.valueDate, reference: v.reference }); onDone(); });
  return (
    <Drawer title="Record payment" onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!toMinor(v.amount) || v.reference.length < 4} loading={go.loading} onClick={() => go.run()}>Record</Button></>}>
      <div className="stack">
        <p className="small muted">Use the core banking transaction reference. A reference can be recorded only once.</p>
        <MoneyInput label="Amount" currency={currency} value={v.amount} onChange={(e) => setV({ ...v, amount: e.target.value })} required />
        <TextInput label="Value date" type="date" value={v.valueDate} onChange={(e) => setV({ ...v, valueDate: e.target.value })} required />
        <TextInput label="Reference" value={v.reference} onChange={(e) => setV({ ...v, reference: e.target.value })} required />
        <ErrorAlert error={go.error} />
      </div>
    </Drawer>
  );
}
