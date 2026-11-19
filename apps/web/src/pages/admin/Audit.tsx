import { Fragment, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { dateTime, humanize } from '../../lib/format';
import { Alert, Button, Empty, ErrorAlert, Loading, PageHeader, Panel, Status, TextInput, useAction } from '../../components/ui';
import { qs } from './parts/common';

const isUuid = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

export default function Audit() {
  const [draft, setDraft] = useState({ facilityId: '', action: '', entityType: '', from: '', to: '' });
  const [filters, setFilters] = useState(draft);
  const [open, setOpen] = useState<number | null>(null);
  const q = useQuery({ queryKey: ['admin', 'audit', filters], queryFn: () => api.get<any[]>(`/api/admin/audit?${qs({ ...filters, limit: '200' })}`) });
  const verify = useAction(() => api.get<{ ok: boolean; checked: number; brokenAt?: number }>('/api/admin/audit/verify'));
  const [result, setResult] = useState<{ ok: boolean; checked: number; brokenAt?: number } | null>(null);
  const badFacility = draft.facilityId !== '' && !isUuid(draft.facilityId);
  return (
    <>
      <PageHeader eyebrow="Control centre" title="Audit log" sub="Append-only and hash-chained: each entry includes the hash of the previous one, so any alteration breaks the chain. Viewing the log is itself audited."
        actions={<Button loading={verify.loading} onClick={async () => setResult((await verify.run()) ?? null)}>Verify chain integrity</Button>} />
      {result && (result.ok ? <Alert tone="ok" title="Chain verified">{result.checked.toLocaleString()} entries recomputed; every hash and link is intact.</Alert> : <Alert tone="danger" title="Chain broken">Integrity failure at entry #{result.brokenAt}. Escalate to Information Security immediately.</Alert>)}
      <ErrorAlert error={verify.error} />
      <Panel title="Filters">
        <form className="grid cols-4" onSubmit={(e) => { e.preventDefault(); if (!badFacility) setFilters(draft); }}>
          <TextInput label="Facility ID" placeholder="UUID" value={draft.facilityId} error={badFacility ? 'Enter a full facility ID.' : undefined} onChange={(e) => setDraft({ ...draft, facilityId: e.target.value.trim() })} />
          <TextInput label="Action" placeholder="e.g. WORKFLOW_APPROVE" value={draft.action} onChange={(e) => setDraft({ ...draft, action: e.target.value.trim().toUpperCase() })} />
          <TextInput label="Entity type" placeholder="e.g. facility_request" value={draft.entityType} onChange={(e) => setDraft({ ...draft, entityType: e.target.value.trim() })} />
          <div className="grid cols-2" style={{ gap: 8 }}>
            <TextInput label="From" type="date" value={draft.from} onChange={(e) => setDraft({ ...draft, from: e.target.value })} />
            <TextInput label="To" type="date" value={draft.to} onChange={(e) => setDraft({ ...draft, to: e.target.value })} />
          </div>
          <div className="row" style={{ gridColumn: '1 / -1' }}><Button type="submit" variant="primary">Apply filters</Button><Button onClick={() => { const e = { facilityId: '', action: '', entityType: '', from: '', to: '' }; setDraft(e); setFilters(e); }}>Clear</Button></div>
        </form>
      </Panel>
      <div style={{ height: 16 }} />
      <Panel title={q.data ? `${q.data.length} most recent entries` : 'Entries'} flush>
        {q.isLoading ? <Loading rows={8} /> : q.error ? <ErrorAlert error={q.error} /> : !q.data?.length ? <Empty title="No entries match these filters" /> : (
          <div className="table-wrap"><table className="data">
            <thead><tr><th>#</th><th>When</th><th>Actor</th><th>Action</th><th>Entity</th><th>Outcome</th><th>IP</th><th /></tr></thead>
            <tbody>{q.data.map((r) => (
              <Fragment key={r.id}>
                <tr>
                  <td className="mono xs">{r.id}</td>
                  <td className="small nowrap">{dateTime(r.at)}</td>
                  <td className="small">{r.actor ?? humanize(r.actorType)}<div className="xs muted">{humanize(r.actorType)}</div></td>
                  <td className="mono small">{r.action}</td>
                  <td className="small">{r.entityType}<div className="xs muted mono">{r.entityId ?? ''}</div></td>
                  <td><Status value={r.outcome === 'SUCCESS' ? 'COMPLETED' : r.outcome === 'DENIED' ? 'REJECTED' : 'FAILED'} label={humanize(r.outcome)} /></td>
                  <td className="mono xs">{r.ip ?? '—'}</td>
                  <td className="num"><Button size="sm" variant="ghost" aria-expanded={open === r.id} onClick={() => setOpen(open === r.id ? null : r.id)}>{open === r.id ? 'Hide' : 'Details'}</Button></td>
                </tr>
                {open === r.id && (
                  <tr><td colSpan={8} style={{ background: 'var(--canvas)' }}>
                    <div className="grid cols-3">
                      {(['before', 'after', 'metadata'] as const).map((k) => <div key={k}><h4>{k}</h4><pre className="mono xs" style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{r[k] ? JSON.stringify(r[k], null, 2) : '—'}</pre></div>)}
                    </div>
                    <div className="xs muted mono" style={{ marginTop: 8 }}>hash {r.hash}{r.facilityId ? ` · facility ${r.facilityId}` : ''}</div>
                  </td></tr>
                )}
              </Fragment>
            ))}</tbody>
          </table></div>
        )}
      </Panel>
    </>
  );
}
