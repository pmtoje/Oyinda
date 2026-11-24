import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../../lib/api';
import { money, pct } from '../../lib/format';
import { FACILITY_STATUS_LABEL } from '@gazelle/shared';
import { ErrorAlert, Loading, PageHeader, Panel } from '../../components/ui';
import { Bars, ReportFilters, useReportFilters } from '../admin/parts/filters';

const PIPELINE_ORDER = ['SUBMITTED', 'IN_REVIEW', 'RETURNED', 'APPROVED', 'OFFER_ISSUED', 'IN_NEGOTIATION', 'OFFER_ACCEPTED', 'FULFILMENT', 'READY_FOR_ACTIVATION', 'ACTIVE', 'CLOSED', 'OFFER_REJECTED', 'DECLINED', 'WITHDRAWN'];
const TEAM: Record<string, string> = { LEGAL: 'Legal', SHARIAH: 'Shariah', CREDIT_OPS: 'Credit Operations', CUSTOMER: 'Customer', RM: 'Relationship Manager' };
const hours = (h?: number | null) => (h === null || h === undefined ? '—' : h >= 48 ? `${(h / 24).toFixed(1)} days` : `${Number(h).toFixed(1)} h`);

export default function Reports() {
  const filters = useReportFilters();
  const q = useQuery({ queryKey: ['reports', 'slm', filters], queryFn: () => api.get<any>(`/api/reports/slm?${filters}`) });
  const d = q.data;
  const t = d?.totals;
  const Metric = ({ label, value, sub, alert }: { label: string; value: string | number; sub?: string; alert?: boolean }) => (
    <div className={`metric ${alert ? 'metric-alert' : ''}`}><div className="label">{label}</div><div className="value">{value}</div>{sub && <div className="sub">{sub}</div>}</div>
  );
  const byAmount = (key: string) => ({ label: (r: any) => r[key] ?? '—', value: (r: any) => r.count, format: (v: number, r: any) => `${v} · ${money(r.amount_minor, 'NGN', { compact: true })}` });
  return (
    <>
      <PageHeader eyebrow="Insight" title="Service level management" sub="Volumes, values, turnaround and SLA compliance across the credit process. Figures cover submitted requests (drafts excluded)."
        actions={<Link className="btn" to={`/work/reports/exports?${filters}`}>Export reports</Link>} />
      <ReportFilters />
      <div style={{ height: 16 }} />
      {q.isLoading ? <Loading rows={8} /> : q.error ? <ErrorAlert error={q.error} /> : (
        <div className="stack">
          <div className="grid cols-4">
            <Metric label="Applications received" value={t.received} sub={`${t.pending} pending · ${t.returned} returned`} />
            <Metric label="Approved" value={t.approved} sub={t.received ? `${pct((t.approved / t.received) * 100, 0)} of received` : undefined} />
            <Metric label="Declined" value={t.declined} />
            <Metric label="SLA compliance" value={pct(d.sla.compliance_pct)} sub={`${d.sla.breaches} breach(es) across ${d.sla.tasks} tasks`} alert={d.sla.breaches > 0 && (d.sla.compliance_pct ?? 100) < 90} />
            <Metric label="Requested value" value={money(t.requested_minor, 'NGN', { compact: true })} />
            <Metric label="Approved value" value={money(t.approved_minor, 'NGN', { compact: true })} />
            <Metric label="Disbursed value" value={money(t.disbursed_minor, 'NGN', { compact: true })} />
            <Metric label="Turnaround (submission → decision)" value={hours(t.avg_tat_hours)} sub={`Median ${hours(t.median_tat_hours)}`} />
          </div>
          <div className="grid cols-2">
            <Panel title="Open work by stage"><Bars rows={d.byStage} label={(r) => r.stage} value={(r) => r.count} format={(v, r) => (r.breached ? `${v} · ${r.breached} late` : String(v))} tone={(r) => (r.breached ? 'danger' : '')} /></Panel>
            <Panel title="Credit analysis throughput"><Bars rows={d.byAnalyst} label={(r) => r.analyst} value={(r) => r.count} format={(v, r) => `${v} · avg ${hours(r.avg_hours)}`} /></Panel>
            <Panel title="By sector"><Bars rows={d.bySector} {...byAmount('sector')} /></Panel>
            <Panel title="By product"><Bars rows={d.byProduct} {...byAmount('product')} /></Panel>
            <Panel title="By directorate"><Bars rows={d.byDirectorate} {...byAmount('directorate')} /></Panel>
            <Panel title="By Relationship Manager"><Bars rows={d.byRm} {...byAmount('rm')} /></Panel>
            <Panel title="By facility size"><Bars rows={d.bySize} label={(r) => r.band} value={(r) => r.count} format={(v, r) => `${v} · ${r.approved} approved`} tone={() => 'accent'} /></Panel>
          </div>

          <h2 className="section-title">Pipeline, conversion and risk</h2>
          <div className="grid cols-2">
            <Panel title="Pipeline by status (count · value)">
              <Bars rows={[...d.pipeline].filter((r: any) => r.status !== 'DRAFT').sort((a: any, b: any) => PIPELINE_ORDER.indexOf(a.status) - PIPELINE_ORDER.indexOf(b.status))} label={(r) => (FACILITY_STATUS_LABEL as Record<string, string>)[r.status] ?? r.status} value={(r) => r.count} format={(v, r) => `${v} · ${money(r.amount_minor, 'NGN', { compact: true })}`} tone={(r) => (r.status === 'DECLINED' || r.status === 'OFFER_REJECTED' ? 'danger' : '')} />
            </Panel>
            <Panel title="Approval to disbursement">
              <Bars rows={[
                { stage: 'Approved', n: d.conversion.approved },
                { stage: 'Offer accepted', n: d.conversion.accepted },
                { stage: 'Activated', n: d.conversion.activated },
                { stage: 'Disbursed', n: d.conversion.disbursed },
              ]} label={(r) => r.stage} value={(r) => r.n} format={(v) => (d.conversion.approved ? `${v} · ${pct((v / d.conversion.approved) * 100, 0)}` : String(v))} tone={() => 'accent'} />
            </Panel>
            <Panel title="Risk distribution (combined grade)"><Bars rows={d.byRiskGrade} {...byAmount('grade')} /></Panel>
            <Panel title="By business unit (region)"><Bars rows={d.byBusinessUnit} {...byAmount('unit')} /></Panel>
          </div>

          <div className="grid cols-2">
            <Panel title="Bottlenecks — where open work waits longest" flush>
              {!d.bottlenecks.length ? <p className="muted small" style={{ padding: 16, margin: 0 }}>No open work in this selection.</p> : (
                <div className="table-wrap"><table className="data"><thead><tr><th>Stage</th><th className="num">Open</th><th className="num">Late</th><th className="num">Waiting (avg)</th><th className="num">Usually takes</th></tr></thead>
                  <tbody>{d.bottlenecks.map((b: any) => <tr key={b.stage}><td>{b.stage}</td><td className="num">{b.open}</td><td className="num" style={{ color: b.open_breached ? 'var(--danger-text)' : undefined }}>{b.open_breached}</td><td className="num">{hours(b.avg_open_hours)}</td><td className="num">{hours(b.avg_done_hours)}</td></tr>)}</tbody></table></div>)}
            </Panel>
            <Panel title="Outstanding conditions" flush>
              {!d.conditions.length ? <p className="muted small" style={{ padding: 16, margin: 0 }}>No outstanding conditions in this selection.</p> : (
                <div className="table-wrap"><table className="data"><thead><tr><th>Team</th><th className="num">Outstanding</th><th className="num">Blocking release</th><th className="num">Overdue</th></tr></thead>
                  <tbody>{d.conditions.map((c: any) => <tr key={c.team}><td>{TEAM[c.team] ?? c.team}</td><td className="num">{c.outstanding}</td><td className="num">{c.blocking}</td><td className="num" style={{ color: c.overdue ? 'var(--danger-text)' : undefined }}>{c.overdue}</td></tr>)}</tbody></table></div>)}
            </Panel>
          </div>
        </div>
      )}
    </>
  );
}
