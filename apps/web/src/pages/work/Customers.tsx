import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { Empty, ErrorAlert, Loading, PageHeader, Panel, Status } from '../../components/ui';

export default function Customers() {
  const { can } = useAuth();
  const nav = useNavigate();
  const [filter, setFilter] = useState('');
  const full = true; // portfolio scoping is enforced by GET /api/customers
  void can;
  const admin = useQuery({ queryKey: ['customers', 'admin'], queryFn: () => api.get<any[]>('/api/customers'), enabled: full });
  const facs = useQuery({ queryKey: ['facilities', 'portfolio'], queryFn: () => api.get<any[]>('/api/facilities?limit=200'), enabled: !full });
  const rows = useMemo(() => {
    if (full) return admin.data ?? [];
    const m = new Map<string, any>();
    for (const f of facs.data ?? []) { const c = m.get(f.customerId) ?? { id: f.customerId, name: f.customerName, facilities: 0, isDemo: f.isDemo }; c.facilities++; m.set(f.customerId, c); }
    return [...m.values()];
  }, [full, admin.data, facs.data]);
  const q = full ? admin : facs;
  const shown = rows.filter((r: any) => !filter || r.name.toLowerCase().includes(filter.toLowerCase()) || r.ref?.toLowerCase().includes(filter.toLowerCase()));
  return (
    <>
      <PageHeader title="Customers" sub="Customers in your portfolio (bank-wide for credit and risk roles)." />
      <div className="row" style={{ marginBottom: 14 }}><label className="sr-only" htmlFor="csearch">Filter customers</label><input id="csearch" className="input" style={{ maxWidth: 320 }} placeholder="Filter by name or reference" value={filter} onChange={(e) => setFilter(e.target.value)} /></div>
      <Panel flush>
        {q.isLoading ? <Loading /> : q.error ? <ErrorAlert error={q.error} /> : !shown.length ? <Empty title="No customers to show">{!full && 'Customers appear here once they have a facility request in your portfolio.'}</Empty> : (
          <div className="table-wrap"><table className="data"><thead><tr><th>Customer</th><th>Reference</th><th>Relationship Manager</th><th>Status</th><th className="num">Facilities</th></tr></thead>
            <tbody>{shown.map((c: any) => <tr key={c.id} className="clickable" tabIndex={0} onClick={() => nav(`/work/customers/${c.id}`)} onKeyDown={(e) => e.key === 'Enter' && nav(`/work/customers/${c.id}`)}><td className="primary-cell">{c.name}{c.isDemo && <span className="tag" style={{ marginLeft: 6 }}>DEMO</span>}</td><td className="mono small">{c.ref ?? '—'}</td><td>{c.rm ?? '—'}</td><td>{c.status ? <Status value={c.status} /> : '—'}</td><td className="num">{c.facilities}</td></tr>)}</tbody></table></div>)}
      </Panel>
    </>
  );
}
