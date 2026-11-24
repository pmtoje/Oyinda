import { useState } from 'react';
import { api, openDocument } from '../../../lib/api';
import { useAuth } from '../../../lib/auth';
import { dateTime, humanize } from '../../../lib/format';
import { Alert, Button, Drawer, Empty, ErrorAlert, Panel, SelectInput, Status, TextArea, TextInput, useAction } from '../../../components/ui';
import { QueryState, Section, useFac, useRefresh } from './common';

const lines = (s: string) => s.split('\n').map((x) => x.trim()).filter(Boolean);

export function MemoTab({ id }: { id: string }) {
  const { can } = useAuth();
  const memos = useFac<any[]>(id, 'memo', `/api/facilities/${id}/generated/CREDIT_MEMO`);
  const sheets = useFac<any[]>(id, 'termsheet', `/api/facilities/${id}/generated/TERM_SHEET`);
  const [memoOpen, setMemoOpen] = useState(false);
  const [sheetEdit, setSheetEdit] = useState(false);
  const [sheetView, setSheetView] = useState(false);
  const refresh = useRefresh(id);
  const genSheet = useAction(async () => { await api.post(`/api/facilities/${id}/term-sheet`, {}); await refresh(); });
  const latest = memos.data?.[0];
  const es = latest?.content?.executiveSummary;
  return (
    <div className="stack">
      <EfficiencyPanel id={id} />
      <Section title="Credit memorandum" sub="Assembled from the analysis in Credit360; your recommendation and commentary are added. Each generation is a new, immutable version (Word)."
        actions={can('memo.generate') && <Button size="sm" variant="primary" onClick={() => setMemoOpen(true)}>{latest ? 'Generate new version' : 'Generate memo'}</Button>}>
        <QueryState q={memos} empty={<Panel><Empty title="No credit memo yet">Complete the analysis tabs, then generate the memo.</Empty></Panel>}>{() => (
          <div className="stack">
            {es && (
              <Panel title={`Executive summary — v${latest.version}`} actions={<Button size="sm" onClick={() => openDocument(latest.documentId, 'attachment')}>Download .docx</Button>}>
                <div className="grid cols-2">
                  <div className="stack" style={{ ['--gap' as any]: '6px' }}>
                    <div><strong>{es.customer}</strong> — {es.product}, {es.requestedAmount} over {es.tenor}</div>
                    <div className="small">{es.purpose}</div>
                    <div className="small">Risk grade <strong>{es.riskGrade}</strong> · Security {es.security} · E&S {es.esCategory}</div>
                    <div className="small">RARORAC {es.rarorac}</div>
                    <div className="small">Recommendation: <Status value={es.recommendation === 'DECLINE' ? 'DECLINED' : 'APPROVED'} label={humanize(es.recommendation)} /></div>
                  </div>
                  <div><h4>Key metrics</h4><div className="table-wrap"><table className="data"><tbody>{es.keyMetrics.map((m: any) => <tr key={m.label}><td className="small">{m.label}</td><td className="num">{m.value}</td></tr>)}</tbody></table></div></div>
                </div>
                {es.keyRisks.length > 0 && <><h4 style={{ marginTop: 12 }}>Key risks</h4><ul className="small">{es.keyRisks.map((r: string, i: number) => <li key={i}>{r}</li>)}</ul></>}
                {es.conditions.length > 0 && <><h4>Conditions</h4><ul className="small">{es.conditions.map((r: string, i: number) => <li key={i}>{r}</li>)}</ul></>}
              </Panel>)}
            <Panel title="Versions" flush><div className="table-wrap"><table className="data"><thead><tr><th>Version</th><th>Prepared by</th><th>Generated</th><th /></tr></thead><tbody>{memos.data!.map((m) => <tr key={m.id}><td>v{m.version}</td><td>{m.generatedBy}</td><td className="small">{dateTime(m.createdAt)}</td><td className="num"><Button size="sm" onClick={() => openDocument(m.documentId, 'attachment')}>Download</Button></td></tr>)}</tbody></table></div></Panel>
          </div>)}</QueryState>
      </Section>
      <Section title="Combined term sheet" sub="ORR, FRR, financial analysis, collateral, E&S, approval workflow, votes, comments and decisions, with names and timestamps. Edits create a new version; earlier versions are kept."
        actions={can('memo.generate') && <><Button size="sm" onClick={() => genSheet.run()} loading={genSheet.loading}>Generate term sheet</Button>{sheets.data?.length ? <Button size="sm" onClick={() => setSheetEdit(true)}>Edit (new version)</Button> : null}</>}>
        {sheets.data?.length ? <div className="row"><Button size="sm" onClick={() => setSheetView(true)}>View latest</Button><span className="xs muted">Updated automatically at submission and at every decision. Format: the Bank's Credit Approval Memo.</span></div> : null}
        <ErrorAlert error={genSheet.error} />
        <Panel flush><QueryState q={sheets} empty={<Empty title="No term sheet generated" />}>{() => (
          <div className="table-wrap"><table className="data"><thead><tr><th>Version</th><th>Based on</th><th>Reason</th><th>By</th><th>Generated</th><th /></tr></thead>
            <tbody>{sheets.data!.map((s) => <tr key={s.id}><td>v{s.version}</td><td>{s.basedOn ? `v${s.basedOn}` : '—'}</td><td className="small">{s.editReason ?? '—'}</td><td>{s.generatedBy}</td><td className="small">{dateTime(s.createdAt)}</td><td className="num"><Button size="sm" onClick={() => openDocument(s.documentId, 'attachment')}>Download .docx</Button></td></tr>)}</tbody></table></div>)}</QueryState></Panel>
      </Section>
      {memoOpen && <MemoDrawer id={id} onClose={() => setMemoOpen(false)} onDone={async () => { setMemoOpen(false); await refresh(); }} />}
      {sheetEdit && <SheetEditDrawer id={id} latest={sheets.data?.[0]} onClose={() => setSheetEdit(false)} onDone={async () => { setSheetEdit(false); await refresh(); }} />}
      {sheetView && sheets.data?.[0] && <SheetViewDrawer latest={sheets.data[0]} onClose={() => setSheetView(false)} />}
    </div>
  );
}

function MemoDrawer({ id, onClose, onDone }: { id: string; onClose: () => void; onDone: () => void }) {
  const [v, setV] = useState({ recommendation: 'APPROVE_WITH_CONDITIONS', commentary: '', mitigants: '', conditions: '', additionalRisks: '' });
  const go = useAction(async () => { await api.post(`/api/facilities/${id}/memo`, { recommendation: v.recommendation, commentary: v.commentary, mitigants: lines(v.mitigants), conditions: lines(v.conditions), additionalRisks: lines(v.additionalRisks) }); onDone(); });
  return (
    <Drawer title="Generate credit memo" onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={v.commentary.trim().length < 20} loading={go.loading} onClick={() => go.run()}>Generate</Button></>}>
      <div className="stack">
        <SelectInput label="Analyst recommendation" value={v.recommendation} onChange={(e) => setV({ ...v, recommendation: e.target.value })} options={[{ value: 'APPROVE', label: 'Approve' }, { value: 'APPROVE_WITH_CONDITIONS', label: 'Approve with conditions' }, { value: 'DECLINE', label: 'Decline' }]} />
        <TextArea label="Analyst commentary" value={v.commentary} onChange={(e) => setV({ ...v, commentary: e.target.value })} required hint="At least 20 characters. You can draft this with AI assist, then edit." style={{ minHeight: 160 }} />
        <TextArea label="Mitigants (one per line)" value={v.mitigants} onChange={(e) => setV({ ...v, mitigants: e.target.value })} />
        <TextArea label="Conditions (one per line)" value={v.conditions} onChange={(e) => setV({ ...v, conditions: e.target.value })} />
        <TextArea label="Additional risks (one per line)" value={v.additionalRisks} onChange={(e) => setV({ ...v, additionalRisks: e.target.value })} hint="System risk flags are included automatically." />
        <ErrorAlert error={go.error} />
      </div>
    </Drawer>
  );
}

const CAM_FIELDS: [string, string][] = [
  ['natureOfBusiness', '4. Nature of business'], ['operations', '4. Products, production processes & operations'], ['strategy', '4. Strategies & industry position'], ['milestones', '4. Past successes and milestones'],
  ['creditStatusOtherBanks', '4. Credit status from other banks, suppliers and competitors'], ['corporateStructure', '5. Corporate structure and organisation'], ['boardProfile', '6. Profile of the board of directors'], ['managementProfile', '6. Profile of key management staff'],
  ['industryAnalysis', '7. Industry analysis / relationship update'], ['environment', '7. Operating environment'], ['swot', '8. SWOT analysis'], ['financialAnalysisComment', '9. Financial analysis comment'], ['projectedCashflow', '10. Projected cash flow comment'],
  ['valueChain', '15. Value chain eco-conversion'], ['raroacComment', '18. RAROC & relationship strategy comment'], ['remarks', '22. Remarks'], ['criticalIssues', '23. Critical credit issues (one per line)'], ['transactionDynamics', '24. Transaction dynamics'],
  ['facilityEfficiencyRatio', '25. Facility efficiency ratio'], ['justification', '26. Justification for the request'], ['purpose', '16. Purpose (override)'], ['decisionNote', '27. Decision note'],
];

function SheetEditDrawer({ id, latest, onClose, onDone }: { id: string; latest: any; onClose: () => void; onDone: () => void }) {
  const initial: Record<string, string> = latest?.content?.overrides ?? {};
  const [v, setV] = useState<Record<string, string>>(initial);
  const [reason, setReason] = useState('');
  const changed = Object.fromEntries(Object.entries(v).filter(([k, x]) => (x ?? '') !== (initial[k] ?? '') && x.trim()));
  const go = useAction(async () => { await api.post(`/api/facilities/${id}/term-sheet`, { overrides: changed, reason }); onDone(); });
  return (
    <Drawer title="Edit combined term sheet (Credit Approval Memo)" onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={reason.trim().length < 5 || !Object.keys(changed).length} loading={go.loading} onClick={() => go.run()}>Create new version</Button></>}>
      <div className="stack">
        <Alert tone="info">Narrative sections are yours to write; figures, ratings, statements, collateral and the approval workflow come from the record and cannot be edited here. The previous version is kept, and your text carries into later automatic updates.</Alert>
        {CAM_FIELDS.map(([k, label]) => <TextArea key={k} label={label} value={v[k] ?? ''} onChange={(e) => setV({ ...v, [k]: e.target.value })} />)}
        <TextInput label="Reason for edit" value={reason} onChange={(e) => setReason(e.target.value)} required />
        <ErrorAlert error={go.error} />
      </div>
    </Drawer>
  );
}

function SheetViewDrawer({ latest, onClose }: { latest: any; onClose: () => void }) {
  const sections: any[] = latest?.content?.sections ?? [];
  return (
    <Drawer title={`Combined term sheet v${latest.version}`} onClose={onClose} footer={<><Button onClick={onClose}>Close</Button><Button variant="primary" onClick={() => openDocument(latest.documentId, 'attachment')}>Download .docx</Button></>}>
      <div className="stack doc-view">
        {sections.map((sec, i) => (
          <section key={i}>
            <h4>{sec.heading}</h4>
            {(sec.paragraphs ?? []).filter(Boolean).map((p: string, j: number) => <p key={j} className="small">{p}</p>)}
            {sec.bullets?.length > 0 && <ul className="small">{sec.bullets.map((b: string, j: number) => <li key={j}>{b}</li>)}</ul>}
            {sec.table?.rows?.length > 0 && <div className="table-wrap"><table className="data"><thead><tr>{sec.table.headers.map((h: string) => <th key={h}>{h}</th>)}</tr></thead><tbody>{sec.table.rows.map((r: any[], j: number) => <tr key={j}>{r.map((c, k) => <td key={k} className="small">{c ?? '—'}</td>)}</tr>)}</tbody></table></div>}
          </section>
        ))}
      </div>
    </Drawer>
  );
}

/** CAM §25: the facility efficiency ratio under the definition currently in force. */
function EfficiencyPanel({ id }: { id: string }) {
  const q = useFac<any>(id, 'efficiency', `/api/facilities/${id}/efficiency-ratio`);
  if (!q.data) return null;
  const e = q.data;
  if (!e.configured) return <Alert tone="info" title="Facility efficiency ratio not defined">No definition is in force. An administrator sets it under Configuration → Facility efficiency ratio on management’s or the Board’s direction; it then appears here and in section 25 of the term sheet.</Alert>;
  const fmt = (v: number | null) => (v === null ? '—' : e.unit === '%' ? `${v.toFixed(2)}%` : e.unit === 'x' ? `${v.toFixed(2)}×` : e.unit === 'days' ? `${Math.round(v)} days` : e.unit === 'NGN' ? `₦${v.toLocaleString('en-NG')}` : v.toFixed(4));
  return (
    <Panel title={e.name} actions={<span className="xs muted">Definition v{e.version} · {e.directedBy === 'BOARD' ? 'Board' : 'Management'} direction {e.directionReference}</span>}>
      <div className="row" style={{ alignItems: 'baseline', gap: 12 }}>
        <div className="metric" style={{ minWidth: 160 }}><div className="label">Value</div><div className="value">{fmt(e.value)}</div>{e.band && <div className="sub">{e.band.label}</div>}</div>
        <div className="small" style={{ flex: 1 }}>
          <div className="mono xs">{e.formula}</div>
          {e.band && <p style={{ margin: '6px 0 0' }}>{e.band.assessment}</p>}
          {e.value === null && <p style={{ margin: '6px 0 0' }}>Not computed yet: {e.missing.length ? `waiting for ${e.missing.join(', ')}` : e.error}.</p>}
        </div>
      </div>
    </Panel>
  );
}

const USE_CASES = [
  { key: 'EXECUTIVE_SUMMARY', label: 'Executive summary', desc: 'A concise summary for the approving executive.' },
  { key: 'RISK_EXPLANATION', label: 'Explain risk flags', desc: 'Each risk explained with its evidence.' },
  { key: 'MEMO_COMMENTARY_DRAFT', label: 'Draft memo commentary', desc: 'A first draft for you to edit.' },
];

export function AiTab({ id }: { id: string }) {
  const { can } = useAuth();
  const q = useFac<any[]>(id, 'ai', `/api/facilities/${id}/ai`);
  const refresh = useRefresh(id);
  const run = useAction(async (uc: string) => { await api.post(`/api/facilities/${id}/ai/${uc}`); await refresh(); });
  const review = useAction(async (iid: string, decision: string) => { await api.post(`/api/ai/${iid}/review`, { decision }); await refresh(); });
  if (!can('ai.use')) return <Panel><Empty title="AI assistance is not enabled for your role" /></Panel>;
  return (
    <div className="stack">
      <Alert tone="info" title="AI assists; people decide">Outputs use only data you can already see in Credit360. Every statement cites its sources; statements that cannot be traced to a source, or that attempt a credit decision, are removed. Review each output before relying on it.</Alert>
      <div className="grid cols-3">{USE_CASES.map((u) => <button key={u.key} className="choice" onClick={() => run.run(u.key)} disabled={run.loading}><div className="title">{u.label}</div><div className="desc">{u.desc}</div></button>)}</div>
      {run.loading && <p className="small muted"><span className="spinner" /> Generating…</p>}
      <ErrorAlert error={run.error ?? review.error} />
      <QueryState q={q} empty={<Empty title="No AI outputs yet" />}>{() => (
        <div className="stack">{q.data!.map((o) => (
          <Panel key={o.id} title={humanize(o.useCase)} actions={<><span className="xs muted">{o.provider} · {o.model} {o.modelVersion} · {dateTime(o.createdAt)}</span><Status value={o.reviewStatus === 'PENDING_REVIEW' ? 'PENDING' : o.reviewStatus} label={humanize(o.reviewStatus)} /></>}
            footer={o.reviewStatus === 'PENDING_REVIEW' && <div className="row end"><Button size="sm" variant="danger" onClick={() => review.run(o.id, 'REJECTED')}>Reject</Button><Button size="sm" variant="primary" onClick={() => review.run(o.id, 'ACCEPTED')}>Accept</Button></div>}>
            <div className="stack" style={{ ['--gap' as any]: '10px' }}>
              {o.refused && <Alert tone="warn">The model declined this request. No output was produced.</Alert>}
              {o.summary && <p style={{ margin: 0 }}>{o.summary}</p>}
              <ol className="small" style={{ margin: 0, paddingLeft: 18 }}>{o.claims.map((c: any, i: number) => <li key={i} style={{ marginBottom: 6 }}>{c.text}<div className="evidence">{c.sources.map((s: any) => <div key={s.id}>[{s.id}] {s.label}{s.value ? `: ${s.value}` : ''} <span className="xs muted">({s.ref?.table})</span></div>)}</div></li>)}</ol>
              {o.rejectedClaims?.length > 0 && <Alert tone="warn" title={`${o.rejectedClaims.length} statement(s) removed by validation`}><ul>{o.rejectedClaims.map((r: any, i: number) => <li key={i}>“{r.claim.text}” — {r.reason}</li>)}</ul></Alert>}
              {o.injectionFlags?.length > 0 && <Alert tone="danger" title="Possible prompt injection in customer-supplied text">{o.injectionFlags.join('; ')}. The text was neutralised and treated as data only.</Alert>}
              <div className="xs muted">{o.disclaimer}</div>
            </div>
          </Panel>))}</div>)}</QueryState>
    </div>
  );
}
