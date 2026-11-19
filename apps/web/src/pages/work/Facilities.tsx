import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { FACILITY_STATUS_LABEL } from '@gazelle/shared';
import { api } from '../../lib/api';
import { dateTime } from '../../lib/format';
import { Empty, ErrorAlert, Loading, PageHeader, Panel, Status } from '../../components/ui';

export default function Facilities() {
  const nav = useNavigate();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [term, setTerm] = useState('');
  const q = useQuery({ queryKey: ['facilities', term, status], queryFn: () => api.get<any[]>(`/api/facilities?limit=200${term ? `&search=${encodeURIComponent(term)}` : ''}${status ? `&status=${status}` : ''}`) });
  return (
    <>
      <PageHeader title="Facilities" sub="Requests you can access, most recently updated first." />
      <form className="row" style={{ marginBottom: 14 }} onSubmit={(e) => { e.preventDefault(); setTerm(search.trim()); }} role="search">
        <label className="sr-only" htmlFor="fsearch">Search by reference or customer</label>
        <input id="fsearch" className="input" style={{ maxWidth: 320 }} placeholder="Reference or customer name" value={search} onChange={(e) => setSearch(e.target.value)} />
        <label className="sr-only" htmlFor="fstatus">Status</label>
        <select id="fstatus" className="select" style={{ maxWidth: 240 }} value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All statuses</option>{Object.entries(FACILITY_STATUS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <button className="btn" type="submit">Search</button>
      </form>
      <Panel flush>
        {q.isLoading ? <Loading /> : q.error ? <ErrorAlert error={q.error} /> : !q.data!.length ? <Empty title="No facilities match" /> : (
          <div className="table-wrap"><table className="data"><thead><tr><th>Reference</th><th>Customer</th><th>Product</th><th className="num">Amount</th><th>Tenor</th><th>Status</th><th>Submitted</th><th>Updated</th></tr></thead>
            <tbody>{q.data!.map((f) => (
              <tr key={f.id} className="clickable" tabIndex={0} onClick={() => nav(`/work/facilities/${f.id}`)} onKeyDown={(e) => e.key === 'Enter' && nav(`/work/facilities/${f.id}`)}>
                <td className="primary-cell mono">{f.ref}{f.isDemo && <span className="tag" style={{ marginLeft: 6 }}>DEMO</span>}</td><td>{f.customerName}<div className="xs muted">{f.origin === 'RM' ? 'RM-initiated' : 'Customer'}</div></td><td>{f.productName}</td>
                <td className="num">{f.amountText ?? '—'}</td><td>{f.tenorMonths ? `${f.tenorMonths}m` : '—'}</td><td><Status value={f.status} label={f.statusLabel} /></td><td className="small">{dateTime(f.submittedAt)}</td><td className="small">{dateTime(f.updatedAt)}</td>
              </tr>))}</tbody></table></div>)}
      </Panel>
    </>
  );
}
