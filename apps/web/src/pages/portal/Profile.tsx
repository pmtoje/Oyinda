import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Check, Drawer, Empty, ErrorAlert, KV, Loading, MoneyInput, PageHeader, Panel, SelectInput, Status, TextArea, TextInput, fieldError, useAction } from '../../components/ui';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { date, humanize, money, toMinor } from '../../lib/format';

const BUSINESS_TYPES = ['LIMITED_LIABILITY', 'PUBLIC_LIMITED', 'PARTNERSHIP', 'SOLE_PROPRIETORSHIP', 'INCORPORATED_TRUSTEES', 'GOVERNMENT_AGENCY'].map((v) => ({ value: v, label: humanize(v) }));
const PARTY_TYPES = ['DIRECTOR', 'SHAREHOLDER', 'PROMOTER', 'PRINCIPAL_OFFICER', 'BOARD_MEMBER', 'KEY_EXECUTIVE'].map((v) => ({ value: v, label: humanize(v) }));
const FIELDS = ['tradingName', 'tin', 'businessType', 'addressLine', 'city', 'state', 'sectorCode', 'industry', 'businessDescription', 'productsServices', 'valueChain', 'geographicFootprint', 'employeeCount', 'hasLitigation', 'litigationDetails', 'hasRegulatoryMatters', 'regulatoryDetails'] as const;

/** Customers manage their own profile; staff views use the same API with portfolio access. */
export default function Profile({ customerId }: { customerId?: string }) {
  const { me } = useAuth();
  const cid = customerId ?? me!.customer!.id;
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['profile', cid], queryFn: () => api.get<any>(`/api/customers/${cid}/profile`) });
  const sectors = useQuery({ queryKey: ['sectors'], queryFn: () => api.get<{ code: string; name: string }[]>('/api/reference/sectors') });
  const [form, setForm] = useState<Record<string, any>>({});
  const [saved, setSaved] = useState(false);
  const [drawer, setDrawer] = useState<null | 'party' | 'bank' | 'ext' | 'cp'>(null);
  useEffect(() => { if (q.data) setForm(Object.fromEntries(FIELDS.map((f) => [f, q.data.profile[f] ?? (typeof q.data.profile[f] === 'boolean' ? false : '')]))); }, [q.data]);
  const reload = () => qc.invalidateQueries({ queryKey: ['profile', cid] });
  const save = useAction(async () => {
    const body: Record<string, any> = {};
    for (const f of FIELDS) {
      const v = form[f];
      if (f === 'hasLitigation' || f === 'hasRegulatoryMatters') body[f] = v === '' ? null : v;
      else if (f === 'employeeCount') body[f] = v === '' || v === null ? null : Number(v);
      else body[f] = v === '' ? null : v;
    }
    await api.put(`/api/customers/${cid}/profile`, body);
    setSaved(true); setTimeout(() => setSaved(false), 3000); await reload();
  });
  const remove = async (path: string, id: string) => { await api.del(`/api/customers/${cid}/${path}/${id}`); await reload(); };
  if (q.isLoading) return <Loading rows={6} />;
  if (q.error) return <ErrorAlert error={q.error} />;
  const p = q.data.profile;
  const set = (k: string) => (e: any) => setForm({ ...form, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  const yesNo = (k: string) => (
    <div className="row" role="radiogroup" aria-label={k}>
      {[['Yes', true], ['No', false]].map(([l, v]) => <label key={String(l)} className="check"><input type="radio" name={k} checked={form[k] === v} onChange={() => setForm({ ...form, [k]: v })} /><span>{l as string}</span></label>)}
    </div>
  );

  return (
    <div className="stack" style={{ ['--gap' as any]: '20px' }}>
      <PageHeader eyebrow={q.data.customer.ref} title="Business profile" sub="Your master profile is reused for every facility request, so you only provide this information once." actions={<span className="small muted">Version {p.version}</span>} />
      <Panel title="Profile completeness">
        <div className="row"><div className="progress grow" aria-label={`${q.data.completeness.pct}% complete`}><span style={{ width: `${q.data.completeness.pct}%` }} /></div><strong>{q.data.completeness.pct}%</strong></div>
        <div className="row small" style={{ marginTop: 10, ['--gap' as any]: '6px 14px' }}>{q.data.completeness.sections.map((s: any) => <span key={s.name} className={s.done ? '' : 'muted'}>{s.done ? '✓' : '○'} {s.name}</span>)}</div>
      </Panel>

      <form className="panel" onSubmit={(e) => { e.preventDefault(); void save.run(); }}>
        <div className="panel-head"><h3>Company details</h3><div className="row">{saved && <span className="small" style={{ color: 'var(--ok-700)' }} role="status">Saved</span>}<Button type="submit" variant="primary" size="sm" loading={save.loading}>Save changes</Button></div></div>
        <div className="panel-body">
          <ErrorAlert error={save.error} />
          <div className="form-section">
            <div className="intro"><h3>Registration</h3><p>Held on the Bank's core banking record. Contact your relationship manager to correct these.</p></div>
            <KV items={[['Registered name', p.registeredName], ['RC number', p.rcNumber], ['Incorporated', date(p.incorporationDate)]]} />
          </div>
          <div className="form-section">
            <div className="intro"><h3>Company</h3><p>How the business is registered and identified.</p></div>
            <div className="grid cols-2">
              <TextInput label="Trading name" value={form.tradingName ?? ''} onChange={set('tradingName')} />
              <TextInput label="Tax Identification Number (TIN)" placeholder="12345678-0001" value={form.tin ?? ''} onChange={set('tin')} error={fieldError(save.error, 'tin')} />
              <SelectInput label="Business type" placeholder="Select" options={BUSINESS_TYPES} value={form.businessType ?? ''} onChange={set('businessType')} />
              <TextInput label="Number of employees" type="number" min={0} value={form.employeeCount ?? ''} onChange={set('employeeCount')} />
            </div>
          </div>
          <div className="form-section">
            <div className="intro"><h3>Operating address</h3></div>
            <div className="grid cols-2">
              <div style={{ gridColumn: '1 / -1' }}><TextInput label="Address" value={form.addressLine ?? ''} onChange={set('addressLine')} /></div>
              <TextInput label="City" value={form.city ?? ''} onChange={set('city')} />
              <TextInput label="State" value={form.state ?? ''} onChange={set('state')} />
            </div>
          </div>
          <div className="form-section">
            <div className="intro"><h3>Business activity</h3><p>Helps the credit team understand your business without follow-up questions.</p></div>
            <div className="stack">
              <div className="grid cols-2">
                <SelectInput label="Sector" placeholder="Select sector" options={(sectors.data ?? []).map((s) => ({ value: s.code, label: s.name }))} value={form.sectorCode ?? ''} onChange={set('sectorCode')} />
                <TextInput label="Industry / sub-sector" value={form.industry ?? ''} onChange={set('industry')} />
              </div>
              <TextArea label="Business description" value={form.businessDescription ?? ''} onChange={set('businessDescription')} maxLength={3000} />
              <TextArea label="Products and services" value={form.productsServices ?? ''} onChange={set('productsServices')} maxLength={2000} />
              <TextArea label="Value chain" hint="Key inputs, suppliers, processes and how you sell." value={form.valueChain ?? ''} onChange={set('valueChain')} maxLength={2000} />
              <TextInput label="Geographic footprint" placeholder="States and countries where you operate" value={form.geographicFootprint ?? ''} onChange={set('geographicFootprint')} />
            </div>
          </div>
          <div className="form-section">
            <div className="intro"><h3>Declarations</h3><p>Answer honestly; a declared matter does not by itself prevent a facility.</p></div>
            <div className="stack">
              <div className="field"><span className="label">Is the business involved in any material litigation?</span>{yesNo('hasLitigation')}</div>
              {form.hasLitigation === true && <TextArea label="Describe the litigation" value={form.litigationDetails ?? ''} onChange={set('litigationDetails')} error={fieldError(save.error, 'litigationDetails')} />}
              <div className="field"><span className="label">Are there regulatory or tax matters outstanding?</span>{yesNo('hasRegulatoryMatters')}</div>
              {form.hasRegulatoryMatters === true && <TextArea label="Describe the matters" value={form.regulatoryDetails ?? ''} onChange={set('regulatoryDetails')} error={fieldError(save.error, 'regulatoryDetails')} />}
            </div>
          </div>
        </div>
      </form>

      <Panel title="Ownership, directors and management" actions={<Button size="sm" onClick={() => setDrawer('party')}>Add person or entity</Button>} flush>
        {!q.data.parties.length ? <Empty title="No people recorded">Add your directors, shareholders and key management.</Empty> : (
          <div className="table-wrap"><table className="data"><thead><tr><th>Name</th><th>Capacity</th><th className="num">Ownership</th><th>BVN</th><th>Declarations</th><th /></tr></thead>
            <tbody>{q.data.parties.map((x: any) => (
              <tr key={x.id}><td className="primary-cell">{x.fullName}<div className="xs muted">{x.designation}</div></td><td>{humanize(x.partyType)}</td><td className="num">{x.ownershipPct !== null ? `${x.ownershipPct}%` : '—'}</td><td className="mono">{x.bvnProvided ? x.bvn : '—'}</td>
                <td>{x.isPep && <Status value="WARNING" label="PEP" />} {x.isInsider && <Status value="WARNING" label="Insider" />}</td>
                <td className="num"><Button size="sm" variant="ghost" onClick={() => remove('parties', x.id)} aria-label={`Remove ${x.fullName}`}>Remove</Button></td></tr>))}</tbody></table></div>
        )}
      </Panel>

      <div className="grid cols-2">
        <Panel title="Accounts with Alternative Bank"><ul className="small" style={{ margin: 0, paddingLeft: 18 }}>{q.data.alternativeBankAccounts.map((a: any) => <li key={a.account}>{a.account} · {a.currency} · {a.product}</li>)}</ul></Panel>
        <SubList title="Other bank relationships" rows={q.data.banks} onAdd={() => setDrawer('bank')} onRemove={(id) => remove('banks', id)} render={(b) => <>{b.bankName}<div className="xs muted">{b.accountType ?? 'Account'}{b.accountNumberLast4 ? ` ••••${b.accountNumberLast4}` : ''} · {b.currency}</div></>} empty="Add accounts you hold with other banks." />
        <SubList title="Existing facilities with other lenders" rows={q.data.externalFacilities} onAdd={() => setDrawer('ext')} onRemove={(id) => remove('external-facilities', id)} render={(b) => <>{b.lender} — {b.facilityType}<div className="xs muted">Limit {money(b.amountMinor, b.currency)} · outstanding {money(b.outstandingMinor, b.currency)}{b.performing ? '' : ' · not performing'}</div></>} empty="Declare facilities from other lenders, if any." />
        <SubList title="Key suppliers and customers" rows={q.data.counterparties} onAdd={() => setDrawer('cp')} onRemove={(id) => remove('counterparties', id)} render={(b) => <>{b.name}<div className="xs muted">{humanize(b.kind)}{b.sharePct !== null ? ` · ${b.sharePct}% share` : ''}</div></>} empty="Add your main suppliers and customers." />
      </div>

      {drawer === 'party' && <PartyDrawer cid={cid} onClose={() => setDrawer(null)} onDone={reload} />}
      {drawer === 'bank' && <SimpleDrawer title="Add bank relationship" path={`/api/customers/${cid}/banks`} onClose={() => setDrawer(null)} onDone={reload} fields={[['bankName', 'Bank name', 'text'], ['accountType', 'Account type', 'text'], ['accountNumberLast4', 'Last 4 digits of account', 'text'], ['currency', 'Currency', 'ccy']]} />}
      {drawer === 'ext' && <SimpleDrawer title="Add existing facility" path={`/api/customers/${cid}/external-facilities`} onClose={() => setDrawer(null)} onDone={reload} fields={[['lender', 'Lender', 'text'], ['facilityType', 'Facility type', 'text'], ['currency', 'Currency', 'ccy'], ['amountMinor', 'Facility limit', 'money'], ['outstandingMinor', 'Amount outstanding', 'money'], ['maturityDate', 'Maturity date', 'date'], ['performing', 'Performing (payments up to date)', 'bool']]} />}
      {drawer === 'cp' && <SimpleDrawer title="Add supplier or customer" path={`/api/customers/${cid}/counterparties`} onClose={() => setDrawer(null)} onDone={reload} fields={[['kind', 'Type', 'kind'], ['name', 'Name', 'text'], ['sharePct', 'Share of purchases/sales (%)', 'number'], ['relationshipYears', 'Years of relationship', 'number']]} />}
    </div>
  );
}

function SubList({ title, rows, onAdd, onRemove, render, empty }: { title: string; rows: any[]; onAdd: () => void; onRemove: (id: string) => void; render: (r: any) => React.ReactNode; empty: string }) {
  return (
    <Panel title={title} actions={<Button size="sm" onClick={onAdd}>Add</Button>}>
      {!rows.length ? <p className="small muted">{empty}</p> : <ul className="flag-list">{rows.map((r) => <li key={r.id} className="row between"><div className="small">{render(r)}</div><Button size="sm" variant="ghost" onClick={() => onRemove(r.id)}>Remove</Button></li>)}</ul>}
    </Panel>
  );
}

function PartyDrawer({ cid, onClose, onDone }: { cid: string; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState<any>({ partyType: 'DIRECTOR', entityKind: 'INDIVIDUAL', fullName: '', designation: '', ownershipPct: '', nationality: 'Nigerian', bvn: '', isPep: false, pepDetails: '', isInsider: false, insiderRelationship: '', yearsExperience: '' });
  const save = useAction(async () => {
    await api.post(`/api/customers/${cid}/parties`, {
      partyType: f.partyType, entityKind: f.entityKind, fullName: f.fullName, designation: f.designation || null, nationality: f.nationality || null,
      ownershipPct: f.ownershipPct === '' ? null : Number(f.ownershipPct), yearsExperience: f.yearsExperience === '' ? null : Number(f.yearsExperience),
      ...(f.bvn && f.entityKind === 'INDIVIDUAL' ? { bvn: f.bvn } : {}), isPep: f.isPep, pepDetails: f.isPep ? f.pepDetails : null, isInsider: f.isInsider, insiderRelationship: f.isInsider ? f.insiderRelationship : null,
    });
    onDone(); onClose();
  });
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  return (
    <Drawer title="Add person or entity" onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={save.loading} onClick={() => save.run()} disabled={!f.fullName}>Add</Button></>}>
      <form className="stack" onSubmit={(e) => { e.preventDefault(); void save.run(); }}>
        <ErrorAlert error={save.error} />
        <div className="grid cols-2">
          <SelectInput label="Capacity" options={PARTY_TYPES} value={f.partyType} onChange={set('partyType')} />
          <SelectInput label="Type" options={[{ value: 'INDIVIDUAL', label: 'Individual' }, { value: 'CORPORATE', label: 'Company' }]} value={f.entityKind} onChange={set('entityKind')} />
        </div>
        <TextInput label="Full name" required value={f.fullName} onChange={set('fullName')} error={fieldError(save.error, 'fullName')} />
        <div className="grid cols-2">
          <TextInput label="Designation" value={f.designation} onChange={set('designation')} />
          {f.partyType === 'SHAREHOLDER' ? <TextInput label="Shareholding (%)" type="number" min={0} max={100} step="0.01" value={f.ownershipPct} onChange={set('ownershipPct')} /> : <TextInput label="Years of experience" type="number" min={0} value={f.yearsExperience} onChange={set('yearsExperience')} />}
        </div>
        {f.entityKind === 'INDIVIDUAL' && <TextInput label="BVN" inputMode="numeric" maxLength={11} hint="Verified with the identity service and stored encrypted. Only the last 4 digits are ever shown." value={f.bvn} onChange={(e) => setF({ ...f, bvn: e.target.value.replace(/\D/g, '').slice(0, 11) })} error={fieldError(save.error, 'bvn')} />}
        <Check label="This person is a Politically Exposed Person (PEP) or closely associated with one" checked={f.isPep} onChange={set('isPep')} />
        {f.isPep && <TextArea label="PEP details" value={f.pepDetails} onChange={set('pepDetails')} error={fieldError(save.error, 'pepDetails')} />}
        <Check label="This person is a director, staff member or related party of Alternative Bank" checked={f.isInsider} onChange={set('isInsider')} />
        {f.isInsider && <TextArea label="Describe the relationship" value={f.insiderRelationship} onChange={set('insiderRelationship')} error={fieldError(save.error, 'insiderRelationship')} />}
        {(f.isPep || f.isInsider) && <Alert tone="info">Declared relationships follow the Bank's approved review route. Declaring them avoids delays later.</Alert>}
      </form>
    </Drawer>
  );
}

function SimpleDrawer({ title, path, fields, onClose, onDone }: { title: string; path: string; fields: [string, string, string][]; onClose: () => void; onDone: () => void }) {
  const [v, setV] = useState<Record<string, any>>({ currency: 'NGN', kind: 'SUPPLIER', performing: true });
  const save = useAction(async () => {
    const body: Record<string, any> = {};
    for (const [k, , t] of fields) {
      const x = v[k];
      if (x === undefined || x === '') continue;
      body[k] = t === 'money' ? toMinor(String(x)) : t === 'number' ? Number(x) : x;
    }
    await api.post(path, body); onDone(); onClose();
  });
  return (
    <Drawer title={title} onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={save.loading} onClick={() => save.run()}>Add</Button></>}>
      <form className="stack" onSubmit={(e) => { e.preventDefault(); void save.run(); }}>
        <ErrorAlert error={save.error} />
        {fields.map(([k, label, t]) => t === 'bool' ? <Check key={k} label={label} checked={!!v[k]} onChange={(e) => setV({ ...v, [k]: e.target.checked })} />
          : t === 'ccy' ? <SelectInput key={k} label={label} options={['NGN', 'USD', 'GBP', 'EUR'].map((c) => ({ value: c, label: c }))} value={v[k]} onChange={(e) => setV({ ...v, [k]: e.target.value })} />
          : t === 'kind' ? <SelectInput key={k} label={label} options={[{ value: 'SUPPLIER', label: 'Supplier' }, { value: 'CUSTOMER', label: 'Customer' }]} value={v[k]} onChange={(e) => setV({ ...v, [k]: e.target.value })} />
          : t === 'money' ? <MoneyInput key={k} label={label} currency={v.currency} value={v[k] ?? ''} onChange={(e) => setV({ ...v, [k]: e.target.value })} />
          : <TextInput key={k} label={label} type={t === 'date' ? 'date' : t === 'number' ? 'number' : 'text'} value={v[k] ?? ''} onChange={(e) => setV({ ...v, [k]: e.target.value })} error={fieldError(save.error, k)} />)}
      </form>
    </Drawer>
  );
}
