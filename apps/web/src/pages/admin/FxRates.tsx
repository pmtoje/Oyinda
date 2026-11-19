import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { date, dateTime } from '../../lib/format';
import { Alert, Button, Empty, ErrorAlert, Loading, PageHeader, Panel, SelectInput, TextInput, useAction } from '../../components/ui';

export default function FxRates() {
  const qc = useQueryClient();
  const { can } = useAuth();
  const rates = useQuery({ queryKey: ['admin', 'fx'], queryFn: () => api.get<any[]>('/api/admin/fx-rates') });
  const [f, setF] = useState({ base: 'USD', rate: '', rateDate: new Date().toISOString().slice(0, 10), source: 'CBN NAFEM closing rate' });
  const [done, setDone] = useState(false);
  const save = useAction(async () => { await api.post('/api/admin/fx-rates', { base: f.base, quote: 'NGN', rate: Number(f.rate), rateDate: f.rateDate, source: f.source }); setDone(true); setF({ ...f, rate: '' }); await qc.invalidateQueries({ queryKey: ['admin', 'fx'] }); });
  const rateNum = Number(f.rate);
  return (
    <>
      <PageHeader eyebrow="Control centre" title="FX rates" sub="Used to convert foreign-currency turnover, collateral and facilities to Naira. Each analysis records exactly which rate it used." />
      <div className="workspace">
        <Panel title="Recorded rates" flush>
          {rates.isLoading ? <Loading /> : rates.error ? <ErrorAlert error={rates.error} /> : !rates.data?.length ? <Empty title="No rates recorded">Foreign-currency values cannot be converted until a rate is recorded. Gazelle never estimates a rate.</Empty> : (
            <div className="table-wrap"><table className="data"><thead><tr><th>Pair</th><th className="num">Rate</th><th>Rate date</th><th>Source</th><th>Recorded by</th><th>Recorded</th></tr></thead>
              <tbody>{rates.data.map((r) => <tr key={r.id}><td className="primary-cell">{r.base}/{r.quote}</td><td className="num">{Number(r.rate).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 6 })}</td><td>{date(r.rateDate)}</td><td className="small">{r.source}</td><td className="small">{r.enteredBy ?? 'System'}</td><td className="small nowrap">{dateTime(r.createdAt)}</td></tr>)}</tbody></table></div>
          )}
        </Panel>
        <aside className="action-rail">
          {can('config.edit') ? (
            <Panel title="Record a rate">
              <div className="stack">
                <Alert tone="info">Rates are immutable once recorded. To correct a rate, record a new one with the same date from the correct source; analyses keep the exact rate they used.</Alert>
                {done && <Alert tone="ok">Rate recorded.</Alert>}
                <SelectInput label="Currency" value={f.base} options={['USD', 'GBP', 'EUR', 'CNY', 'AED', 'SAR'].map((c) => ({ value: c, label: `${c} → NGN` }))} onChange={(e) => setF({ ...f, base: e.target.value })} />
                <TextInput label="Rate (₦ per 1 unit)" inputMode="decimal" required value={f.rate} onChange={(e) => { setDone(false); setF({ ...f, rate: e.target.value }); }} error={f.rate && !(rateNum > 0) ? 'Enter a positive number.' : undefined} />
                <TextInput label="Rate date" type="date" required value={f.rateDate} onChange={(e) => setF({ ...f, rateDate: e.target.value })} />
                <TextInput label="Source" required value={f.source} onChange={(e) => setF({ ...f, source: e.target.value })} />
                <ErrorAlert error={save.error} />
                <Button variant="primary" loading={save.loading} disabled={!(rateNum > 0) || f.source.trim().length < 3} onClick={() => save.run()}>Record rate</Button>
              </div>
            </Panel>
          ) : <Alert tone="info">You can view rates. Recording a rate requires configuration-maker permission.</Alert>}
        </aside>
      </div>
    </>
  );
}
