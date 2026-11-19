import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { api } from '../../lib/api';
import { humanize, pct } from '../../lib/format';
import { Alert, Empty, ErrorAlert, Loading, PageHeader, Panel, SelectInput, TextInput } from '../../components/ui';
import { Bars } from '../admin/parts/filters';
import { qs } from '../admin/parts/common';

const STEP_LABEL: Record<string, string> = { PRODUCT: 'Product selection', DETAILS: 'Facility details', PRODUCT_INFO: 'Product information', SECURITY: 'Security', FINANCIALS: 'Financial statements', BANK_STATEMENTS: 'Bank statements', DOCUMENTS: 'Documents', REVIEW: 'Review & submit', ACCOUNT: 'Account verification', OTP: 'One-time code', PROFILE: 'Business & contact details', COMPLETE: 'Completion' };

export default function DropOff() {
  const [sp, setSp] = useSearchParams();
  const journey = sp.get('journey') ?? 'FACILITY_APPLICATION';
  const from = sp.get('from') ?? ''; const to = sp.get('to') ?? '';
  const set = (k: string, v: string) => { const n = new URLSearchParams(sp); if (v) n.set(k, v); else n.delete(k); setSp(n); };
  const q = useQuery({ queryKey: ['reports', 'dropoff', journey, from, to], queryFn: () => api.get<any>(`/api/reports/dropoff?${qs({ journey, from, to })}`) });
  const d = q.data;
  const label = (s: string) => STEP_LABEL[s] ?? humanize(s);
  return (
    <>
      <PageHeader eyebrow="Insight" title="Drop-off analytics" sub="Where customers stop before finishing. Only step names are tracked, never the content customers enter." />
      <Panel title="Journey">
        <div className="grid cols-3">
          <SelectInput label="Journey" value={journey} options={[{ value: 'FACILITY_APPLICATION', label: 'Facility application' }, { value: 'ONBOARDING', label: 'Customer onboarding' }]} onChange={(e) => set('journey', e.target.value)} />
          <TextInput label="From" type="date" value={from} onChange={(e) => set('from', e.target.value)} />
          <TextInput label="To" type="date" value={to} onChange={(e) => set('to', e.target.value)} />
        </div>
      </Panel>
      <div style={{ height: 16 }} />
      {q.isLoading ? <Loading rows={6} /> : q.error ? <ErrorAlert error={q.error} /> : !d.steps.some((s: any) => s.entered) ? <Panel><Empty title="No journeys in this period">Activity appears once customers start the journey.</Empty></Panel> : (
        <div className="stack">
          {d.highestDropOff && <Alert tone="warn" title={`Highest drop-off: ${label(d.highestDropOff.step)}`}>{d.highestDropOff.dropped} of {d.highestDropOff.entered} customers who reached this step did not complete it ({pct(d.highestDropOff.dropOffPct)}).</Alert>}
          <div className="grid cols-2">
            <Panel title="Customers reaching each step"><Bars rows={d.steps} label={(r) => label(r.step)} value={(r) => r.entered} /></Panel>
            <Panel title="Drop-off by step"><Bars rows={d.steps} label={(r) => label(r.step)} value={(r) => r.dropped} format={(v, r) => `${v} · ${pct(r.dropOffPct)}`} tone={(r) => (d.highestDropOff?.step === r.step ? 'danger' : 'accent')} /></Panel>
          </div>
          <Panel title="Funnel" flush>
            <div className="table-wrap"><table className="data"><thead><tr><th>Step</th><th className="num">Reached</th><th className="num">Completed</th><th className="num">Dropped</th><th className="num">Drop-off</th></tr></thead>
              <tbody>{d.steps.map((s: any, i: number) => <tr key={s.step}><td className="primary-cell">{i + 1}. {label(s.step)}</td><td className="num">{s.entered}</td><td className="num">{s.completed}</td><td className="num">{s.dropped}</td><td className="num" style={{ color: d.highestDropOff?.step === s.step ? 'var(--danger-700)' : undefined }}>{pct(s.dropOffPct)}</td></tr>)}</tbody></table></div>
          </Panel>
        </div>
      )}
    </>
  );
}
