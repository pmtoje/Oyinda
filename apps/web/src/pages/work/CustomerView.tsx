import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api, idem } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { dateTime } from '../../lib/format';
import { Button, Drawer, Empty, ErrorAlert, Loading, PageHeader, Panel, Status, useAction } from '../../components/ui';
import { CustomerTab } from './parts/overview';

export default function CustomerView() {
  const { id = '' } = useParams();
  const { can } = useAuth();
  const nav = useNavigate();
  const profile = useQuery({ queryKey: ['fac', id, 'profile'], queryFn: () => api.get<any>(`/api/customers/${id}/profile`) });
  const facs = useQuery({ queryKey: ['facilities', 'customer', id], queryFn: () => api.get<any[]>(`/api/facilities?customerId=${id}&limit=100`) });
  const [starting, setStarting] = useState(false);
  if (profile.isLoading) return <Loading rows={5} />;
  if (profile.error) return <ErrorAlert error={profile.error} title="This customer could not be opened" />;
  const c = profile.data.customer;
  return (
    <>
      <PageHeader crumbs={<><Link to="/work/customers">Customers</Link> / {c.ref}</>} title={c.name} sub={`RM: ${c.relationshipManager?.name ?? 'Unassigned'}`}
        actions={can('facility.initiate') && <Button variant="primary" onClick={() => setStarting(true)}>Start facility request</Button>} />
      <div className="stack">
        <Panel title="Facility requests" flush>
          {facs.isLoading ? <Loading /> : facs.error ? <ErrorAlert error={facs.error} /> : !facs.data!.length ? <Empty title="No facility requests" /> : (
            <div className="table-wrap"><table className="data"><thead><tr><th>Reference</th><th>Product</th><th className="num">Amount</th><th>Status</th><th>Updated</th></tr></thead>
              <tbody>{facs.data!.map((f) => <tr key={f.id} className="clickable" tabIndex={0} onClick={() => nav(`/work/facilities/${f.id}`)} onKeyDown={(e) => e.key === 'Enter' && nav(`/work/facilities/${f.id}`)}><td className="primary-cell mono">{f.ref}</td><td>{f.productName}</td><td className="num">{f.amountText ?? '—'}</td><td><Status value={f.status} label={f.statusLabel} /></td><td className="small">{dateTime(f.updatedAt)}</td></tr>)}</tbody></table></div>)}
        </Panel>
        <CustomerTab id={id} customerId={id} />
      </div>
      {starting && <StartDrawer customerId={id} onClose={() => setStarting(false)} onDone={(fid) => nav(`/work/facilities/${fid}`)} />}
    </>
  );
}

function StartDrawer({ customerId, onClose, onDone }: { customerId: string; onClose: () => void; onDone: (id: string) => void }) {
  const products = useQuery({ queryKey: ['products', 'staff'], queryFn: () => api.get<any[]>('/api/products') });
  const [code, setCode] = useState('');
  const [key] = useState(idem());
  const go = useAction(async () => { const f = await api.post<any>('/api/facilities', { productCode: code, idempotencyKey: key, customerId }); onDone(f.id); });
  return (
    <Drawer title="Start an RM-initiated facility request" onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!code} loading={go.loading} onClick={() => go.run()}>Create draft</Button></>}>
      <div className="stack">
        <p className="small muted">RM-initiated requests follow the alternative approval route configured by Credit Risk. Complete the request details from the facility workspace or the customer portal.</p>
        {products.isLoading ? <Loading /> : (
          <div className="stack" style={{ ['--gap' as any]: '8px' }} role="radiogroup" aria-label="Product">{(products.data ?? []).map((p) => (
            <button key={p.code} className={code === p.code ? 'choice selected' : 'choice'} aria-pressed={code === p.code} onClick={() => setCode(p.code)}><div className="title">{p.name}</div><div className="desc">{p.summary}</div></button>))}</div>)}
        <ErrorAlert error={go.error ?? products.error} />
      </div>
    </Drawer>
  );
}
