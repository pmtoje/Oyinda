import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Button, ErrorAlert, Loading, PageHeader, Panel, useAction } from '../../components/ui';
import { api, idem } from '../../lib/api';
import { money } from '../../lib/format';

const GROUPS: [string, string, string][] = [
  ['DIRECT', 'Financing', 'Asset, trade and project financing where the Bank buys, leases or commissions the asset.'],
  ['CONTINGENT', 'Guarantees & bonds (Kafalah)', 'Guarantees issued by the Bank in your favour for a fee.'],
  ['INVESTMENT', 'Partnership & investment', 'Profit-sharing arrangements where returns depend on performance.'],
];

export default function NewFacility() {
  const nav = useNavigate();
  const products = useQuery({ queryKey: ['products'], queryFn: () => api.get<any[]>('/api/products') });
  const [selected, setSelected] = useState<string | null>(null);
  const key = useMemo(() => idem(), []); // one key per visit: double-clicks never create two requests
  const create = useAction(async () => { const f = await api.post<any>('/api/facilities', { productCode: selected, idempotencyKey: `${key}-${selected}` }); nav(`/portal/facilities/${f.id}/apply`); });
  const product = products.data?.find((p) => p.code === selected);
  return (
    <>
      <PageHeader crumbs={<><Link to="/portal">Overview</Link> / New facility request</>} title="Start a facility request" sub="Choose the structure that fits your need. Your relationship manager can advise if you are unsure." />
      {products.isLoading ? <Loading /> : products.error ? <ErrorAlert error={products.error} /> : (
        <div className="workspace">
          <div className="stack" style={{ ['--gap' as any]: '24px' }}>
            {GROUPS.map(([cat, title, desc]) => {
              const items = products.data!.filter((p) => p.category === cat);
              if (!items.length) return null;
              return (
                <section key={cat} aria-labelledby={`g-${cat}`}>
                  <h3 id={`g-${cat}`}>{title}</h3>
                  <p className="small muted">{desc}</p>
                  <div className="grid cols-2">
                    {items.map((p) => (
                      <button key={p.code} className="choice" aria-pressed={selected === p.code} onClick={() => setSelected(p.code)}>
                        <div className="title">{p.name}</div>
                        <div className="desc">{p.summary}</div>
                      </button>
                    ))}
                  </div>
                </section>
              );
            })}
          </div>
          <aside className="action-rail">
            <Panel title={product ? product.name : 'Selected product'} footer={<Button variant="primary" className="block" disabled={!product} loading={create.loading} onClick={() => create.run()}>Continue with {product?.name ?? 'product'}</Button>}>
              {!product ? <p className="small muted">Select a product to see how it is structured.</p> : (
                <div className="stack small">
                  <p>{product.summary}</p>
                  <div><h4>Shariah structure</h4><p>{product.shariahStructure}</p></div>
                  <dl className="kv">
                    <dt>Amount</dt><dd>{money(product.minAmountMinor, product.currencies[0], { compact: true })} – {money(product.maxAmountMinor, product.currencies[0], { compact: true })}</dd>
                    <dt>Tenor</dt><dd>{product.minTenorMonths}–{product.maxTenorMonths} months</dd>
                    <dt>Currency</dt><dd>{product.currencies.join(', ')}</dd>
                    {product.indicativeProfitRatePct !== undefined && <><dt>{product.pricingBasis === 'FEE' ? 'Indicative fee' : 'Indicative profit rate'}</dt><dd>{product.indicativeProfitRatePct}% {product.pricingBasis === 'FEE' ? '' : 'p.a.'} (final pricing on approval)</dd></>}
                  </dl>
                  <ErrorAlert error={create.error} />
                </div>
              )}
            </Panel>
          </aside>
        </div>
      )}
    </>
  );
}
