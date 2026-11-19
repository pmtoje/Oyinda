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
  const refresh = useRefresh(id);
  const genSheet = useAction(async () => { await api.post(`/api/facilities/${id}/term-sheet`, {}); await refresh(); });
  const latest = memos.data?.[0];
  const es = latest?.content?.executiveSummary;
  return (
    <div className="stack">
      <Section title="Credit memorandum" sub="Assembled from the analysis in Gazelle; your recommendation and commentary are added. Each generation is a new, immutable version (Word)."
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
                  <div><h4>Key metrics</h4><table className="data"><tbody>{es.keyMetrics.map((m: any) => <tr key={m.label}><td className="small">{m.label}</td><td className="num">{m.value}</td></tr>)}</tbody></table></div>
                </div>
                {es.keyRisks.length > 0 && <><h4 style={{ marginTop: 12 }}>Key risks</h4><ul className="small">{es.keyRisks.map((r: string, i: number) => <li key={i}>{r}</li>)}</ul></>}
                {es.conditions.length > 0 && <><h4>Conditions</h4><ul className="small">{es.conditions.map((r: string, i: number) => <li key={i}>{r}</li>)}</ul></>}
              </Panel>)}
            <Panel title="Versions" flush><table className="data"><thead><tr><th>Version</th><th>Prepared by</th><th>Generated</th><th /></tr></thead><tbody>{memos.data!.map((m) => <tr key={m.id}><td>v{m.version}</td><td>{m.generatedBy}</td><td className="small">{dateTime(m.createdAt)}</td><td className="num"><Button size="sm" onClick={() => openDocument(m.documentId, 'attachment')}>Download</Button></td></tr>)}</tbody></table></Panel>
          </div>)}</QueryState>
      </Section>
      <Section title="Combined term sheet" sub="ORR, FRR, financial analysis, collateral, E&S, approval workflow, votes, comments and decisions, with names and timestamps. Edits create a new version; earlier versions are kept."
        actions={can('memo.generate') && <><Button size="sm" onClick={() => genSheet.run()} loading={genSheet.loading}>Generate term sheet</Button>{sheets.data?.length ? <Button size="sm" onClick={() => setSheetEdit(true)}>Edit (new version)</Button> : null}</>}>
        <ErrorAlert error={genSheet.error} />
        <Panel flush><QueryState q={sheets} empty={<Empty title="No term sheet generated" />}>{() => (
          <table className="data"><thead><tr><th>Version</th><th>Based on</th><th>Reason</th><th>By</th><th>Generated</th><th /></tr></thead>
            <tbody>{sheets.data!.map((s) => <tr key={s.id}><td>v{s.version}</td><td>{s.basedOn ? `v${s.basedOn}` : '—'}</td><td className="small">{s.editReason ?? '—'}</td><td>{s.generatedBy}</td><td className="small">{dateTime(s.createdAt)}</td><td className="num"><Button size="sm" onClick={() => openDocument(s.documentId, 'attachment')}>Download .docx</Button></td></tr>)}</tbody></table>)}</QueryState></Panel>
      </Section>
      {memoOpen && <MemoDrawer id={id} onClose={() => setMemoOpen(false)} onDone={async () => { setMemoOpen(false); await refresh(); }} />}
      {sheetEdit && <SheetEditDrawer id={id} onClose={() => setSheetEdit(false)} onDone={async () => { setSheetEdit(false); await refresh(); }} />}
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

function SheetEditDrawer({ id, onClose, onDone }: { id: string; onClose: () => void; onDone: () => void }) {
  const [purpose, setPurpose] = useState(''); const [note, setNote] = useState(''); const [reason, setReason] = useState('');
  const go = useAction(async () => { await api.post(`/api/facilities/${id}/term-sheet`, { overrides: { ...(purpose ? { purpose } : {}), ...(note ? { decisionNote: note } : {}) }, reason }); onDone(); });
  return (
    <Drawer title="Edit term sheet" onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={reason.trim().length < 5 || (!purpose && !note)} loading={go.loading} onClick={() => go.run()}>Create new version</Button></>}>
      <div className="stack">
        <Alert tone="info">The previous version is kept unchanged. Computed sections (ratings, workflow, votes) always reflect the record.</Alert>
        <TextArea label="Purpose (override)" value={purpose} onChange={(e) => setPurpose(e.target.value)} />
        <TextArea label="Decision note" value={note} onChange={(e) => setNote(e.target.value)} />
        <TextInput label="Reason for edit" value={reason} onChange={(e) => setReason(e.target.value)} required />
        <ErrorAlert error={go.error} />
      </div>
    </Drawer>
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
      <Alert tone="info" title="AI assists; people decide">Outputs use only data you can already see in Gazelle. Every statement cites its sources; statements that cannot be traced to a source, or that attempt a credit decision, are removed. Review each output before relying on it.</Alert>
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
