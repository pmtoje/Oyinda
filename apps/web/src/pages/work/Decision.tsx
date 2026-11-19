import { Link, useParams, useSearchParams } from 'react-router-dom';
import { openDocument } from '../../lib/api';
import { dateTime, humanize, pct } from '../../lib/format';
import { Alert, Button, Empty, ErrorAlert, Loading, MockTag, Panel, Status } from '../../components/ui';
import { ActionRail, useCurrentTask } from './parts/ActionRail';
import { useFac } from './parts/common';

function Indicator({ label, value, sub, bad }: { label: string; value: React.ReactNode; sub?: React.ReactNode; bad?: boolean }) {
  return <div className={bad ? 'metric alert' : 'metric'}><div className="label">{label}</div><div className="value">{value}</div>{sub && <div className="sub">{sub}</div>}</div>;
}

export default function Decision() {
  const { id = '' } = useParams();
  const [sp] = useSearchParams();
  const q = useFac<any>(id, 'decision', `/api/facilities/${id}/decision-view`);
  const current = useCurrentTask(id, sp.get('task'));
  if (q.isLoading) return <Loading rows={6} />;
  if (q.error) return <ErrorAlert error={q.error} title="The decision view could not be opened" />;
  const { facility: f, summary: s, indicators: ind, flags, recommendations, memoVersion, memoDocumentId } = q.data;
  const top = flags.slice(0, 5);
  return (
    <>
      <div className="crumbs"><Link to={`/work/facilities/${id}`}>← Back to the full workspace</Link></div>
      <header className="panel" style={{ padding: '20px 22px', marginBottom: 18, borderLeft: '4px solid var(--brand-700)' }}>
        <div className="row between" style={{ alignItems: 'flex-start' }}>
          <div>
            <div className="xs muted" style={{ textTransform: 'uppercase', letterSpacing: '0.08em' }}>Decision required · {f.ref}</div>
            <h1 style={{ marginTop: 4 }}>{f.customer}</h1>
            <p style={{ fontSize: 'var(--fs-lg)', margin: '6px 0 0' }}><strong>{f.amount}</strong> {f.product} over <strong>{f.tenor} months</strong></p>
            <p className="muted" style={{ margin: '4px 0 0', maxWidth: '70ch' }}>{f.purpose}</p>
            <div className="small muted" style={{ marginTop: 6 }}>{f.sector ?? 'Sector not stated'} · RM {f.rm ?? '—'}</div>
          </div>
          <div className="stack" style={{ ['--gap' as any]: '8px', alignItems: 'flex-end' }}>
            <Status value={f.status} />
            {memoDocumentId && <Button size="sm" onClick={() => openDocument(memoDocumentId, 'attachment')}>Credit memo v{memoVersion} (.docx)</Button>}
          </div>
        </div>
      </header>
      <div className="workspace">
        <div className="stack" style={{ minWidth: 0 }}>
          <div className="grid cols-3">
            <Indicator label="Risk grade" value={ind.riskGrade ?? '—'} sub={s?.riskGrade} />
            <Indicator label="Security cover" value={pct(ind.collateralCoveragePct)} sub={ind.cashBacked ? 'Cash-backed' : s?.security} bad={ind.collateralCoveragePct < 100} />
            <Indicator label={<>RARORAC <MockTag mode={ind.rarorac?.mode} /></> as any} value={ind.rarorac ? pct(ind.rarorac.pct, 2) : '—'} sub={ind.rarorac ? `Hurdle ${pct(ind.rarorac.hurdle, 2)} · rate ${pct(ind.rarorac.profitRate, 2)}` : 'Not computed'} bad={ind.rarorac && !ind.rarorac.within} />
            <Indicator label={<>Exposure vs SOL <MockTag mode={ind.exposure?.mode} /></> as any} value={ind.exposure ? ind.exposure.aggregate : '—'} sub={ind.exposure ? (ind.exposure.breached ? `Exceeds SOL of ${ind.exposure.sol}` : `Headroom ${ind.exposure.headroom}`) : 'Not computed'} bad={ind.exposure?.breached} />
            <Indicator label="E&S" value={ind.es ? `Category ${ind.es.category ?? '—'}` : 'Not required'} sub={ind.es?.recommendation ? humanize(ind.es.recommendation) : undefined} bad={ind.es?.category === 'A'} />
            <Indicator label="Credit turnover" value={ind.turnover?.avgMonthly ?? '—'} sub={ind.turnover ? `Trend ${pct(ind.turnover.trendPct)} · wallet share ${pct(ind.turnover.walletSharePct)}` : undefined} bad={ind.turnover?.trendPct !== null && ind.turnover?.trendPct <= -10} />
          </div>
          {ind.exposure?.breached && <Alert tone="danger" title="Single Obligor Limit exceeded">Aggregate exposure including this request exceeds the configured limit. Consider a reduced amount.</Alert>}
          <Panel title="Executive summary">
            {!s ? <Empty title="No credit memo generated yet">The analyst's summary appears here once the memo is generated.</Empty> : (
              <div className="grid cols-2">
                <div className="stack" style={{ ['--gap' as any]: '6px' }}>
                  <div className="small">Analyst recommendation</div>
                  <div><Status value={s.recommendation === 'DECLINE' ? 'DECLINED' : 'APPROVED'} label={humanize(s.recommendation)} /></div>
                  {s.conditions?.length > 0 && <><div className="small" style={{ marginTop: 8 }}>Proposed conditions</div><ul className="small" style={{ margin: 0, paddingLeft: 18 }}>{s.conditions.map((c: string, i: number) => <li key={i}>{c}</li>)}</ul></>}
                </div>
                <table className="data"><tbody>{s.keyMetrics.map((m: any) => <tr key={m.label}><td className="small">{m.label}</td><td className="num">{m.value}</td></tr>)}</tbody></table>
              </div>)}
          </Panel>
          <Panel title="Key risks" actions={<span className="xs muted">Each with the evidence behind it</span>}>
            {!top.length ? <p className="muted small">No risk flags were raised by the configured checks.</p> : (
              <ul className="flag-list">{top.map((fl: any, i: number) => <li key={i}><span className={`sev ${fl.severity}`}>{fl.severity}</span> {fl.statement}{fl.mitigantHint && <span className="small muted"> — {fl.mitigantHint}</span>}<div className="evidence">{fl.evidence.slice(0, 3).map((e: any, j: number) => <span key={j}>{e.label}: <strong>{e.value}</strong>{j < Math.min(fl.evidence.length, 3) - 1 ? ' · ' : ''}</span>)}</div></li>)}</ul>)}
            {flags.length > top.length && <p className="xs muted">{flags.length - top.length} further flag(s) in the workspace.</p>}
          </Panel>
          <Panel title="Recommendation chain">
            {!recommendations.length ? <p className="muted small">No recommendations recorded yet.</p> : (
              <ul className="timeline">{recommendations.map((r: any, i: number) => <li key={i}><span className="when">{dateTime(r.at)}</span><div><strong>{r.officer}</strong> <span className="muted small">{r.role} · {r.stage}</span> — <Status value={r.action === 'DECLINE' ? 'DECLINED' : r.action === 'RETURN' ? 'RETURNED' : 'APPROVED'} label={humanize(r.action)} />{r.comment && <div className="small" style={{ marginTop: 2 }}>“{r.comment}”</div>}</div></li>)}</ul>)}
          </Panel>
        </div>
        <aside className="action-rail" aria-label="Decision">
          <ActionRail facilityId={id} task={current.task} loading={current.loading} openCount={current.openCount} />
        </aside>
      </div>
    </>
  );
}
