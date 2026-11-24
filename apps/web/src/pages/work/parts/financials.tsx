import { SpoolStatementButton } from '../../../components/SpoolStatement';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../../lib/api';
import { useAuth } from '../../../lib/auth';
import { date, dateTime, humanize, money, pct, toMinor } from '../../../lib/format';
import { Alert, Button, Drawer, Empty, ErrorAlert, Panel, SelectInput, Status, TextArea, TextInput, useAction } from '../../../components/ui';
import { fmtRatio, QueryState, Section, useFac, useRefresh } from './common';

export function FinancialsTab({ id, customerId }: { id: string; customerId: string }) {
  const { can } = useAuth();
  const stmts = useFac<any[]>(id, 'fs', `/api/customers/${customerId}/financial-statements`);
  const analysis = useFac<any>(id, 'fa', `/api/facilities/${id}/financial-analysis`);
  const [capture, setCapture] = useState(false);
  const refresh = useRefresh(id);
  const run = useAction(async () => { await api.post(`/api/facilities/${id}/financial-analysis`); await refresh(); });
  const validate = useAction(async (sid: string) => { await api.post(`/api/financial-statements/${sid}/validate`); await refresh(); });
  const a = analysis.data;
  const periods: any[] = a?.periods ?? [];
  const ratioKeys = [...new Map((a?.ratios ?? []).map((r: any) => [r.key, r])).values()] as any[];
  return (
    <div className="stack">
      <Section title="Financial statements" sub="Audited accounts and management accounts keep their true period length; flows are annualised only for ratio analysis."
        actions={<>{can('financials.edit') && <Button size="sm" onClick={() => setCapture(true)}>Capture statement</Button>}{can('financials.validate') && <Button size="sm" variant="primary" onClick={() => run.run()} loading={run.loading}>Run analysis</Button>}</>}>
        <ErrorAlert error={run.error ?? validate.error} />
        <Panel flush>
          <QueryState q={stmts} empty={<Empty title="No financial statements captured">Capture three years of audited statements and any recent management accounts.</Empty>}>{() => (
            <div className="table-wrap"><table className="data"><thead><tr><th>Period</th><th>Type</th><th className="num">Revenue</th><th className="num">Profit after tax</th><th className="num">Total assets</th><th>Auditor</th><th>Status</th><th /></tr></thead>
              <tbody>{stmts.data!.map((s) => (
                <tr key={s.id}><td className="primary-cell">{date(s.periodStart)} – {date(s.periodEnd)}<div className="xs muted">{s.months} months · {s.currency}</div></td><td>{humanize(s.statementType)}</td>
                  <td className="num">{money(s.lines.REVENUE, s.currency, { compact: true })}</td><td className="num">{money(s.lines.PROFIT_AFTER_TAX, s.currency, { compact: true })}</td><td className="num">{money(s.lines.TOTAL_ASSETS, s.currency, { compact: true })}</td>
                  <td className="small">{s.auditor ?? '—'}{s.auditOpinion && <div className="xs muted">{humanize(s.auditOpinion)}</div>}</td><td><Status value={s.status} />{s.uncertainLines?.length > 0 && <div className="xs muted">{s.uncertainLines.length} uncertain</div>}</td>
                  <td className="num">{can('financials.validate') && s.status !== 'VALIDATED' && <Button size="sm" onClick={() => validate.run(s.id)}>Validate</Button>}</td></tr>))}</tbody></table></div>)}</QueryState>
        </Panel>
      </Section>
      {a && (
        <>
          <div className="grid cols-3">
            <div className="metric"><div className="label">Financial score (FRR input)</div><div className="value">{a.frrScore ?? '—'}</div><div className="sub">Weighted ratio score, 0–100</div></div>
            <div className="metric"><div className="label">Periods analysed</div><div className="value">{periods.length}</div><div className="sub">Template v{a.templateVersion}</div></div>
            <div className={a.quality?.some((x: any) => x.severity === 'ERROR') ? 'metric metric-alert' : 'metric'}><div className="label">Data-quality issues</div><div className="value">{a.quality?.length ?? 0}</div><div className="sub">Run {dateTime(a.runAt)}</div></div>
          </div>
          {a.quality?.length > 0 && <Alert tone={a.quality.some((x: any) => x.severity === 'ERROR') ? 'danger' : 'warn'} title="Data-quality checks"><ul>{a.quality.map((x: any, i: number) => <li key={i}>{x.message}</li>)}</ul></Alert>}
          <Panel title="Key figures" flush>
            <div className="table-wrap"><table className="data"><thead><tr><th>Line</th>{periods.map((p) => <th key={p.statementId} className="num">{p.type === 'AUDITED' ? 'FY' : humanize(p.type)} {p.periodEnd.slice(0, 7)}{p.months !== 12 ? ` (${p.months}m)` : ''}</th>)}</tr></thead>
              <tbody>{['REVENUE', 'GROSS_PROFIT', 'EBITDA', 'OPERATING_PROFIT', 'PROFIT_BEFORE_TAX', 'PROFIT_AFTER_TAX', 'TOTAL_ASSETS', 'TOTAL_LIABILITIES', 'TOTAL_EQUITY', 'TOTAL_FINANCING', 'WORKING_CAPITAL', 'OPERATING_CASH_FLOW'].map((k) => (
                <tr key={k}><td>{humanize(k)}</td>{periods.map((p) => <td key={p.statementId} className="num">{money(p.keyLines[k], 'NGN', { compact: true })}</td>)}</tr>))}</tbody></table></div>
          </Panel>
          <Panel title="Ratio analysis" flush actions={<span className="xs muted">Formulas, bands and weights are configured by Credit Risk</span>}>
            <div className="table-wrap"><table className="data"><thead><tr><th>Ratio</th>{periods.map((p) => <th key={p.statementId} className="num">{p.periodEnd.slice(0, 7)}</th>)}<th>Latest assessment</th></tr></thead>
              <tbody>{ratioKeys.map((rk) => {
                const latest = a.ratios.find((r: any) => r.key === rk.key && r.statementId === periods[0]?.statementId);
                return (
                  <tr key={rk.key}><td className="primary-cell">{rk.name}<div className="xs muted">{humanize(rk.category)} · weight {rk.weight} · v{rk.configVersion}</div></td>
                    {periods.map((p) => { const r = a.ratios.find((x: any) => x.key === rk.key && x.statementId === p.statementId); return <td key={p.statementId} className="num" title={r?.error ?? undefined}>{r?.value !== null && r?.value !== undefined ? fmtRatio(r.value, rk.unit) : <span className="muted">—</span>}</td>; })}
                    <td className="small">{latest?.band ? <><strong>{latest.band}</strong> ({latest.score}/10)<div className="muted xs">{latest.implication}</div></> : <span className="muted">{latest?.error ?? '—'}</span>}</td></tr>);
              })}</tbody></table></div>
          </Panel>
        </>
      )}
      {capture && <CaptureDrawer customerId={customerId} onClose={() => setCapture(false)} onDone={async () => { setCapture(false); await refresh(); }} />}
    </div>
  );
}

function CaptureDrawer({ customerId, onClose, onDone }: { customerId: string; onClose: () => void; onDone: () => void }) {
  const tpl = useQuery({ queryKey: ['financial-template'], queryFn: () => api.get<any>('/api/financial-template') });
  const [meta, setMeta] = useState({ statementType: 'AUDITED', periodStart: '', periodEnd: '', currency: 'NGN', auditor: '', auditOpinion: 'UNQUALIFIED' });
  const [vals, setVals] = useState<Record<string, string>>({});
  const save = useAction(async () => {
    const lines: Record<string, number> = {};
    for (const [k, v] of Object.entries(vals)) {
      if (v.trim() === '') continue;
      const neg = v.trim().startsWith('-') || /^\(.*\)$/.test(v.trim());
      const m = toMinor(v.replace(/[()-]/g, ''));
      if (m !== null) lines[k] = neg ? -m : m;
    }
    await api.post(`/api/customers/${customerId}/financial-statements`, { ...meta, auditor: meta.auditor || null, auditOpinion: meta.statementType === 'AUDITED' ? meta.auditOpinion : null, lines });
    onDone();
  });
  const sections = ['INCOME_STATEMENT', 'BALANCE_SHEET', 'CASH_FLOW'];
  return (
    <Drawer title="Capture financial statement" onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={save.loading} onClick={() => save.run()} disabled={!meta.periodStart || !meta.periodEnd}>Save statement</Button></>}>
      <div className="stack">
        <div className="grid cols-2">
          <SelectInput label="Type" value={meta.statementType} onChange={(e) => setMeta({ ...meta, statementType: e.target.value })} options={[{ value: 'AUDITED', label: 'Audited' }, { value: 'MANAGEMENT', label: 'Management accounts' }, { value: 'PROJECTED', label: 'Projection' }]} />
          <SelectInput label="Currency" value={meta.currency} onChange={(e) => setMeta({ ...meta, currency: e.target.value })} options={[{ value: 'NGN', label: 'NGN' }, { value: 'USD', label: 'USD' }]} />
          <TextInput label="Period start" type="date" value={meta.periodStart} onChange={(e) => setMeta({ ...meta, periodStart: e.target.value })} required />
          <TextInput label="Period end" type="date" value={meta.periodEnd} onChange={(e) => setMeta({ ...meta, periodEnd: e.target.value })} required />
          {meta.statementType === 'AUDITED' && <><TextInput label="Auditor" value={meta.auditor} onChange={(e) => setMeta({ ...meta, auditor: e.target.value })} /><SelectInput label="Audit opinion" value={meta.auditOpinion} onChange={(e) => setMeta({ ...meta, auditOpinion: e.target.value })} options={['UNQUALIFIED', 'QUALIFIED', 'ADVERSE', 'DISCLAIMER'].map((v) => ({ value: v, label: humanize(v) }))} /></>}
        </div>
        <p className="small muted">Enter amounts in naira (major units). Use a minus sign or brackets for negatives. Derived lines (gross profit, EBITDA, working capital) are computed if left blank.</p>
        {tpl.data && sections.map((sec) => (
          <div key={sec} className="stack" style={{ ['--gap' as any]: '8px' }}>
            <h4>{humanize(sec)}</h4>
            {tpl.data.lines.filter((l: any) => l.section === sec).map((l: any) => (
              <div key={l.code} className="row" style={{ ['--gap' as any]: '10px' }}>
                <label htmlFor={`ln-${l.code}`} className="grow small">{l.label}{l.required && <span className="req">*</span>}{l.derived && <span className="xs muted"> (derived)</span>}</label>
                <input id={`ln-${l.code}`} className="input" style={{ maxWidth: 200, textAlign: 'right' }} inputMode="decimal" value={vals[l.code] ?? ''} onChange={(e) => setVals({ ...vals, [l.code]: e.target.value })} />
              </div>))}
          </div>))}
        <ErrorAlert error={save.error} />
      </div>
    </Drawer>
  );
}

export function StatementsTab({ id }: { id: string }) {
  const { can } = useAuth();
  const list = useFac<any[]>(id, 'stmts', `/api/facilities/${id}/bank-statements`);
  const analysis = useFac<any>(id, 'sa', `/api/facilities/${id}/statement-analysis`);
  const refresh = useRefresh(id);
  const [uploading, setUploading] = useState(false);
  const [txFor, setTxFor] = useState<any>(null);
  const run = useAction(async () => { await api.post(`/api/facilities/${id}/statement-analysis`); await refresh(); });
  const review = useAction(async (sid: string, decision: string) => { await api.post(`/api/bank-statements/${sid}/review`, { decision }); await refresh(); });
  const pending = (list.data ?? []).some((s) => ['QUEUED', 'PROCESSING'].includes(s.status));
  const a = analysis.data;
  const totals: any[] = a?.monthly?.totals ?? [];
  const max = Math.max(1, ...totals.map((t) => t.creditNgnMinor));
  return (
    <div className="stack">
      <Section title="Bank statements" sub="Statements belong to the customer and are reused across requests."
        actions={<>{can('financials.edit') && <SpoolStatementButton facilityId={id} onDone={refresh} />}{can('financials.edit') && <Button size="sm" onClick={() => setUploading(true)}>Upload statement</Button>}{can('financials.validate') && <Button size="sm" variant="primary" onClick={() => run.run()} loading={run.loading}>Run analysis</Button>}<Button size="sm" variant="ghost" onClick={() => refresh()}>Refresh</Button></>}>
        {pending && <Alert tone="info">Statement parsing is running in the background. Refresh in a moment.</Alert>}
        <ErrorAlert error={run.error ?? review.error} />
        <Panel flush>
          <QueryState q={list} empty={<Empty title="No bank statements">Upload CSV or XLSX statements from each bank and account. PDF statements need manual capture.</Empty>}>{() => (
            <div className="table-wrap"><table className="data"><thead><tr><th>Bank & account</th><th>Period</th><th>Status</th><th className="num">Transactions</th><th>Issues</th><th /></tr></thead>
              <tbody>{list.data!.map((s) => (
                <tr key={s.id}><td className="primary-cell">{s.bankName}{s.isAlternativeBank && <> <span className="tag">Alternative Bank</span></>}<div className="xs muted mono">{s.account} · {s.currency}</div></td>
                  <td className="small">{date(s.periodStart)} – {date(s.periodEnd)}</td><td><Status value={s.status} /></td>
                  <td className="num">{s.transactionCount ?? '—'}{s.uncertainCount > 0 && <div className="xs" style={{ color: 'var(--warn-700)' }}>{s.uncertainCount} uncertain</div>}</td>
                  <td className="small">{(s.issues ?? []).slice(0, 2).map((i: string, k: number) => <div key={k}>{i}</div>)}{s.issues?.length > 2 && <div className="muted xs">+{s.issues.length - 2} more</div>}</td>
                  <td className="num"><div className="row end" style={{ ['--gap' as any]: '6px' }}>
                    {s.transactionCount > 0 && <Button size="sm" onClick={() => setTxFor(s)}>{s.uncertainCount ? 'Resolve' : 'Transactions'}</Button>}
                    {can('financials.validate') && ['PARSED', 'NEEDS_REVIEW'].includes(s.status) && <Button size="sm" variant="primary" disabled={s.uncertainCount > 0} onClick={() => review.run(s.id, 'VALIDATED')}>Validate</Button>}
                    {can('financials.validate') && !['VALIDATED', 'REJECTED'].includes(s.status) && <Button size="sm" variant="ghost" onClick={() => review.run(s.id, 'REJECTED')}>Reject</Button>}
                  </div></td></tr>))}</tbody></table></div>)}</QueryState>
        </Panel>
      </Section>
      {a && (
        <>
          <div className="grid cols-4">
            <div className="metric"><div className="label">Avg. monthly credit turnover</div><div className="value">{money(a.summary.avgMonthlyCreditTurnoverNgnMinor, 'NGN', { compact: true })}</div><div className="sub">Excludes reversals</div></div>
            <div className="metric"><div className="label">Alternative Bank wallet share</div><div className="value">{pct(a.summary.walletSharePct)}</div><div className="sub">Of total credits</div></div>
            <div className={a.summary.creditTrendPct !== null && a.summary.creditTrendPct <= -10 ? 'metric metric-alert' : 'metric'}><div className="label">Credit trend</div><div className="value">{pct(a.summary.creditTrendPct)}</div><div className="sub">Last 3 vs first 3 months</div></div>
            <div className="metric"><div className="label">Coverage</div><div className="value">{a.summary.monthsCovered} months</div><div className="sub">{a.summary.accounts} account(s), {a.summary.banks} bank(s)</div></div>
          </div>
          {a.issues?.length > 0 && <Alert tone={a.issues.some((i: any) => i.severity === 'ERROR') ? 'danger' : 'warn'} title="Analysis notes"><ul>{a.issues.map((i: any, k: number) => <li key={k}>{i.message}</li>)}</ul></Alert>}
          <Panel title="Monthly credit turnover (NGN)" actions={<span className="xs muted">Run {dateTime(a.runAt)}</span>}>
            {totals.map((t) => (
              <div className="bar-row" key={t.month}><span>{t.month}</span>
                <div style={{ display: 'flex', gap: 2 }}><div className="bar" style={{ width: `${(t.altBankCreditNgnMinor / max) * 100}%` }} title="Alternative Bank" /><div className="bar accent" style={{ width: `${((t.creditNgnMinor - t.altBankCreditNgnMinor) / max) * 100}%` }} title="Other banks" /></div>
                <span className="num">{money(t.creditNgnMinor, 'NGN', { compact: true })}</span></div>))}
            <div className="row small muted" style={{ marginTop: 8 }}><span><span className="bar" style={{ display: 'inline-block', width: 12 }} /> Alternative Bank</span><span><span className="bar accent" style={{ display: 'inline-block', width: 12 }} /> Other banks</span></div>
          </Panel>
          <Panel title="Monthly summary — all accounts (NGN)" flush actions={<span className="xs muted">Foreign-currency amounts converted at the rates below</span>}>
            <div className="table-wrap"><table className="data"><thead><tr><th>Months</th><th className="num">Debit</th><th className="num">Credit</th><th className="num">Closing balances</th><th className="num">Wallet share (%)</th></tr></thead>
              <tbody>{totals.map((t) => <tr key={t.month}><td className="mono small">{t.month}</td><td className="num">{money(t.debitNgnMinor, 'NGN')}</td><td className="num">{money(t.creditNgnMinor, 'NGN')}</td><td className="num">{t.closingBalanceNgnMinor === null || t.closingBalanceNgnMinor === undefined ? '—' : money(t.closingBalanceNgnMinor, 'NGN')}</td><td className="num">{pct(t.walletSharePct)}</td></tr>)}</tbody>
              <tfoot><tr><th>Total</th><th className="num">{money(a.summary.totalDebitNgnMinor, 'NGN')}</th><th className="num">{money(a.summary.totalCreditNgnMinor, 'NGN')}</th><th /><th className="num">{pct(a.summary.walletSharePct)}</th></tr></tfoot></table></div>
          </Panel>
          {a.fxRates?.length > 0 && <Panel title="FX rates applied" flush><div className="table-wrap"><table className="data"><thead><tr><th>Pair</th><th className="num">Rate</th><th>Rate date</th><th>Source</th></tr></thead><tbody>{a.fxRates.map((r: any) => <tr key={r.id}><td>{r.base_ccy}/NGN</td><td className="num">{Number(r.rate).toLocaleString('en-NG')}</td><td>{date(r.rate_date)}</td><td className="small">{r.source ?? '—'}</td></tr>)}</tbody></table></div></Panel>}
        </>
      )}
      {uploading && <UploadStatementDrawer id={id} onClose={() => setUploading(false)} onDone={async () => { setUploading(false); await refresh(); }} />}
      {txFor && <TransactionsDrawer stmt={txFor} onClose={() => setTxFor(null)} onChanged={refresh} />}
    </div>
  );
}

function UploadStatementDrawer({ id, onClose, onDone }: { id: string; onClose: () => void; onDone: () => void }) {
  const [m, setM] = useState({ bankName: '', accountNumber: '', currency: 'NGN', periodStart: '', periodEnd: '' });
  const [file, setFile] = useState<File | null>(null);
  const go = useAction(async () => { await api.upload(`/api/facilities/${id}/bank-statements`, file!, m); onDone(); });
  return (
    <Drawer title="Upload bank statement" onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!file || !m.bankName || !/^\d{10}$/.test(m.accountNumber) || !m.periodStart || !m.periodEnd} loading={go.loading} onClick={() => go.run()}>Upload</Button></>}>
      <div className="stack">
        <TextInput label="Bank" value={m.bankName} onChange={(e) => setM({ ...m, bankName: e.target.value })} required />
        <TextInput label="Account number (NUBAN)" value={m.accountNumber} inputMode="numeric" maxLength={10} onChange={(e) => setM({ ...m, accountNumber: e.target.value.replace(/\D/g, '') })} required />
        <SelectInput label="Currency" value={m.currency} onChange={(e) => setM({ ...m, currency: e.target.value })} options={[{ value: 'NGN', label: 'NGN' }, { value: 'USD', label: 'USD' }, { value: 'GBP', label: 'GBP' }, { value: 'EUR', label: 'EUR' }]} />
        <div className="grid cols-2"><TextInput label="Period start" type="date" value={m.periodStart} onChange={(e) => setM({ ...m, periodStart: e.target.value })} required /><TextInput label="Period end" type="date" value={m.periodEnd} onChange={(e) => setM({ ...m, periodEnd: e.target.value })} required /></div>
        <div className="field"><label htmlFor="stmtfile">Statement file (CSV, XLSX or PDF)</label><input id="stmtfile" type="file" accept=".csv,.xlsx,.pdf" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></div>
        <ErrorAlert error={go.error} />
      </div>
    </Drawer>
  );
}

function TransactionsDrawer({ stmt, onClose, onChanged }: { stmt: any; onClose: () => void; onChanged: () => void }) {
  const [onlyUncertain, setOnly] = useState(stmt.uncertainCount > 0);
  const q = useQuery({ queryKey: ['txns', stmt.id, onlyUncertain], queryFn: () => api.get<any[]>(`/api/bank-statements/${stmt.id}/transactions?uncertainOnly=${onlyUncertain}`) });
  const [edit, setEdit] = useState<any>(null);
  return (
    <Drawer title={`${stmt.bankName} ${stmt.account} — transactions`} onClose={onClose}>
      <div className="stack">
        <label className="check"><input type="checkbox" checked={onlyUncertain} onChange={(e) => setOnly(e.target.checked)} /><span>Show only uncertain transactions</span></label>
        <QueryState q={q} empty={<Empty title="Nothing to show" />}>{() => (
          <div className="table-wrap"><table className="data"><thead><tr><th>Line</th><th>Date & description</th><th className="num">Debit / credit</th><th /></tr></thead>
            <tbody>{q.data!.map((t) => (
              <tr key={t.id}><td className="xs muted">{t.lineNo}</td><td className="small">{t.date ?? <em>unreadable</em>} · {t.description}<div className="xs muted">{humanize(t.category)}</div>{t.uncertain && <div className="xs" style={{ color: 'var(--warn-700)' }}>{t.uncertainReason}</div>}{t.correctedAt && <div className="xs muted">Corrected {dateTime(t.correctedAt)}</div>}</td>
                <td className="num small">{t.debitMinor ? `-${money(t.debitMinor, stmt.currency)}` : ''}{t.creditMinor ? money(t.creditMinor, stmt.currency) : ''}<div className="xs muted">bal {money(t.balanceMinor, stmt.currency)}</div></td>
                <td>{t.uncertain && <Button size="sm" onClick={() => setEdit(t)}>Correct</Button>}</td></tr>))}</tbody></table></div>)}</QueryState>
        {edit && <CorrectForm stmt={stmt} t={edit} onDone={async () => { setEdit(null); await q.refetch(); onChanged(); }} onCancel={() => setEdit(null)} />}
      </div>
    </Drawer>
  );
}

function CorrectForm({ stmt, t, onDone, onCancel }: { stmt: any; t: any; onDone: () => void; onCancel: () => void }) {
  const [v, setV] = useState({ txnDate: t.date ?? '', debit: t.debitMinor ? String(t.debitMinor / 100) : '', credit: t.creditMinor ? String(t.creditMinor / 100) : '', balance: t.balanceMinor !== null ? String(t.balanceMinor / 100) : '', reason: '' });
  const go = useAction(async () => {
    await api.patch(`/api/bank-transactions/${t.id}`, { txnDate: v.txnDate, debitMinor: toMinor(v.debit) ?? 0, creditMinor: toMinor(v.credit) ?? 0, balanceMinor: v.balance.trim() === '' ? null : Math.round(Number(v.balance.replace(/,/g, '')) * 100), reason: v.reason });
    onDone();
  });
  return (
    <Panel title={`Correct line ${t.lineNo}`} footer={<div className="row end"><Button onClick={onCancel}>Cancel</Button><Button variant="primary" disabled={!v.txnDate || v.reason.trim().length < 5} loading={go.loading} onClick={() => go.run()}>Save correction</Button></div>}>
      <div className="stack">
        <p className="small muted">The original description is kept. Verify against the source statement before correcting.</p>
        <TextInput label="Transaction date" type="date" value={v.txnDate} onChange={(e) => setV({ ...v, txnDate: e.target.value })} />
        <div className="grid cols-3"><TextInput label={`Debit (${stmt.currency})`} value={v.debit} onChange={(e) => setV({ ...v, debit: e.target.value })} /><TextInput label={`Credit (${stmt.currency})`} value={v.credit} onChange={(e) => setV({ ...v, credit: e.target.value })} /><TextInput label="Balance" value={v.balance} onChange={(e) => setV({ ...v, balance: e.target.value })} /></div>
        <TextArea label="Reason for correction" value={v.reason} onChange={(e) => setV({ ...v, reason: e.target.value })} required />
        <ErrorAlert error={go.error} />
      </div>
    </Panel>
  );
}
