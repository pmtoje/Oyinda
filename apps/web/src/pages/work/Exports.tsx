import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { api } from '../../lib/api';
import { dateTime } from '../../lib/format';
import { Empty, ErrorAlert, Loading, PageHeader, Panel } from '../../components/ui';
import { ReportFilters, useReportFilters } from '../admin/parts/filters';

const isDate = (v: unknown) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v);
const cell = (v: unknown) => (v === null || v === undefined ? '—' : isDate(v) ? dateTime(v as string) : typeof v === 'boolean' ? (v ? 'Yes' : 'No') : typeof v === 'number' ? v.toLocaleString('en-NG', { maximumFractionDigits: 2 }) : String(v));

export default function Exports() {
  const [sp, setSp] = useSearchParams();
  const key = sp.get('report') ?? '';
  const filters = useReportFilters();
  const list = useQuery({ queryKey: ['reports', 'list'], queryFn: () => api.get<{ key: string; title: string }[]>('/api/reports') });
  const data = useQuery({ queryKey: ['reports', key, filters], queryFn: () => api.get<{ title: string; rows: Record<string, unknown>[] }>(`/api/reports/${key}?${filters}`), enabled: !!key });
  const pick = (k: string) => { const n = new URLSearchParams(sp); n.set('report', k); setSp(n); };
  const cols = data.data?.rows[0] ? Object.keys(data.data.rows[0]) : [];
  return (
    <>
      <PageHeader eyebrow="Insight" title="Report exports" sub="Preview any report with the filters below and download it as CSV. Exports are recorded in the audit log; spreadsheet formulas are neutralised in downloaded files." />
      <ReportFilters />
      <div className="grid" style={{ gridTemplateColumns: 'minmax(200px, 260px) minmax(0, 1fr)', marginTop: 16, alignItems: 'start' }}>
        <Panel title="Reports" flush>
          {list.isLoading ? <Loading /> : list.error ? <ErrorAlert error={list.error} /> : (
            <nav aria-label="Reports">{list.data!.map((r) => <button key={r.key} type="button" className="choice" aria-pressed={r.key === key} style={{ borderRadius: 0, border: 0, borderBottom: '1px solid var(--line)' }} onClick={() => pick(r.key)}><span className="title small">{r.title}</span></button>)}</nav>
          )}
        </Panel>
        <Panel title={data.data?.title ?? 'Preview'} actions={key ? <a className="btn sm primary" href={`/api/reports/${key}.csv?${filters}`} download>Download CSV</a> : undefined} flush>
          {!key ? <Empty title="Choose a report">Select a report to preview it.</Empty> : data.isLoading ? <Loading rows={8} /> : data.error ? <ErrorAlert error={data.error} /> : !data.data!.rows.length ? <Empty title="No rows for these filters" /> : (
            <>
              <div className="table-wrap" style={{ maxHeight: 560, overflow: 'auto' }}><div className="table-wrap"><table className="data">
                <thead><tr>{cols.map((c) => <th key={c}>{c.replace(/_/g, ' ')}</th>)}</tr></thead>
                <tbody>{data.data!.rows.slice(0, 200).map((r, i) => <tr key={i}>{cols.map((c) => <td key={c} className={typeof r[c] === 'number' ? 'num small' : 'small'}>{cell(r[c])}</td>)}</tr>)}</tbody>
              </table></div></div>
              <div className="panel-foot small muted">{data.data!.rows.length > 200 ? `Showing the first 200 of ${data.data!.rows.length} rows. Download the CSV for the full report.` : `${data.data!.rows.length} rows.`}</div>
            </>
          )}
        </Panel>
      </div>
    </>
  );
}
