import { Link, useParams, useSearchParams } from 'react-router-dom';
import { humanize, money } from '../../lib/format';
import { Alert, ErrorAlert, Loading, PageHeader, Status, Tabs } from '../../components/ui';
import { ActionRail, useCurrentTask } from './parts/ActionRail';
import { SlaBadge, useFac } from './parts/common';
import { CustomerTab, DocumentsTab, OverviewTab } from './parts/overview';
import { FinancialsTab, StatementsTab } from './parts/financials';
import { CollateralTab, CreditTab, EsTab, PricingTab, RiskTab } from './parts/credit';
import { AiTab, MemoTab } from './parts/memo';
import { MessagesTab, WorkflowTab } from './parts/workflow';
import { AccountTab, ConditionsTab, OfferTab } from './parts/fulfilment';

const POST_APPROVAL = ['APPROVED', 'OFFER_ISSUED', 'IN_NEGOTIATION', 'OFFER_ACCEPTED', 'OFFER_REJECTED', 'FULFILMENT', 'READY_FOR_ACTIVATION', 'ACTIVE', 'CLOSED'];

export default function FacilityWorkspace() {
  const { id = '' } = useParams();
  const [sp, setSp] = useSearchParams();
  const detail = useFac<any>(id, 'detail', `/api/facilities/${id}`);
  const risk = useFac<any>(id, 'risk', `/api/facilities/${id}/risk`, !!detail.data && detail.data.facility.status !== 'DRAFT');
  const current = useCurrentTask(id, sp.get('task'));
  if (detail.isLoading) return <Loading rows={6} />;
  if (detail.error) return <ErrorAlert error={detail.error} title="This facility could not be opened" />;
  const d = detail.data;
  const f = d.facility;
  const post = POST_APPROVAL.includes(f.status);
  const grade = risk.data?.assessments?.find((a: any) => a.kind === 'COMBINED' && a.status === 'SUBMITTED')?.grade;
  const docsPending = d.documents.some((x: any) => x.mandatory && ['UPLOADED', 'UNDER_REVIEW'].includes(x.status));
  const tabs = [
    { key: 'overview', label: 'Overview' }, { key: 'customer', label: 'Customer' }, { key: 'documents', label: 'Documents', flag: docsPending },
    { key: 'financials', label: 'Financials' }, { key: 'statements', label: 'Bank statements' }, { key: 'credit', label: 'Credit checks & exposure' },
    { key: 'collateral', label: 'Collateral' }, { key: 'risk', label: 'Risk rating' }, { key: 'pricing', label: 'Pricing' }, { key: 'es', label: 'E&S' },
    { key: 'memo', label: 'Memo & term sheet' }, { key: 'ai', label: 'AI assist' },
    ...(post ? [{ key: 'offer', label: 'Offer' }, { key: 'conditions', label: 'Conditions' }, { key: 'account', label: 'Account' }] : []),
    { key: 'workflow', label: 'Workflow & timeline' }, { key: 'messages', label: 'Messages' },
  ];
  const tab = tabs.some((t) => t.key === sp.get('tab')) ? sp.get('tab')! : 'overview';
  const setTab = (k: string) => { const n = new URLSearchParams(sp); n.set('tab', k); setSp(n, { replace: true }); };
  const t = current.task;
  return (
    <>
      <PageHeader crumbs={<><Link to="/work/facilities">Facilities</Link> / {f.ref}</>} eyebrow={d.product.name} title={f.customerName}
        sub={`${f.ref} · ${f.origin === 'RM' ? 'RM-initiated' : 'Customer-initiated'}`}
        actions={<Link className="btn" to={`/work/facilities/${id}/decision${t ? `?task=${t.id}` : ''}`}>Executive decision view</Link>} />
      <div className="summary-strip" role="group" aria-label="Facility summary">
        <div><div className="label">Amount</div><div className="value">{money(f.amountMinor, f.currency)}</div></div>
        <div><div className="label">Tenor</div><div className="value">{f.tenorMonths ? `${f.tenorMonths} months` : '—'}</div></div>
        <div><div className="label">Payment</div><div className="value">{humanize(f.paymentFrequency)}</div></div>
        <div><div className="label">Status</div><div className="value"><Status value={f.status} label={f.statusLabel} /></div></div>
        <div><div className="label">Risk grade</div><div className="value">{grade ?? '—'}</div></div>
        <div><div className="label">Current stage</div><div className="value">{t ? <>{t.stageName} <SlaBadge sla={t.sla} /></> : '—'}</div></div>
      </div>
      {f.isDemo && <Alert tone="warn">DEMO / NON-PRODUCTION record.</Alert>}
      <div className="workspace" style={{ marginTop: f.isDemo ? 12 : 0 }}>
        <div style={{ minWidth: 0 }}>
          <Tabs tabs={tabs} value={tab} onChange={setTab} />
          <div role="tabpanel" aria-label={tabs.find((x) => x.key === tab)?.label}>
            {tab === 'overview' && <OverviewTab id={id} detail={d} />}
            {tab === 'customer' && <CustomerTab id={id} customerId={f.customerId} />}
            {tab === 'documents' && <DocumentsTab id={id} />}
            {tab === 'financials' && <FinancialsTab id={id} customerId={f.customerId} />}
            {tab === 'statements' && <StatementsTab id={id} />}
            {tab === 'credit' && <CreditTab id={id} customerId={f.customerId} />}
            {tab === 'collateral' && <CollateralTab id={id} currency={f.currency} />}
            {tab === 'risk' && <RiskTab id={id} />}
            {tab === 'pricing' && <PricingTab id={id} product={d.product} />}
            {tab === 'es' && <EsTab id={id} />}
            {tab === 'memo' && <MemoTab id={id} />}
            {tab === 'ai' && <AiTab id={id} />}
            {tab === 'offer' && <OfferTab id={id} status={f.status} />}
            {tab === 'conditions' && <ConditionsTab id={id} />}
            {tab === 'account' && <AccountTab id={id} status={f.status} />}
            {tab === 'workflow' && <WorkflowTab id={id} />}
            {tab === 'messages' && <MessagesTab id={id} initialThread={sp.get('thread')} />}
          </div>
        </div>
        <aside className="action-rail" aria-label="Your task">
          <ActionRail facilityId={id} task={t} loading={current.loading} openCount={current.openCount} />
        </aside>
      </div>
    </>
  );
}
