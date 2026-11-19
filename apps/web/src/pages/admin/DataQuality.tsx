import { Fragment, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { Button, Empty, ErrorAlert, Loading, PageHeader, Panel, Status } from '../../components/ui';

const SEV: Record<string, string> = { HIGH: 'CRITICAL', MEDIUM: 'WARNING', LOW: 'PENDING' };

export default function DataQuality() {
  const q = useQuery({ queryKey: ['admin', 'dq'], queryFn: () => api.get<{ code: string; title: string; severity: string; count: number; rows: any[] }[]>('/api/admin/data-quality') });
  const [open, setOpen] = useState<string | null>(null);
  const issues = q.data?.filter((c) => c.count > 0).length ?? 0;
  return (
    <>
      <PageHeader eyebrow="Control centre" title="Data quality & reconciliation" sub="Automated checks for duplicates, gaps, inconsistencies and orphaned records. Investigate and correct at source; findings are not changed automatically." actions={<Button size="sm" onClick={() => q.refetch()} loading={q.isFetching}>Run checks again</Button>} />
      <Panel title={q.data ? (issues ? `${issues} check(s) with findings` : 'All checks passed') : 'Checks'} flush>
        {q.isLoading ? <Loading rows={8} /> : q.error ? <ErrorAlert error={q.error} /> : (
          <div className="table-wrap"><table className="data">
            <thead><tr><th>Check</th><th>Severity</th><th className="num">Findings</th><th /></tr></thead>
            <tbody>{q.data!.map((c) => (
              <Fragment key={c.code}>
                <tr>
                  <td className="primary-cell">{c.title}<div className="xs muted mono">{c.code}</div></td>
                  <td><Status value={SEV[c.severity]} label={c.severity.toLowerCase()} /></td>
                  <td className="num">{c.count ? <strong style={{ color: c.severity === 'HIGH' ? 'var(--danger-700)' : undefined }}>{c.count}</strong> : <span className="muted">0</span>}</td>
                  <td className="num">{c.count > 0 && <Button size="sm" variant="ghost" aria-expanded={open === c.code} onClick={() => setOpen(open === c.code ? null : c.code)}>{open === c.code ? 'Hide' : 'View findings'}</Button>}</td>
                </tr>
                {open === c.code && (
                  <tr><td colSpan={4} style={{ background: 'var(--canvas)' }}>
                    {!c.rows.length ? <Empty title="No rows" /> : (
                      <div className="table-wrap"><table className="data"><thead><tr>{Object.keys(c.rows[0]).map((k) => <th key={k}>{k.replace(/_/g, ' ')}</th>)}</tr></thead>
                        <tbody>{c.rows.map((r, i) => <tr key={i}>{Object.values(r).map((v, j) => <td key={j} className="small">{Array.isArray(v) ? v.join(', ') : v === null ? '—' : String(v)}</td>)}</tr>)}</tbody></table></div>
                    )}
                    {c.count > c.rows.length && <p className="xs muted">Showing the first {c.rows.length} of {c.count}.</p>}
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
