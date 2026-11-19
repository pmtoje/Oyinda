import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { dateTime } from '../../lib/format';
import { Alert, Button, Empty, ErrorAlert, KV, Loading, PageHeader, Panel, Status, useAction } from '../../components/ui';

export default function Health() {
  const qc = useQueryClient();
  const h = useQuery({ queryKey: ['admin', 'health'], queryFn: () => api.get<any>('/api/admin/health'), refetchInterval: 30_000 });
  const retry = useAction(async (id: string) => { await api.post(`/api/admin/jobs/${id}/retry`); await qc.invalidateQueries({ queryKey: ['admin', 'health'] }); });
  if (h.isLoading) return <Loading rows={8} />;
  if (h.error) return <ErrorAlert error={h.error} />;
  const d = h.data;
  const queues = [...new Set<string>(d.jobs.map((j: any) => j.queue))];
  const statuses = ['QUEUED', 'RUNNING', 'FAILED', 'DEAD', 'DONE'];
  const jobN = (q: string, s: string) => d.jobs.find((j: any) => j.queue === q && j.status === s)?.n ?? 0;
  const mocks = d.integrations.filter((i: any) => i.status === 'MOCK');
  return (
    <>
      <PageHeader eyebrow="Control centre" title="System health" sub={`Environment: ${d.environment.toUpperCase()} · checked ${dateTime(d.checkedAt)} · refreshes every 30 seconds`} actions={<Button size="sm" onClick={() => h.refetch()}>Refresh</Button>} />
      {mocks.length > 0 && <Alert tone="warn" title="Mock integrations in use">{mocks.map((m: any) => m.name).join(', ')} are using development mock providers. Production refuses to start in this state.</Alert>}
      {!d.audit.ok && <Alert tone="danger" title="Audit chain integrity failure">Broken at entry #{d.audit.brokenAt}. Escalate immediately.</Alert>}
      <div className="grid cols-4" style={{ margin: '16px 0' }}>
        <div className="metric"><div className="label">Database</div><div className="value">{d.database.ok ? 'Healthy' : 'Unavailable'}</div><div className="sub">{d.database.latencyMs} ms round trip</div></div>
        <div className={`metric ${d.sla.breached ? 'metric-alert' : ''}`}><div className="label">SLA</div><div className="value">{d.sla.breached} breached</div><div className="sub">{d.sla.warning} approaching · {d.sla.open} open tasks</div></div>
        <div className={`metric ${d.deadLetters.length ? 'metric-alert' : ''}`}><div className="label">Dead-letter jobs</div><div className="value">{d.deadLetters.length}</div><div className="sub">Exhausted all retries</div></div>
        <div className={`metric ${d.audit.ok ? '' : 'metric-alert'}`}><div className="label">Audit chain</div><div className="value">{d.audit.ok ? 'Intact' : 'Broken'}</div><div className="sub">{d.audit.checked.toLocaleString()} entries verified</div></div>
      </div>
      <div className="grid cols-2">
        <Panel title="Integrations" flush>
          <table className="data"><thead><tr><th>Integration</th><th>Mode</th><th>Status</th></tr></thead>
            <tbody>{d.integrations.map((i: any) => <tr key={i.name}><td className="primary-cell">{i.name}</td><td className="mono small">{i.mode}</td><td><Status value={i.status === 'LIVE' ? 'ACTIVE' : i.status === 'MOCK' ? 'WARNING' : 'PENDING'} label={i.status} /></td></tr>)}</tbody></table>
        </Panel>
        <Panel title="Operations">
          <KV items={[
            ['Notification deliveries pending', d.notifications.pending], ['Notification deliveries failed', d.notifications.failed],
            ['Last bank statement processed', dateTime(d.lastStatementProcessedAt)],
            ['AI interactions (7 days)', d.ai.n], ['AI outputs awaiting human review', d.ai.pending],
          ]} />
        </Panel>
        <Panel title="Background jobs" flush>
          {!queues.length ? <Empty title="No jobs recorded yet" /> : (
            <div className="table-wrap"><table className="data"><thead><tr><th>Queue</th>{statuses.map((s) => <th key={s} className="num">{s.toLowerCase()}</th>)}</tr></thead>
              <tbody>{queues.map((q) => <tr key={q}><td className="mono small">{q}</td>{statuses.map((s) => <td key={s} className="num" style={{ color: (s === 'DEAD' || s === 'FAILED') && jobN(q, s) ? 'var(--danger-700)' : undefined }}>{jobN(q, s)}</td>)}</tr>)}</tbody></table></div>
          )}
        </Panel>
        <Panel title="Dead letters" flush>
          <ErrorAlert error={retry.error} />
          {!d.deadLetters.length ? <Empty title="No dead-letter jobs" /> : (
            <div className="table-wrap"><table className="data"><thead><tr><th>Queue</th><th className="num">Attempts</th><th>Last error</th><th>Created</th><th /></tr></thead>
              <tbody>{d.deadLetters.map((j: any) => <tr key={j.id}><td className="mono small">{j.queue}</td><td className="num">{j.attempts}</td><td className="small" style={{ maxWidth: 260 }}>{j.lastError}</td><td className="small nowrap">{dateTime(j.createdAt)}</td><td className="num"><Button size="sm" loading={retry.loading} onClick={() => retry.run(j.id)}>Retry</Button></td></tr>)}</tbody></table></div>
          )}
        </Panel>
        <Panel title="Database migrations" flush>
          <table className="data"><thead><tr><th>Migration</th><th>Applied</th></tr></thead><tbody>{d.database.migrations.map((m: any) => <tr key={m.name}><td className="mono small">{m.name}</td><td className="small">{dateTime(m.appliedAt)}</td></tr>)}</tbody></table>
        </Panel>
        <Panel title="API latency (this instance, since start)" flush>
          {!d.http.routes.length ? <Empty title="No requests measured yet" /> : (
            <div className="table-wrap" style={{ maxHeight: 360, overflowY: 'auto' }}><table className="data"><thead><tr><th>Route</th><th className="num">Requests</th><th className="num">Average</th><th className="num">p95 ≤</th></tr></thead>
              <tbody>{[...d.http.routes].sort((a: any, b: any) => b.avgMs - a.avgMs).slice(0, 40).map((r: any) => {
                const m = /route="([^"]*)",method="([^"]*)"/.exec(r.key);
                return <tr key={r.key}><td className="mono xs">{m ? `${m[2]} ${m[1]}` : r.key}</td><td className="num">{r.count}</td><td className="num" style={{ color: r.avgMs > 1000 ? 'var(--danger-700)' : undefined }}>{r.avgMs} ms</td><td className="num">{r.p95Bucket ? `${r.p95Bucket} ms` : '> 5 s'}</td></tr>;
              })}</tbody></table></div>
          )}
        </Panel>
      </div>
    </>
  );
}
