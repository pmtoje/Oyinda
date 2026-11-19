import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button, Check, Empty, ErrorAlert, Loading, MoneyInput, SelectInput, Status, TextArea, TextInput, fieldError, useAction } from '../../../components/ui';
import { api } from '../../../lib/api';
import { date, humanize, majorInput, money, toMinor } from '../../../lib/format';

const FREQ_LABEL: Record<string, string> = { MONTHLY: 'Monthly', QUARTERLY: 'Quarterly', SEMI_ANNUAL: 'Semi-annually', ANNUAL: 'Annually', BULLET: 'Bullet (single payment at maturity)' };

export function DetailsStep({ v, set, product, error }: { v: any; set: (k: string, x: any) => void; product: any; error: unknown }) {
  return (
    <div className="stack">
      <div className="grid cols-2">
        <SelectInput label="Currency" options={product.currencies.map((c: string) => ({ value: c, label: c }))} value={v.currency} onChange={(e) => set('currency', e.target.value)} />
        <MoneyInput label="Facility amount" required currency={v.currency} value={v.amount} onChange={(e) => set('amount', e.target.value)} hint={`Between ${money(product.minAmountMinor, v.currency, { compact: true })} and ${money(product.maxAmountMinor, v.currency, { compact: true })}`} error={fieldError(error, 'amountMinor')} />
        <TextInput label="Tenor (months)" required type="number" min={product.minTenorMonths} max={product.maxTenorMonths} value={v.tenorMonths} onChange={(e) => set('tenorMonths', e.target.value)} hint={`${product.minTenorMonths}–${product.maxTenorMonths} months`} error={fieldError(error, 'tenorMonths')} />
        <SelectInput label="Payment frequency" required placeholder="Select" options={product.paymentFrequencies.map((f: string) => ({ value: f, label: FREQ_LABEL[f] ?? f }))} value={v.paymentFrequency} onChange={(e) => set('paymentFrequency', e.target.value)} error={fieldError(error, 'paymentFrequency')} />
      </div>
      <TextArea label="Purpose of the facility" required value={v.purpose} onChange={(e) => set('purpose', e.target.value)} maxLength={2000} hint="What the facility will finance and why." error={fieldError(error, 'purpose')} />
      <TextArea label="Proposed payment structure" value={v.paymentStructure} onChange={(e) => set('paymentStructure', e.target.value)} maxLength={1000} hint="For example: equal monthly payments of cost plus profit, or a moratorium before the first payment." />
      {product.category !== 'CONTINGENT' && <TextArea label="Source of payment" required value={v.sourceOfPayment} onChange={(e) => set('sourceOfPayment', e.target.value)} maxLength={2000} hint="Where the money to pay the Bank will come from (contracts, sales, receivables)." error={fieldError(error, 'sourceOfPayment')} />}
    </div>
  );
}

export function ProductStep({ v, set, setField, product, error }: { v: any; set: (k: string, x: any) => void; setField: (k: string, x: any) => void; product: any; error: unknown }) {
  const pf = v.productFields ?? {};
  return (
    <div className="stack">
      {(product.requiresSupplier || product.requiresAsset || product.requiresProject) && (
        <div className="grid cols-2">
          {product.requiresSupplier && <TextInput label="Supplier / vendor" required value={v.supplierName} onChange={(e) => set('supplierName', e.target.value)} error={fieldError(error, 'supplierName')} />}
          {product.requiresAsset && <TextInput label="Underlying asset or goods" required value={v.underlyingAsset} onChange={(e) => set('underlyingAsset', e.target.value)} error={fieldError(error, 'underlyingAsset')} />}
          {product.requiresProject && <div style={{ gridColumn: '1 / -1' }}><TextArea label="Project details" required value={v.projectDetails} onChange={(e) => set('projectDetails', e.target.value)} error={fieldError(error, 'projectDetails')} /></div>}
        </div>
      )}
      <div className="grid cols-2">
        {product.fields.map((f: any) => {
          const val = pf[f.key];
          const err = fieldError(error, f.key);
          const common = { label: f.label, required: f.required, hint: f.help, error: err };
          switch (f.type) {
            case 'textarea': return <div key={f.key} style={{ gridColumn: '1 / -1' }}><TextArea {...common} value={val ?? ''} maxLength={f.maxLength} onChange={(e) => setField(f.key, e.target.value)} /></div>;
            case 'money': return <MoneyInput key={f.key} {...common} currency={v.currency} value={typeof val === 'number' ? majorInput(val) : val ?? ''} onChange={(e) => setField(f.key, e.target.value === '' ? null : toMinor(e.target.value) ?? e.target.value)} />;
            case 'number': return <TextInput key={f.key} {...common} type="number" min={f.min} max={f.max} value={val ?? ''} onChange={(e) => setField(f.key, e.target.value === '' ? null : Number(e.target.value))} />;
            case 'date': return <TextInput key={f.key} {...common} type="date" value={val ?? ''} onChange={(e) => setField(f.key, e.target.value || null)} />;
            case 'select': return <SelectInput key={f.key} {...common} placeholder="Select" options={f.options ?? []} value={val ?? ''} onChange={(e) => setField(f.key, e.target.value || null)} />;
            case 'boolean': return <div key={f.key} style={{ gridColumn: '1 / -1' }}><Check label={f.label} checked={!!val} onChange={(e) => setField(f.key, e.target.checked)} /></div>;
            default: return <TextInput key={f.key} {...common} value={val ?? ''} maxLength={f.maxLength} onChange={(e) => setField(f.key, e.target.value)} />;
          }
        })}
      </div>
    </div>
  );
}

export function SecurityStep({ v, set, error }: { v: any; set: (k: string, x: any) => void; error: unknown }) {
  return (
    <div className="stack">
      <TextArea label="Security you propose to offer" required value={v.proposedSecurity} onChange={(e) => set('proposedSecurity', e.target.value)} maxLength={2000}
        hint="For example: legal mortgage over property (with location and title), cash deposit under lien, Sukuk, domiciliation of contract receivables, guarantees. The credit team will value and confirm the security." error={fieldError(error, 'proposedSecurity')} />
      <p className="small muted">All security must be Shariah-compliant. Interest-bearing deposits or conventional bonds cannot be accepted.</p>
    </div>
  );
}

export function FinancialsStep({ customerId }: { customerId: string }) {
  const list = useQuery({ queryKey: ['fs', customerId], queryFn: () => api.get<any[]>(`/api/customers/${customerId}/financial-statements`) });
  const tpl = useQuery({ queryKey: ['fs-template'], queryFn: () => api.get<{ lines: any[] }>('/api/financial-template') });
  const [adding, setAdding] = useState(false);
  const audited = (list.data ?? []).filter((s) => s.statementType === 'AUDITED').length;
  return (
    <div className="stack">
      <p className="small muted">Provide three years of audited financial statements and, if your latest audited year ended more than six months ago, your most recent management accounts. Upload the signed statements in the Documents step. Statements you enter once are reused for future requests.</p>
      {list.isLoading ? <Loading /> : list.error ? <ErrorAlert error={list.error} /> : !list.data!.length ? <Empty title="No financial statements yet" /> : (
        <div className="table-wrap"><table className="data"><thead><tr><th>Type</th><th>Period</th><th className="num">Revenue</th><th className="num">Profit after tax</th><th>Status</th></tr></thead>
          <tbody>{list.data!.map((s) => <tr key={s.id}><td>{humanize(s.statementType)}{s.auditor && <div className="xs muted">{s.auditor}</div>}</td><td>{date(s.periodStart)} – {date(s.periodEnd)} <span className="xs muted">({s.months} months)</span></td><td className="num">{money(s.lines.REVENUE, s.currency)}</td><td className="num">{money(s.lines.PROFIT_AFTER_TAX, s.currency)}</td><td><Status value={s.status} /></td></tr>)}</tbody></table></div>
      )}
      <div className="row between"><span className={`small ${audited >= 3 ? '' : 'muted'}`}>{audited} of 3 audited years provided</span>{!adding && <Button size="sm" onClick={() => setAdding(true)}>Add a financial statement</Button>}</div>
      {adding && tpl.data && <StatementForm customerId={customerId} lines={tpl.data.lines.filter((l) => !l.derived)} onDone={() => { setAdding(false); void list.refetch(); }} onCancel={() => setAdding(false)} />}
    </div>
  );
}

function StatementForm({ customerId, lines, onDone, onCancel }: { customerId: string; lines: any[]; onDone: () => void; onCancel: () => void }) {
  const [h, setH] = useState({ statementType: 'AUDITED', periodStart: '', periodEnd: '', currency: 'NGN', auditor: '', auditOpinion: 'UNQUALIFIED' });
  const [vals, setVals] = useState<Record<string, string>>({});
  const [showAll, setShowAll] = useState(false);
  const save = useAction(async () => {
    const out: Record<string, number> = {};
    for (const [k, x] of Object.entries(vals)) {
      if (x.trim() === '') continue;
      const neg = x.trim().startsWith('-') || /^\(.*\)$/.test(x.trim());
      const m = toMinor(x.replace(/[()-]/g, ''));
      if (m === null && Number(x.replace(/[,()\-\s₦]/g, '')) !== 0) throw Object.assign(new Error(`Check the value for ${lines.find((l) => l.code === k)?.label}.`), { status: 400 });
      out[k] = (m ?? 0) * (neg ? -1 : 1);
    }
    await api.post(`/api/customers/${customerId}/financial-statements`, { statementType: h.statementType, periodStart: h.periodStart, periodEnd: h.periodEnd, currency: h.currency, auditor: h.statementType === 'AUDITED' ? h.auditor || null : null, auditOpinion: h.statementType === 'AUDITED' ? h.auditOpinion : null, lines: out });
    onDone();
  });
  const shown = showAll ? lines : lines.filter((l) => l.required);
  const sections = ['INCOME_STATEMENT', 'BALANCE_SHEET', 'CASH_FLOW'];
  return (
    <form className="panel" onSubmit={(e) => { e.preventDefault(); void save.run(); }}>
      <div className="panel-head"><h3>New financial statement</h3></div>
      <div className="panel-body stack">
        <ErrorAlert error={save.error} />
        <div className="grid cols-4">
          <SelectInput label="Type" options={[{ value: 'AUDITED', label: 'Audited' }, { value: 'MANAGEMENT', label: 'Management accounts' }]} value={h.statementType} onChange={(e) => setH({ ...h, statementType: e.target.value })} />
          <TextInput label="Period start" type="date" required value={h.periodStart} onChange={(e) => setH({ ...h, periodStart: e.target.value })} />
          <TextInput label="Period end" type="date" required value={h.periodEnd} onChange={(e) => setH({ ...h, periodEnd: e.target.value })} hint={h.statementType === 'MANAGEMENT' ? 'Any length — e.g. 6 or 9 months.' : undefined} />
          <SelectInput label="Currency" options={['NGN', 'USD'].map((c) => ({ value: c, label: c }))} value={h.currency} onChange={(e) => setH({ ...h, currency: e.target.value })} />
        </div>
        {h.statementType === 'AUDITED' && <div className="grid cols-2"><TextInput label="Auditor" value={h.auditor} onChange={(e) => setH({ ...h, auditor: e.target.value })} /><SelectInput label="Audit opinion" options={['UNQUALIFIED', 'QUALIFIED', 'ADVERSE', 'DISCLAIMER'].map((o) => ({ value: o, label: humanize(o) }))} value={h.auditOpinion} onChange={(e) => setH({ ...h, auditOpinion: e.target.value })} /></div>}
        {sections.map((sec) => {
          const ls = shown.filter((l) => l.section === sec);
          if (!ls.length) return null;
          return (<fieldset key={sec} style={{ border: 0, padding: 0, margin: 0 }}><legend><h4>{humanize(sec)}</h4></legend>
            <div className="grid cols-3" style={{ marginTop: 8 }}>{ls.map((l) => <MoneyInput key={l.code} label={l.label} required={l.required} currency={h.currency} value={vals[l.code] ?? ''} onChange={(e) => setVals({ ...vals, [l.code]: e.target.value })} hint={l.code === 'OPERATING_EXPENSES' ? 'Include depreciation' : undefined} />)}</div></fieldset>);
        })}
        <Button variant="ghost" size="sm" onClick={() => setShowAll(!showAll)}>{showAll ? 'Show required lines only' : 'Add more detail (optional lines)'}</Button>
        <p className="xs muted">Enter amounts in full (not thousands). Use a minus sign or brackets for losses.</p>
      </div>
      <div className="panel-foot row end"><Button onClick={onCancel}>Cancel</Button><Button type="submit" variant="primary" loading={save.loading} disabled={!h.periodStart || !h.periodEnd}>Save statement</Button></div>
    </form>
  );
}

export function BankStatementsStep({ facilityId }: { facilityId: string }) {
  const list = useQuery({ queryKey: ['bank-statements', facilityId], queryFn: () => api.get<any[]>(`/api/facilities/${facilityId}/bank-statements`), refetchInterval: (q) => ((q.state.data ?? []).some((s: any) => s.status === 'QUEUED' || s.status === 'PROCESSING') ? 4000 : false) });
  const [m, setM] = useState({ bankName: 'Alternative Bank', accountNumber: '', currency: 'NGN', periodStart: '', periodEnd: '' });
  const [file, setFile] = useState<File | null>(null);
  const up = useAction(async () => { await api.upload(`/api/facilities/${facilityId}/bank-statements`, file!, m); setFile(null); setM({ ...m, accountNumber: '', periodStart: '', periodEnd: '' }); await list.refetch(); });
  return (
    <div className="stack">
      <p className="small muted">Upload 12 months of statements for each account you use for the business, at Alternative Bank and other banks. CSV or Excel exports from internet banking are analysed automatically; PDF statements are reviewed by the credit team.</p>
      <form className="panel" onSubmit={(e) => { e.preventDefault(); void up.run(); }}>
        <div className="panel-body stack">
          <ErrorAlert error={up.error} />
          <div className="grid cols-3">
            <TextInput label="Bank" required value={m.bankName} onChange={(e) => setM({ ...m, bankName: e.target.value })} />
            <TextInput label="Account number" required inputMode="numeric" maxLength={10} value={m.accountNumber} onChange={(e) => setM({ ...m, accountNumber: e.target.value.replace(/\D/g, '').slice(0, 10) })} error={fieldError(up.error, 'accountNumber')} />
            <SelectInput label="Currency" options={['NGN', 'USD', 'GBP', 'EUR'].map((c) => ({ value: c, label: c }))} value={m.currency} onChange={(e) => setM({ ...m, currency: e.target.value })} />
            <TextInput label="Statement from" type="date" required value={m.periodStart} onChange={(e) => setM({ ...m, periodStart: e.target.value })} />
            <TextInput label="Statement to" type="date" required value={m.periodEnd} onChange={(e) => setM({ ...m, periodEnd: e.target.value })} />
            <div className="field"><label htmlFor="stmt-file">File</label><input id="stmt-file" type="file" className="input" accept=".csv,.xlsx,.pdf" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></div>
          </div>
          <div><Button type="submit" variant="primary" loading={up.loading} disabled={!file || m.accountNumber.length !== 10 || !m.periodStart || !m.periodEnd}>Upload statement</Button></div>
        </div>
      </form>
      {list.isLoading ? <Loading /> : !list.data?.length ? <Empty title="No statements uploaded" /> : (
        <div className="table-wrap"><table className="data"><thead><tr><th>Bank / account</th><th>Period</th><th>Status</th><th className="num">Transactions</th></tr></thead>
          <tbody>{list.data.map((s) => (
            <tr key={s.id}><td className="primary-cell">{s.bankName}<div className="xs muted mono">{s.account} · {s.currency}</div></td><td>{date(s.periodStart)} – {date(s.periodEnd)}</td>
              <td><Status value={s.status} label={s.status === 'QUEUED' || s.status === 'PROCESSING' ? 'Analysing…' : s.status === 'NEEDS_REVIEW' ? 'Received — under review' : undefined} />{(s.status === 'FAILED' || s.status === 'NEEDS_REVIEW') && s.issues?.[0] && <div className="xs muted" style={{ maxWidth: 360 }}>{s.issues[0]}</div>}</td>
              <td className="num">{s.transactionCount ?? '—'}</td></tr>))}</tbody></table></div>
      )}
    </div>
  );
}
