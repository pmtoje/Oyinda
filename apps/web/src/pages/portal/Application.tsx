import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { APPLICATION_STEPS } from '@gazelle/shared';
import { Alert, Button, Check, ErrorAlert, KV, Loading, PageHeader, Panel, Status, TextArea, useAction } from '../../components/ui';
import { ApiError, api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { dateTime, humanize, majorInput, money, toMinor } from '../../lib/format';
import { DocumentList } from './parts/Documents';
import { EmailVerifyCard } from './parts/EmailVerify';
import { BankStatementsStep, DetailsStep, FinancialsStep, ProductStep, SecurityStep } from './parts/ApplicationSteps';

const STEP_HELP: Record<string, string> = {
  DETAILS: 'Tell us how much you need, for how long and how it will be paid.',
  PRODUCT_INFO: 'Details specific to this product, used to structure the transaction.',
  SECURITY: 'The security you propose. The credit team will confirm what is required.',
  FINANCIALS: 'Your financial performance over recent years.',
  BANK_STATEMENTS: 'Account activity at Alternative Bank and other banks.',
  DOCUMENTS: 'Supporting documents required for this request.',
  REVIEW: 'Check everything and submit to your relationship manager.',
};
const FORM_KEYS = ['currency', 'amount', 'tenorMonths', 'purpose', 'paymentStructure', 'paymentFrequency', 'sourceOfPayment', 'supplierName', 'underlyingAsset', 'projectDetails', 'proposedSecurity'];

export default function Application() {
  const { id } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const { me } = useAuth();
  const q = useQuery({ queryKey: ['facility', id], queryFn: () => api.get<any>(`/api/facilities/${id}`) });
  const [v, setV] = useState<any>(null);
  const [step, setStep] = useState<string>('DETAILS');
  const [dirty, setDirty] = useState(false);
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [stale, setStale] = useState(false);
  const rowVersion = useRef<number>(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    if (!q.data || v) return;
    const f = q.data.facility;
    rowVersion.current = f.rowVersion;
    setV({ currency: f.currency, amount: majorInput(f.amountMinor), tenorMonths: f.tenorMonths ?? '', purpose: f.purpose ?? '', paymentStructure: f.paymentStructure ?? '', paymentFrequency: f.paymentFrequency ?? '', sourceOfPayment: f.sourceOfPayment ?? '', supplierName: f.supplierName ?? '', underlyingAsset: f.underlyingAsset ?? '', projectDetails: f.projectDetails ?? '', proposedSecurity: f.proposedSecurity ?? '', productFields: f.productFields ?? {} });
    setStep(f.status === 'RETURNED' ? 'REVIEW' : f.currentStep === 'PRODUCT' ? 'DETAILS' : f.currentStep);
  }, [q.data, v]);

  const body = useCallback((extra: Record<string, unknown> = {}) => {
    const b: Record<string, unknown> = { rowVersion: rowVersion.current, ...extra };
    if (!v) return b;
    for (const k of FORM_KEYS) {
      if (k === 'amount') b.amountMinor = v.amount === '' ? null : toMinor(v.amount);
      else if (k === 'tenorMonths') b.tenorMonths = v.tenorMonths === '' ? null : Number(v.tenorMonths);
      else if (k === 'currency') b.currency = v.currency;
      else if (k === 'paymentFrequency') b.paymentFrequency = v.paymentFrequency || null;
      else b[k] = v[k] === '' ? null : v[k];
    }
    b.productFields = v.productFields;
    return b;
  }, [v]);

  const patch = useCallback(async (extra: Record<string, unknown> = {}) => {
    try {
      const r = await api.patch<any>(`/api/facilities/${id}`, body(extra));
      rowVersion.current = r.rowVersion; setDirty(false); setSavedAt(new Date());
      return r;
    } catch (e) {
      if (e instanceof ApiError && e.code === 'STALE') setStale(true);
      throw e;
    }
  }, [body, id]);

  // Autosave safe draft data shortly after the customer stops typing.
  useEffect(() => {
    if (!dirty) return;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => { patch().catch(() => undefined); }, 2500);
    return () => clearTimeout(timer.current);
  }, [dirty, v, patch]);

  const next = useAction(async () => {
    clearTimeout(timer.current);
    await patch({ step, completeStep: true });
    await qc.invalidateQueries({ queryKey: ['facility', id] });
    const i = APPLICATION_STEPS.findIndex((s) => s.key === step);
    setStep(APPLICATION_STEPS[Math.min(i + 1, APPLICATION_STEPS.length - 1)].key);
    window.scrollTo({ top: 0 });
  });
  const saveLater = useAction(async () => { clearTimeout(timer.current); await patch({ step }); nav('/portal'); });

  if (q.isLoading || !v) return q.error ? <ErrorAlert error={q.error} /> : <Loading rows={6} />;
  const d = q.data;
  const f = d.facility;
  if (!['DRAFT', 'RETURNED'].includes(f.status)) return <Navigate to={`/portal/facilities/${id}`} replace />;
  const set = (k: string, x: any) => { setV((o: any) => ({ ...o, [k]: x })); setDirty(true); };
  const setField = (k: string, x: any) => { setV((o: any) => ({ ...o, productFields: { ...o.productFields, [k]: x } })); setDirty(true); };
  const openRework = (d.rework ?? []).filter((r: any) => !r.resolvedAt);
  const reworkSections = new Set(openRework.map((r: any) => r.section));
  const stepMeta = d.steps.find((s: any) => s.key === step);
  const label = APPLICATION_STEPS.find((s) => s.key === step)?.label;

  return (
    <div className="stack" style={{ ['--gap' as any]: '20px' }}>
      <PageHeader crumbs={<><Link to="/portal">Overview</Link> / {f.ref}</>} eyebrow={f.ref} title={`${d.product.name} request`}
        sub={f.status === 'RETURNED' ? 'Returned to you for attention. Address the highlighted items and resubmit.' : 'Complete each section. Your progress is saved automatically.'}
        actions={<><span className="small muted" role="status" aria-live="polite">{stale ? 'Changed elsewhere' : dirty ? 'Unsaved changes' : savedAt ? `Saved ${dateTime(savedAt)}` : 'All changes saved'}</span><Status value={f.status} label={f.statusLabel} /></>} />

      {stale && <Alert tone="warn" title="This request was updated in another window or by your relationship manager."><Button size="sm" onClick={() => window.location.reload()}>Reload the latest version</Button></Alert>}
      {openRework.length > 0 && (
        <Alert tone="warn" title={`${openRework.length} item(s) need your attention`}>
          <ul>{openRework.map((r: any) => <li key={r.id}><strong>{humanize(r.section)}:</strong> {r.message}{r.customerResponse ? ' — responded' : ''}</li>)}</ul>
        </Alert>
      )}

      <nav aria-label="Application steps">
        <ol className="stepper">
          {APPLICATION_STEPS.filter((s) => s.key !== 'PRODUCT').map((s) => {
            const meta = d.steps.find((x: any) => x.key === s.key);
            const cls = s.key === step ? 'current' : reworkSections.has(s.key) ? 'attention' : meta?.completed ? 'done' : '';
            return <li key={s.key} className={cls} aria-current={s.key === step ? 'step' : undefined}><button onClick={() => setStep(s.key)}>{s.label}</button></li>;
          })}
        </ol>
      </nav>

      <div className="workspace">
        <Panel title={label} footer={step === 'REVIEW' ? undefined : (
          <div className="row between">
            <Button variant="ghost" onClick={() => saveLater.run()} loading={saveLater.loading}>Save and continue later</Button>
            <Button variant="primary" onClick={() => next.run()} loading={next.loading}>Save and continue</Button>
          </div>)}>
          <p className="muted small">{STEP_HELP[step]}</p>
          {next.error && !(next.error instanceof ApiError && next.error.code === 'STEP_INCOMPLETE') ? <ErrorAlert error={next.error} /> : null}
          {next.error instanceof ApiError && next.error.code === 'STEP_INCOMPLETE' && <Alert tone="danger" title="Some fields in this section need attention." />}
          {step === 'DETAILS' && <DetailsStep v={v} set={set} product={d.product} error={next.error} />}
          {step === 'PRODUCT_INFO' && <ProductStep v={v} set={set} setField={setField} product={d.product} error={next.error} />}
          {step === 'SECURITY' && <SecurityStep v={v} set={set} error={next.error} />}
          {step === 'FINANCIALS' && <FinancialsStep customerId={f.customerId} />}
          {step === 'BANK_STATEMENTS' && <BankStatementsStep facilityId={f.id} />}
          {step === 'DOCUMENTS' && <DocumentList docs={d.documents} onChange={() => qc.invalidateQueries({ queryKey: ['facility', id] })} attentionKeys={openRework.map((r: any) => r.targetRef).filter(Boolean)} />}
          {step === 'REVIEW' && <Review d={d} v={v} emailVerified={!!me?.user?.emailVerified} rowVersion={rowVersion} flush={() => (dirty ? patch() : Promise.resolve())} onSubmitted={() => nav(`/portal/facilities/${id}`)} reload={() => qc.invalidateQueries({ queryKey: ['facility', id] })} />}
        </Panel>
        <aside className="action-rail">
          <Panel title="Your request">
            <KV items={[['Product', d.product.name], ['Amount', v.amount ? money(toMinor(v.amount), v.currency) : '—'], ['Tenor', v.tenorMonths ? `${v.tenorMonths} months` : '—'], ['Reference', <span className="mono" key="r">{f.ref}</span>]]} />
          </Panel>
          <Panel title="What happens next">
            <ol className="vsteps small">
              <li className="current">You complete and submit the request</li>
              <li>Your relationship manager reviews it</li>
              <li>The credit team assesses the facility</li>
              <li>The approving authority decides</li>
              <li>You receive an offer letter to accept</li>
            </ol>
            {stepMeta?.issues ? <p className="xs muted">{stepMeta.issues} item(s) outstanding in this section.</p> : null}
          </Panel>
        </aside>
      </div>
    </div>
  );
}

function Review({ d, v, emailVerified, rowVersion, flush, onSubmitted, reload }: { d: any; v: any; emailVerified: boolean; rowVersion: React.MutableRefObject<number>; flush: () => Promise<unknown>; onSubmitted: () => void; reload: () => void }) {
  const [declared, setDeclared] = useState(false);
  const [responses, setResponses] = useState<Record<string, string>>({});
  const [elig, setElig] = useState<any>(d.eligibility);
  const check = useAction(async () => { await flush(); setElig(await api.post(`/api/facilities/${d.facility.id}/eligibility`)); });
  const respond = useAction(async (rid: string) => { await api.post(`/api/facilities/${d.facility.id}/rework/${rid}/respond`, { response: responses[rid] }); reload(); });
  const submit = useAction(async () => {
    await flush();
    const fresh = await api.get<any>(`/api/facilities/${d.facility.id}`);
    rowVersion.current = fresh.facility.rowVersion;
    await api.post(`/api/facilities/${d.facility.id}/submit`, { rowVersion: rowVersion.current, declaration: true });
    onSubmitted();
  });
  const err = submit.error as ApiError | null;
  const issues = err?.code === 'INCOMPLETE' ? err.details : d.issues;
  const missingDocs = d.documents.filter((x: any) => x.mandatory && ['REQUIRED', 'REJECTED', 'EXPIRED'].includes(x.status));
  const rework = (d.rework ?? []).filter((r: any) => !r.resolvedAt);
  return (
    <div className="stack">
      {!emailVerified && <EmailVerifyCard />}
      {rework.length > 0 && (
        <section className="stack"><h4>Respond to the Bank</h4>
          {rework.map((r: any) => (
            <div key={r.id} className="panel"><div className="panel-body stack" style={{ ['--gap' as any]: '8px' }}>
              <div><strong>{humanize(r.section)}</strong> — {r.message}</div>
              {r.customerResponse ? <div className="small">Your response: {r.customerResponse}</div> : (
                <><TextArea label="Your response" value={responses[r.id] ?? ''} onChange={(e) => setResponses({ ...responses, [r.id]: e.target.value })} /><div><Button size="sm" onClick={() => respond.run(r.id)} disabled={(responses[r.id] ?? '').trim().length < 3} loading={respond.loading}>Save response</Button></div></>
              )}
            </div></div>
          ))}
        </section>
      )}
      <section><h4>Summary</h4>
        <KV items={[['Facility', d.product.name], ['Amount', v.amount ? money(toMinor(v.amount), v.currency) : '—'], ['Tenor', v.tenorMonths ? `${v.tenorMonths} months` : '—'], ['Payment', humanize(v.paymentFrequency)], ['Purpose', v.purpose], ['Security', v.proposedSecurity]]} />
      </section>
      {(issues?.length > 0 || missingDocs.length > 0) ? (
        <Alert tone="warn" title="Before you submit">
          <ul>{(issues ?? []).map((i: any, n: number) => <li key={n}>{humanize(i.step)}: {i.message}</li>)}{err?.code !== 'INCOMPLETE' && missingDocs.map((x: any) => <li key={x.id}>Documents: {x.title} is required.</li>)}</ul>
        </Alert>
      ) : <Alert tone="ok" title="All sections are complete." />}
      <section className="stack" style={{ ['--gap' as any]: '8px' }}>
        <div className="row between"><h4>Initial eligibility</h4><Button size="sm" onClick={() => check.run()} loading={check.loading}>Check eligibility</Button></div>
        {elig ? <>
          <div><Status value={elig.status} label={elig.status === 'MEETS_INITIAL_CRITERIA' ? 'Meets initial criteria' : elig.status === 'FURTHER_REVIEW' ? 'Further review by the credit team' : 'Does not meet the criteria'} /></div>
          {elig.points?.length > 0 && <ul className="small">{elig.points.map((p: string, i: number) => <li key={i}>{p}</li>)}</ul>}
          <p className="xs muted">This is an initial screen only. It is not a credit decision.</p>
        </> : <p className="small muted">Check how your request compares with the Bank's initial criteria before submitting.</p>}
        <ErrorAlert error={check.error} />
      </section>
      {err && err.code === 'INELIGIBLE' && <Alert tone="danger" title={err.message}><ul>{(err.details?.points ?? []).map((p: string, i: number) => <li key={i}>{p}</li>)}</ul><p className="small">Contact your relationship manager to discuss alternatives.</p></Alert>}
      {err && !['INCOMPLETE', 'INELIGIBLE'].includes(err.code) && <ErrorAlert error={err} />}
      <Check label="I confirm that the information in this request is true and complete, that I am authorised to make it on behalf of the business, and that the Bank may verify it, including through credit bureau enquiries." checked={declared} onChange={(e) => setDeclared(e.target.checked)} />
      <div className="row end"><Button variant="primary" size="lg" disabled={!declared || !emailVerified} loading={submit.loading} onClick={() => submit.run()}>{d.facility.status === 'RETURNED' ? 'Resubmit request' : 'Submit request'}</Button></div>
    </div>
  );
}
