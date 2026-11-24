import { useState } from 'react';
import { api, openDocument } from '../../../lib/api';
import { bytes, date, dateTime, humanize, money } from '../../../lib/format';
import { useAuth } from '../../../lib/auth';
import { Alert, Button, Drawer, Empty, ErrorAlert, KV, Panel, Status, TextArea, TextInput, useAction } from '../../../components/ui';
import { QueryState, Section, useFac, useRefresh } from './common';

export function OverviewTab({ id, detail }: { id: string; detail: any }) {
  const flags = useFac<any[]>(id, 'flags', `/api/facilities/${id}/risk-flags`);
  const f = detail.facility;
  const pf = detail.product.fields as any[];
  const refresh = useRefresh(id);
  const rerun = useAction(async () => { await api.post(`/api/facilities/${id}/eligibility`); await refresh(); });
  const elig = detail.eligibility;
  return (
    <div className="stack">
      <div className="grid cols-2">
        <Panel title="Request">
          <KV items={[
            ['Purpose', f.purpose], ['Payment', `${humanize(f.paymentFrequency)}${f.paymentStructure ? ` — ${f.paymentStructure}` : ''}`], ['Source of payment', f.sourceOfPayment],
            ['Supplier / vendor', f.supplierName], ['Underlying asset', f.underlyingAsset], ['Project', f.projectDetails], ['Proposed security', f.proposedSecurity], ['Origin', f.origin === 'RM' ? 'RM-initiated' : 'Customer-initiated'],
          ]} />
        </Panel>
        <Panel title={`${detail.product.name} structure`}>
          <p className="small">{detail.product.shariahStructure}</p>
          <KV items={pf.filter((x) => f.productFields?.[x.key] !== undefined).map((x) => [x.label, x.type === 'money' ? money(f.productFields[x.key], f.currency) : typeof f.productFields[x.key] === 'boolean' ? (f.productFields[x.key] ? 'Yes' : 'No') : String(f.productFields[x.key])])} />
        </Panel>
      </div>
      <Panel title="Risk flags" actions={<span className="xs muted">Every flag is computed from data in Credit360 and cites its evidence</span>}>
        <QueryState q={flags} empty={<Empty title="No risk flags raised">Flags appear once financials, statements, exposure, collateral and pricing are analysed.</Empty>}>{() => (
          <ul className="flag-list">{flags.data!.map((fl, i) => (
            <li key={i}><div className="row" style={{ ['--gap' as any]: '8px' }}><span className={`sev ${fl.severity}`}>{fl.severity}</span><strong className="small">{humanize(fl.code)}</strong></div>
              <div>{fl.statement}</div>{fl.mitigantHint && <div className="small muted">Consider: {fl.mitigantHint}</div>}
              <div className="evidence">{fl.evidence.map((e: any, j: number) => <div key={j}>{e.label}: <strong>{e.value}</strong></div>)}</div></li>))}</ul>)}</QueryState>
      </Panel>
      <Panel title="Eligibility (FIPG)" actions={<><Status value={elig?.outcome} /><Button size="sm" onClick={() => rerun.run()} loading={rerun.loading}>Re-evaluate</Button></>}>
        <ErrorAlert error={rerun.error} />
        {!elig ? <Empty title="Not yet evaluated" /> : (
          <div className="table-wrap"><table className="data"><thead><tr><th>Rule</th><th>Result</th><th>Actual</th><th>Required</th><th>Explanation</th></tr></thead>
            <tbody>{elig.results.filter((r: any) => r.applicable).map((r: any) => (
              <tr key={r.rule}><td className="primary-cell">{humanize(r.rule.replace(/^FIPG_/, ''))}<div className="xs muted">v{r.version} · {humanize(r.severity)} · on fail: {humanize(r.action)}</div></td>
                <td>{r.passed === true ? <Status value="ELIGIBLE" label="Pass" /> : r.passed === false ? <Status value={r.action === 'WARN' ? 'WARNING' : 'INELIGIBLE'} label="Fail" /> : <Status value="PENDING" label="Data missing" />}</td>
                <td>{r.actual ?? '—'}</td><td>{r.required}</td><td className="small">{r.passed === true ? '—' : r.explanation}</td></tr>))}</tbody></table>
            <p className="xs muted" style={{ padding: '8px 0 0' }}>Evaluated {dateTime(elig.evaluatedAt)}. Rules not applicable to this request are hidden.</p></div>)}
      </Panel>
      {detail.rework?.length > 0 && <Panel title="Rework history"><ul className="flag-list">{detail.rework.map((r: any) => <li key={r.id}><div className="row between"><strong className="small">{humanize(r.section)}</strong><span className="xs muted">{dateTime(r.raisedAt)}{r.resolvedAt ? ' · resolved' : ''}</span></div><div>{r.message}</div>{r.customerResponse && <div className="evidence">Customer: {r.customerResponse}</div>}</li>)}</ul></Panel>}
    </div>
  );
}

export function CustomerTab({ id, customerId }: { id: string; customerId: string }) {
  const q = useFac<any>(id, 'profile', `/api/customers/${customerId}/profile`);
  return (
    <QueryState q={q}>{() => {
      const { customer, profile, parties, banks, externalFacilities, counterparties, completeness, alternativeBankAccounts } = q.data;
      return (
        <div className="stack">
          <div className="grid cols-2">
            <Panel title={customer.name} actions={<span className="xs muted">{customer.ref}</span>}>
              <KV items={[['RC number', profile.rcNumber], ['TIN', profile.tin], ['Incorporated', date(profile.incorporationDate)], ['Business type', humanize(profile.businessType)], ['Sector', profile.sectorName], ['Industry', profile.industry], ['Address', [profile.addressLine, profile.city, profile.state].filter(Boolean).join(', ')], ['Employees', profile.employeeCount], ['Relationship Manager', customer.relationshipManager?.name], ['Profile', `${completeness.pct}% complete (v${profile.version})`]]} />
            </Panel>
            <Panel title="Business">
              <p className="small">{profile.businessDescription ?? <span className="muted">No description provided.</span>}</p>
              <KV items={[['Products & services', profile.productsServices], ['Value chain', profile.valueChain], ['Footprint', profile.geographicFootprint], ['Litigation', profile.hasLitigation === null ? 'Not declared' : profile.hasLitigation ? profile.litigationDetails : 'None'], ['Regulatory matters', profile.hasRegulatoryMatters === null ? 'Not declared' : profile.hasRegulatoryMatters ? profile.regulatoryDetails : 'None'], ['Alternative Bank accounts', alternativeBankAccounts.map((a: any) => `${a.account} (${a.currency})`).join(', ')]]} />
            </Panel>
          </div>
          <Panel title="Ownership & management" flush>
            {!parties.length ? <Empty title="No parties recorded" /> : <div className="table-wrap"><table className="data"><thead><tr><th>Name</th><th>Capacity</th><th>Ownership</th><th>BVN</th><th>Indicators</th></tr></thead>
              <tbody>{parties.map((p: any) => <tr key={p.id}><td className="primary-cell">{p.fullName}<div className="xs muted">{p.designation}</div></td><td>{humanize(p.partyType)}</td><td>{p.ownershipPct !== null ? `${p.ownershipPct}%` : '—'}</td><td className="mono">{p.bvn || '—'}</td><td>{p.isPep && <Status value="WARNING" label="PEP" />} {p.isInsider && <Status value="WARNING" label="Insider" />}{!p.isPep && !p.isInsider && '—'}</td></tr>)}</tbody></table></div>}
          </Panel>
          <div className="grid cols-2">
            <Panel title="Other banks & facilities" flush>
              {!banks.length && !externalFacilities.length ? <Empty title="None declared" /> : <div className="table-wrap"><table className="data"><tbody>
                {banks.map((b: any) => <tr key={b.id}><td>{b.bankName}</td><td>{b.accountType ?? 'Account'} {b.accountNumberLast4 ? `••••${b.accountNumberLast4}` : ''}</td><td>{b.currency}</td></tr>)}
                {externalFacilities.map((x: any) => <tr key={x.id}><td>{x.lender}</td><td>{x.facilityType}{!x.performing && <> <Status value="OVERDUE" label="Non-performing" /></>}</td><td className="num">{money(x.outstandingMinor, x.currency)} of {money(x.amountMinor, x.currency, { compact: true })}</td></tr>)}
              </tbody></table></div>}
            </Panel>
            <Panel title="Key suppliers & customers" flush>
              {!counterparties.length ? <Empty title="None declared" /> : <div className="table-wrap"><table className="data"><tbody>{counterparties.map((c: any) => <tr key={c.id}><td>{humanize(c.kind)}</td><td className="primary-cell">{c.name}</td><td className="num">{c.sharePct !== null ? `${c.sharePct}%` : '—'}</td></tr>)}</tbody></table></div>}
            </Panel>
          </div>
        </div>
      );
    }}</QueryState>
  );
}

export function DocumentsTab({ id }: { id: string }) {
  const q = useFac<any[]>(id, 'documents', `/api/facilities/${id}/documents`);
  const { can } = useAuth();
  const [review, setReview] = useState<any>(null);
  const [history, setHistory] = useState<any>(null);
  const [adding, setAdding] = useState(false);
  const refresh = useRefresh(id);
  const up = useAction(async (docId: string, file: File) => { await api.upload(`/api/documents/${docId}/upload`, file); await refresh(); });
  const mandatoryOpen = (q.data ?? []).filter((d) => d.mandatory && ['REQUIRED', 'UPLOADED', 'UNDER_REVIEW', 'REJECTED', 'EXPIRED'].includes(d.status)).length;
  return (
    <Section title="Documents" sub={q.data ? `${q.data.length} documents · ${mandatoryOpen} mandatory awaiting action` : undefined} actions={<Button size="sm" onClick={() => setAdding(true)}>Request or add document</Button>}>
      <ErrorAlert error={up.error} />
      <Panel flush>
        <QueryState q={q} empty={<Empty title="No documents" />}>{() => (
          <div className="table-wrap"><table className="data"><thead><tr><th>Document</th><th>Status</th><th>Current file</th><th>Reviewed</th><th className="num">Actions</th></tr></thead>
            <tbody>{q.data!.map((d) => (
              <tr key={d.id}>
                <td className="primary-cell">{d.title}{d.mandatory && <span className="req" title="Mandatory">*</span>}<div className="xs muted">{humanize(d.docType)}{d.expiryDate ? ` · expires ${date(d.expiryDate)}` : ''}{d.customerVisible === false ? ' · internal' : ''}</div>{d.rejectionReason && <div className="xs" style={{ color: 'var(--danger-700)' }}>Rejected: {d.rejectionReason}</div>}</td>
                <td><Status value={d.status} /></td>
                <td className="small">{d.current ? <>v{d.current.version} · {d.current.filename}<div className="xs muted">{bytes(d.current.size)} · scan {humanize(d.current.scan)} · {dateTime(d.current.uploadedAt)}</div></> : <span className="muted">Not uploaded</span>}</td>
                <td className="small">{d.reviewedBy ? <>{d.reviewedBy}<div className="xs muted">{dateTime(d.reviewedAt)}</div></> : '—'}</td>
                <td className="num"><div className="row end" style={{ ['--gap' as any]: '6px' }}>
                  {d.current && <Button size="sm" onClick={() => openDocument(d.id)}>Open</Button>}
                  {d.current && can('document.verify') && ['UPLOADED', 'UNDER_REVIEW', 'REJECTED'].includes(d.status) && <Button size="sm" variant="primary" onClick={() => setReview(d)}>Review</Button>}
                  <label className="btn sm">Upload<input type="file" className="sr-only" accept=".pdf,.png,.jpg,.jpeg,.csv,.xlsx,.docx" onChange={(e) => { const fl = e.target.files?.[0]; if (fl) void up.run(d.id, fl); e.target.value = ''; }} /></label>
                  <Button size="sm" variant="ghost" onClick={() => setHistory(d)}>History</Button>
                </div></td>
              </tr>))}</tbody></table></div>)}</QueryState>
      </Panel>
      {review && <ReviewDrawer doc={review} onClose={() => setReview(null)} onDone={async () => { setReview(null); await refresh(); }} />}
      {history && <HistoryDrawer doc={history} onClose={() => setHistory(null)} />}
      {adding && <AddDocDrawer facilityId={id} onClose={() => setAdding(false)} onDone={async () => { setAdding(false); await refresh(); }} />}
    </Section>
  );
}

function ReviewDrawer({ doc, onClose, onDone }: { doc: any; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState(''); const [expiry, setExpiry] = useState(doc.expiryDate ?? '');
  const act = useAction(async (decision: string) => { await api.post(`/api/documents/${doc.id}/review`, { decision, reason: reason || undefined, expiryDate: expiry || undefined }); onDone(); });
  return (
    <Drawer title={`Review: ${doc.title}`} onClose={onClose} footer={<><Button variant="danger" onClick={() => act.run('REJECTED')} disabled={reason.trim().length < 5} loading={act.loading}>Reject</Button><Button variant="primary" onClick={() => act.run('VERIFIED')} loading={act.loading}>Verify</Button></>}>
      <div className="stack">
        <Button onClick={() => openDocument(doc.id)}>Open file in a new tab</Button>
        <TextInput label="Expiry date (if applicable)" type="date" value={expiry} onChange={(e) => setExpiry(e.target.value)} />
        <TextArea label="Reason for rejection" value={reason} onChange={(e) => setReason(e.target.value)} hint="Shown to the customer. Required to reject." />
        <ErrorAlert error={act.error} />
      </div>
    </Drawer>
  );
}

function HistoryDrawer({ doc, onClose }: { doc: any; onClose: () => void }) {
  const q = useFac<any>(doc.id, 'versions', `/api/documents/${doc.id}/versions`);
  return (
    <Drawer title={`History: ${doc.title}`} onClose={onClose}>
      <QueryState q={q}>{() => (
        <div className="stack">
          <h4>Versions</h4>
          {!q.data.versions.length ? <p className="muted small">No uploads yet.</p> : <div className="table-wrap"><table className="data"><tbody>{q.data.versions.map((v: any) => <tr key={v.id}><td>v{v.version}</td><td className="small">{v.filename}<div className="xs muted">{bytes(v.size)} · {humanize(v.uploadedByType)} · {dateTime(v.uploadedAt)}</div></td><td><Status value={v.scan} /></td></tr>)}</tbody></table></div>}
          <h4>Events</h4>
          <ul className="timeline">{q.data.events.map((e: any, i: number) => <li key={i}><span className="when">{dateTime(e.at)}</span><span>{humanize(e.event)} {e.actor ? `by ${e.actor}` : `(${humanize(e.actorType)})`}{e.note && <div className="small muted">{e.note}</div>}</span></li>)}</ul>
        </div>)}</QueryState>
    </Drawer>
  );
}

function AddDocDrawer({ facilityId, onClose, onDone }: { facilityId: string; onClose: () => void; onDone: () => void }) {
  const [title, setTitle] = useState(''); const [visible, setVisible] = useState(true); const [file, setFile] = useState<File | null>(null);
  const go = useAction(async () => {
    const d = await api.post<{ id: string }>(`/api/facilities/${facilityId}/documents`, { title, customerVisible: visible });
    if (file) await api.upload(`/api/documents/${d.id}/upload`, file);
    onDone();
  });
  return (
    <Drawer title="Request or add a document" onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={title.trim().length < 3} loading={go.loading} onClick={() => go.run()}>Save</Button></>}>
      <div className="stack">
        <TextInput label="Document title" value={title} onChange={(e) => setTitle(e.target.value)} required />
        <label className="check"><input type="checkbox" checked={visible} onChange={(e) => setVisible(e.target.checked)} /><span>Visible to the customer (they can upload it)</span></label>
        <div className="field"><label htmlFor="adddoc">File (optional)</label><input id="adddoc" type="file" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></div>
        <Alert tone="info">Files are malware-scanned and stored encrypted. They are opened only through short-lived, single-use links.</Alert>
        <ErrorAlert error={go.error} />
      </div>
    </Drawer>
  );
}
