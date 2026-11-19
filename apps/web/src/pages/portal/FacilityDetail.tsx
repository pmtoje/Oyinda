import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, ErrorAlert, KV, Loading, PageHeader, Panel, Status, Tabs } from '../../components/ui';
import { api } from '../../lib/api';
import { dateTime, humanize } from '../../lib/format';
import { DocumentList } from './parts/Documents';
import { Threads } from './parts/Threads';
import { AccountTab, ConditionsTab, OfferTab } from './parts/Offer';

const JOURNEY = [
  ['Submitted', ['SUBMITTED', 'IN_REVIEW', 'RETURNED']],
  ['Under review', ['IN_REVIEW', 'RETURNED']],
  ['Decision', ['APPROVED', 'DECLINED']],
  ['Offer', ['OFFER_ISSUED', 'IN_NEGOTIATION', 'OFFER_ACCEPTED', 'OFFER_REJECTED']],
  ['Documentation', ['FULFILMENT', 'READY_FOR_ACTIVATION']],
  ['Active', ['ACTIVE', 'CLOSED']],
] as const;
const ORDER = ['DRAFT', 'SUBMITTED', 'IN_REVIEW', 'RETURNED', 'APPROVED', 'DECLINED', 'OFFER_ISSUED', 'IN_NEGOTIATION', 'OFFER_REJECTED', 'OFFER_ACCEPTED', 'FULFILMENT', 'READY_FOR_ACTIVATION', 'ACTIVE', 'CLOSED'];

export default function FacilityDetail() {
  const params = useParams();
  const id = params.id!;
  const tab = (params['*'] || 'overview').split('/')[0];
  const nav = useNavigate();
  const [sp] = useSearchParams();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['facility', id], queryFn: () => api.get<any>(`/api/facilities/${id}`) });
  if (q.isLoading) return <Loading rows={6} />;
  if (q.error) return <ErrorAlert error={q.error} />;
  const d = q.data;
  const f = d.facility;
  const statusIdx = ORDER.indexOf(f.status);
  const stageIdx = JOURNEY.findIndex(([, ss]) => (ss as readonly string[]).includes(f.status));
  const openRework = d.rework.filter((r: any) => !r.resolvedAt);
  const tabs = [
    { key: 'overview', label: 'Overview', flag: f.status === 'RETURNED' },
    { key: 'documents', label: 'Documents', flag: d.documents.some((x: any) => x.status === 'REJECTED') },
    { key: 'messages', label: 'Messages' },
    ...(statusIdx >= ORDER.indexOf('APPROVED') && f.status !== 'DECLINED' ? [{ key: 'offer', label: 'Offer letter', flag: f.status === 'OFFER_ISSUED' }] : []),
    ...(statusIdx >= ORDER.indexOf('OFFER_ACCEPTED') ? [{ key: 'conditions', label: 'Conditions' }] : []),
    ...(f.status === 'ACTIVE' || f.status === 'CLOSED' ? [{ key: 'account', label: 'Facility account' }] : []),
  ];
  const go = (k: string) => nav(k === 'overview' ? `/portal/facilities/${id}` : `/portal/facilities/${id}/${k}`);
  return (
    <div className="stack" style={{ ['--gap' as any]: '20px' }}>
      <PageHeader crumbs={<><Link to="/portal">Overview</Link> / {f.ref}</>} eyebrow={f.ref} title={`${f.productName} — ${f.amountText ?? ''}`} sub={`${f.tenorMonths ?? '—'} months · submitted ${dateTime(f.submittedAt)}`}
        actions={<><Status value={f.status} label={f.statusLabel} />{['DRAFT', 'RETURNED'].includes(f.status) && <Link className="btn primary" to={`/portal/facilities/${id}/apply`}>{f.status === 'RETURNED' ? 'Review and resubmit' : 'Continue application'}</Link>}</>} />

      <div className="summary-strip" aria-label="Where your request is">
        <div><div className="label">Currently with</div><div className="value">{d.progress.currentlyWith}</div></div>
        <div style={{ gridColumn: 'span 3' }}><div className="label">What happens next</div><div className="value" style={{ fontWeight: 400 }}>{d.progress.nextStep}</div></div>
      </div>
      {f.status !== 'DECLINED' && f.status !== 'WITHDRAWN' && (
        <ol className="stepper" aria-label="Progress">
          {JOURNEY.map(([label], i) => <li key={label} className={i < stageIdx ? 'done' : i === stageIdx ? 'current' : ''} aria-current={i === stageIdx ? 'step' : undefined}>{label}</li>)}
        </ol>
      )}

      <Tabs tabs={tabs} value={tab} onChange={go} />

      {tab === 'overview' && (
        <div className="grid" style={{ gridTemplateColumns: 'minmax(0,3fr) minmax(0,2fr)' }}>
          <div className="stack">
            {openRework.length > 0 && <Alert tone="warn" title="The Bank has returned your request">
              <ul>{openRework.map((r: any) => <li key={r.id}><strong>{humanize(r.section)}:</strong> {r.message}</li>)}</ul>
              <Link className="btn sm primary" to={`/portal/facilities/${id}/apply`} style={{ marginTop: 8 }}>Address these items</Link>
            </Alert>}
            {f.status === 'OFFER_ISSUED' && <Alert tone="info" title="Your offer letter is ready"><Button size="sm" variant="primary" onClick={() => go('offer')}>Review offer</Button></Alert>}
            {f.status === 'DECLINED' && <Alert tone="danger" title="Your request was not approved">Your relationship manager will contact you to discuss the outcome and possible alternatives.</Alert>}
            <Panel title="Request details">
              <KV items={[['Facility', d.product.name], ['Amount', f.amountText], ['Tenor', f.tenorMonths ? `${f.tenorMonths} months` : '—'], ['Payment', humanize(f.paymentFrequency)], ['Purpose', f.purpose], ['Source of payment', f.sourceOfPayment], ['Proposed security', f.proposedSecurity]]} />
            </Panel>
          </div>
          <Panel title="Timeline">
            <ul className="timeline">{[...d.timeline].reverse().map((t: any, i: number) => <li key={i}><span className="when">{dateTime(t.at)}</span><span><strong>{t.status}</strong>{t.note && <div className="small muted">{t.note}</div>}</span></li>)}</ul>
          </Panel>
        </div>
      )}
      {tab === 'documents' && <Panel title="Documents" flush><DocumentList docs={d.documents} onChange={() => qc.invalidateQueries({ queryKey: ['facility', id] })} readOnly={!['DRAFT', 'RETURNED', 'SUBMITTED', 'IN_REVIEW', 'OFFER_ACCEPTED', 'FULFILMENT'].includes(f.status)} /></Panel>}
      {tab === 'messages' && <Panel title="Messages with the Bank"><Threads facilityId={id} initial={sp.get('thread')} /></Panel>}
      {tab === 'offer' && <OfferTab facilityId={id} />}
      {tab === 'conditions' && <Panel title="Conditions"><ConditionsTab facilityId={id} /></Panel>}
      {tab === 'account' && <AccountTab facilityId={id} />}
    </div>
  );
}
