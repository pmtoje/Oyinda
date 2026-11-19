import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { date, dateTime } from '../../lib/format';
import { Button, Empty, ErrorAlert, Loading, PageHeader, Panel, Status } from '../../components/ui';

export interface ConfigRow { id: string; kind: string; key: string; version: number; status: string; title: string; payload: any; effectiveFrom: string | null; effectiveTo: string | null; changeReason: string; createdBy: string | null; createdById: string | null; approvedBy: string | null; approvedAt: string | null; createdAt: string; rejectedReason: string | null }

export default function ConfigList() {
  const { can } = useAuth();
  const nav = useNavigate();
  const [sp, setSp] = useSearchParams();
  const kind = sp.get('kind') ?? '';
  const kinds = useQuery({ queryKey: ['admin', 'config-kinds'], queryFn: () => api.get<{ kind: string; label: string; active: number; pending: number; drafts: number }[]>('/api/admin/config/kinds') });
  const pending = useQuery({ queryKey: ['admin', 'config', 'pending'], queryFn: () => api.get<ConfigRow[]>('/api/admin/config?status=PENDING_APPROVAL,DRAFT') });
  const rows = useQuery({ queryKey: ['admin', 'config', kind], queryFn: () => api.get<ConfigRow[]>(`/api/admin/config?kind=${kind}`), enabled: !!kind });
  const label = kinds.data?.find((k) => k.kind === kind)?.label;

  return (
    <>
      <PageHeader eyebrow="Control centre" title="Configuration" sub="Every business rule is versioned with an effective date. Changes need a second administrator to approve before they take effect; past decisions keep the version they used." />
      {kinds.error && <ErrorAlert error={kinds.error} />}

      <Panel title="Awaiting action" actions={<span className="small muted">Drafts and changes pending approval</span>} flush>
        {pending.isLoading ? <Loading /> : !pending.data?.length ? <Empty title="Nothing awaiting approval">New drafts and submitted changes appear here.</Empty> : (
          <div className="table-wrap"><table className="data"><thead><tr><th>Item</th><th>Type</th><th className="num">Version</th><th>Status</th><th>Maker</th><th>Reason</th><th>Created</th></tr></thead>
            <tbody>{pending.data.map((r) => (
              <tr key={r.id} className="clickable" onClick={() => nav(`/admin/config/${r.id}`)}>
                <td className="primary-cell"><Link to={`/admin/config/${r.id}`} onClick={(e) => e.stopPropagation()}>{r.title}</Link><div className="xs muted mono">{r.key}</div></td>
                <td className="small">{kinds.data?.find((k) => k.kind === r.kind)?.label ?? r.kind}</td>
                <td className="num">v{r.version}</td><td><Status value={r.status} /></td><td className="small">{r.createdBy ?? 'System'}</td>
                <td className="small" style={{ maxWidth: 280 }}>{r.changeReason}</td><td className="small nowrap">{dateTime(r.createdAt)}</td>
              </tr>))}</tbody></table></div>
        )}
      </Panel>

      <div className="grid" style={{ gridTemplateColumns: 'minmax(220px, 280px) minmax(0, 1fr)', marginTop: 20, alignItems: 'start' }}>
        <Panel title="Configuration types" flush>
          {kinds.isLoading ? <Loading rows={6} /> : (
            <nav aria-label="Configuration types" className="stack" style={{ ['--gap' as any]: '0' }}>
              {kinds.data?.map((k) => (
                <button key={k.kind} type="button" className="choice" aria-pressed={k.kind === kind} style={{ borderRadius: 0, border: 0, borderBottom: '1px solid var(--line)' }} onClick={() => setSp({ kind: k.kind })}>
                  <div className="row between"><span className="title small">{k.label}</span><span className="xs muted">{k.active}</span></div>
                  {(k.pending > 0 || k.drafts > 0) && <div className="xs" style={{ color: 'var(--warn-700)' }}>{k.pending ? `${k.pending} pending` : ''}{k.pending && k.drafts ? ' · ' : ''}{k.drafts ? `${k.drafts} draft` : ''}</div>}
                </button>
              ))}
            </nav>
          )}
        </Panel>
        <Panel title={label ?? 'Select a configuration type'} actions={kind && can('config.edit') ? <Button size="sm" variant="primary" onClick={() => nav(`/admin/config/new?kind=${kind}`)}>New item</Button> : undefined} flush>
          {!kind ? <Empty title="Choose a type">Select a configuration type to see its items and full version history.</Empty>
            : rows.isLoading ? <Loading rows={6} /> : rows.error ? <ErrorAlert error={rows.error} /> : !rows.data?.length ? <Empty title="No items yet" /> : (
              <div className="table-wrap"><table className="data">
                <thead><tr><th>Item</th><th className="num">Version</th><th>Status</th><th>Effective</th><th>Maker</th><th>Checker</th><th>Change reason</th><th /></tr></thead>
                <tbody>{rows.data.map((r) => (
                  <tr key={r.id} className="clickable" onClick={() => nav(`/admin/config/${r.id}`)}>
                    <td className="primary-cell"><Link to={`/admin/config/${r.id}`} onClick={(e) => e.stopPropagation()}>{r.title}</Link><div className="xs muted mono">{r.key}</div></td>
                    <td className="num">v{r.version}</td>
                    <td><Status value={r.status} /></td>
                    <td className="small nowrap">{r.effectiveFrom ? date(r.effectiveFrom) : '—'}{r.effectiveTo ? ` → ${date(r.effectiveTo)}` : r.status === 'ACTIVE' ? ' → open' : ''}</td>
                    <td className="small">{r.createdBy ?? 'System baseline'}</td>
                    <td className="small">{r.approvedBy ?? (r.status === 'ACTIVE' || r.status === 'RETIRED' ? 'System baseline' : '—')}</td>
                    <td className="small" style={{ maxWidth: 260 }}>{r.changeReason}</td>
                    <td className="num">{can('config.edit') && r.status === 'ACTIVE' && <Button size="sm" onClick={(e) => { e.stopPropagation(); nav(`/admin/config/new?kind=${r.kind}&key=${encodeURIComponent(r.key)}`); }}>New version</Button>}</td>
                  </tr>))}</tbody>
              </table></div>
            )}
        </Panel>
      </div>
    </>
  );
}
