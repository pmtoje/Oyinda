import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../../lib/api';
import { useAuth } from '../../../lib/auth';
import { date, dateTime, humanize, majorInput, money, pct, toMinor } from '../../../lib/format';
import { Alert, Button, Drawer, Empty, ErrorAlert, KV, MockTag, MoneyInput, Panel, SelectInput, Status, TextArea, TextInput, useAction } from '../../../components/ui';
import { QueryState, Section, useFac, useRefresh } from './common';

export function CreditTab({ id, customerId }: { id: string; customerId: string }) {
  const { can } = useAuth();
  const checks = useFac<any[]>(id, 'bureau', `/api/facilities/${id}/bureau-checks`);
  const exposure = useFac<any>(id, 'exposure', `/api/facilities/${id}/exposure`);
  const profile = useFac<any>(id, 'profile', `/api/customers/${customerId}/profile`);
  const refresh = useRefresh(id);
  const req = useAction(async (body: any) => { await api.post(`/api/facilities/${id}/bureau-checks`, body); await refresh(); });
  const compute = useAction(async () => { await api.post(`/api/facilities/${id}/exposure`); await refresh(); });
  const withBvn = (profile.data?.parties ?? []).filter((p: any) => p.bvnProvided);
  const e = exposure.data;
  return (
    <div className="stack">
      <Section title="Credit bureau" sub="Business checks use RC or TIN; individuals use BVN. Identifiers are masked on screen and in the record."
        actions={can('bureau.request') && <><Button size="sm" variant="primary" loading={req.loading} onClick={() => req.run({ subject: 'BUSINESS' })}>Check business</Button>{withBvn.map((p: any) => <Button key={p.id} size="sm" loading={req.loading} onClick={() => req.run({ subject: 'PARTY', partyId: p.id })}>Check {p.fullName.split(' ')[0]}</Button>)}</>}>
        <ErrorAlert error={req.error} />
        <Panel flush>
          <QueryState q={checks} empty={<Empty title="No bureau checks yet" />}>{() => (
            <div className="table-wrap"><table className="data"><thead><tr><th>Subject</th><th>Identifier</th><th>Provider</th><th>Result</th><th className="num">Outstanding</th><th>Requested</th></tr></thead>
              <tbody>{checks.data!.map((b) => (
                <tr key={b.id}><td className="primary-cell">{b.subjectName}<div className="xs muted">{humanize(b.subjectKind)}</div></td><td className="mono">{b.identifierType} {b.identifier}</td><td>{b.provider} <MockTag mode={b.mode} /></td>
                  <td>{b.status === 'COMPLETED' ? <>{b.delinquentFacilities > 0 ? <Status value="OVERDUE" label={`${b.delinquentFacilities} delinquent`} /> : <Status value="OK" label="No delinquency" />}<div className="xs muted">Score {b.score ?? '—'} · {b.totalFacilities ?? 0} facilities · {humanize(b.worstClassification)}</div></> : <Status value={b.status} />}</td>
                  <td className="num">{money(b.totalOutstandingMinor, 'NGN', { compact: true })}</td><td className="small">{dateTime(b.requestedAt)}{b.reportReference && <div className="xs muted mono">{b.reportReference}</div>}</td></tr>))}</tbody></table></div>)}</QueryState>
        </Panel>
      </Section>
      <Section title="Aggregate exposure & Single Obligor Limit" sub="Computed and enforced by the server from core banking and approved Gazelle pipeline."
        actions={can('exposure.compute') && <Button size="sm" variant="primary" onClick={() => compute.run()} loading={compute.loading}>{e ? 'Recompute' : 'Compute exposure'}</Button>}>
        <ErrorAlert error={compute.error} />
        <QueryState q={exposure} empty={<Panel><Empty title="Exposure not yet computed" /></Panel>}>{() => (
          <div className="stack">
            {e.warning ? <Alert tone="danger" title="Single Obligor Limit exceeded">{e.warning}</Alert> : <Alert tone="ok" title="Within Single Obligor Limit">Headroom {money(e.headroomMinor)} after this request.</Alert>}
            {e.sectorBreached && <Alert tone="warn">Sector exposure for {humanize(e.sector)} would exceed its configured limit of {money(e.sectorLimitMinor, 'NGN', { compact: true })}.</Alert>}
            <div className="grid cols-4">
              <div className="metric"><div className="label">Direct</div><div className="value">{money(e.directMinor, 'NGN', { compact: true })}</div></div>
              <div className="metric"><div className="label">Contingent (CCF {e.lines.ccfPct}%)</div><div className="value">{money(e.contingentMinor, 'NGN', { compact: true })}</div></div>
              <div className="metric"><div className="label">Related parties</div><div className="value">{money(e.groupMinor, 'NGN', { compact: true })}</div></div>
              <div className="metric"><div className="label">This request</div><div className="value">{money(e.proposedMinor, 'NGN', { compact: true })}</div></div>
            </div>
            <Panel title={<>Aggregate {money(e.aggregateMinor)} vs SOL {money(e.solLimitMinor)} <MockTag mode={e.sourceMode} /></>} flush actions={<span className="xs muted">Computed {dateTime(e.computedAt)}</span>}>
              <div className="table-wrap"><table className="data"><thead><tr><th>Reference</th><th>Product</th><th>Type</th><th>Source</th><th className="num">Outstanding</th></tr></thead>
                <tbody>{[...e.lines.own, ...e.lines.group, ...e.lines.pipeline].map((l: any, i: number) => <tr key={i}><td className="mono small">{l.reference}</td><td>{l.product}{l.relatedParty && <div className="xs muted">{l.relatedParty}</div>}</td><td>{humanize(l.kind)}</td><td className="small">{l.source}</td><td className="num">{money(l.outstandingMinor)}</td></tr>)}</tbody></table></div>
            </Panel>
          </div>)}</QueryState>
      </Section>
    </div>
  );
}

export function CollateralTab({ id, currency }: { id: string; currency: string }) {
  const { can } = useAuth();
  const q = useFac<any>(id, 'collateral', `/api/facilities/${id}/collateral`);
  const types = useQuery({ queryKey: ['collateral-types'], queryFn: () => api.get<any[]>('/api/collateral-types') });
  const [edit, setEdit] = useState<any>(null);
  const refresh = useRefresh(id);
  const del = useAction(async (cid: string) => { await api.del(`/api/facilities/${id}/collateral/${cid}`); await refresh(); });
  return (
    <Section title="Collateral & security" sub="Eligible value = market value less the policy haircut, converted to NGN at an approved FX rate." actions={can('collateral.edit') && <Button size="sm" variant="primary" onClick={() => setEdit({})}>Add collateral</Button>}>
      <QueryState q={q}>{() => (
        <div className="stack">
          <div className="grid cols-3">
            <div className={q.data.coveragePct < 100 && q.data.items.length ? 'metric alert' : 'metric'}><div className="label">Eligible cover</div><div className="value">{pct(q.data.coveragePct)}</div><div className="sub">of the facility amount</div></div>
            <div className="metric"><div className="label">Eligible value</div><div className="value">{money(q.data.eligibleNgnMinor, 'NGN', { compact: true })}</div></div>
            <div className="metric"><div className="label">Cash-backed</div><div className="value">{q.data.isCashBacked ? 'Yes' : 'No'}</div><div className="sub">Cash cover {pct(q.data.cashCoveragePct)}</div></div>
          </div>
          <ErrorAlert error={del.error} />
          <Panel flush>{!q.data.items.length ? <Empty title="No collateral recorded" /> : (
            <div className="table-wrap"><table className="data"><thead><tr><th>Type & description</th><th className="num">Market value</th><th className="num">Haircut</th><th className="num">Eligible (NGN)</th><th>Valuation</th><th>Perfection</th><th /></tr></thead>
              <tbody>{q.data.items.map((c: any) => (
                <tr key={c.id}><td className="primary-cell">{c.typeName}<div className="small">{c.description}</div><div className="xs muted">Owner: {c.ownerName}{!c.countsTowardsCoverage && ' · not counted towards cover'}</div></td>
                  <td className="num">{money(c.marketValueMinor, c.currency)}</td><td className="num">{c.haircutPct}%{c.haircutOverrideReason && <div className="xs muted" title={c.haircutOverrideReason}>override</div>}</td><td className="num">{money(c.eligibleValueNgnMinor)}</td>
                  <td className="small">{date(c.valuationDate)}{c.valuationSource && <div className="xs muted">{c.valuationSource}</div>}{c.valuationStale && <Status value="EXPIRED" label="Valuation stale" />}</td>
                  <td><Status value={c.perfectionStatus === 'PERFECTED' ? 'PERFECTED' : c.perfectionStatus === 'IN_PROGRESS' ? 'IN_PROGRESS' : 'PENDING'} label={humanize(c.perfectionStatus)} />{c.expiryDate && <div className="xs muted">Expires {date(c.expiryDate)}</div>}</td>
                  <td className="num">{can('collateral.edit') && <div className="row end" style={{ ['--gap' as any]: '6px' }}><Button size="sm" onClick={() => setEdit(c)}>Edit</Button><Button size="sm" variant="ghost" onClick={() => del.run(c.id)}>Remove</Button></div>}</td></tr>))}</tbody></table></div>)}</Panel>
        </div>)}</QueryState>
      {edit && <CollateralDrawer id={id} item={edit} types={types.data ?? []} defaultCcy={currency} onClose={() => setEdit(null)} onDone={async () => { setEdit(null); await refresh(); }} />}
    </Section>
  );
}

function CollateralDrawer({ id, item, types, defaultCcy, onClose, onDone }: { id: string; item: any; types: any[]; defaultCcy: string; onClose: () => void; onDone: () => void }) {
  const [v, setV] = useState({ typeKey: item.typeKey ?? '', ownerName: item.ownerName ?? '', description: item.description ?? '', currency: item.currency ?? defaultCcy, market: majorInput(item.marketValueMinor), valuationDate: item.valuationDate ?? '', valuationSource: item.valuationSource ?? '', haircut: item.haircutPct !== undefined ? String(item.haircutPct) : '', reason: item.haircutOverrideReason ?? '', expiryDate: item.expiryDate ?? '', perfectionStatus: item.perfectionStatus ?? 'NOT_STARTED' });
  const t = types.find((x) => x.key === v.typeKey);
  useEffect(() => { if (t && !item.id) setV((p) => ({ ...p, haircut: String(t.defaultHaircutPct) })); }, [v.typeKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const override = t && v.haircut !== '' && Number(v.haircut) < t.defaultHaircutPct;
  const market = toMinor(v.market);
  const save = useAction(async () => {
    const body = { typeKey: v.typeKey, ownerName: v.ownerName, description: v.description, currency: v.currency, marketValueMinor: market ?? 0, valuationDate: v.valuationDate || null, valuationSource: v.valuationSource || null, haircutPct: v.haircut === '' ? undefined : Number(v.haircut), haircutOverrideReason: override ? v.reason : undefined, expiryDate: v.expiryDate || null, perfectionStatus: v.perfectionStatus };
    if (item.id) await api.put(`/api/facilities/${id}/collateral/${item.id}`, body); else await api.post(`/api/facilities/${id}/collateral`, body);
    onDone();
  });
  return (
    <Drawer title={item.id ? 'Edit collateral' : 'Add collateral'} onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={save.loading} disabled={!v.typeKey || !market} onClick={() => save.run()}>Save</Button></>}>
      <div className="stack">
        <SelectInput label="Collateral type" value={v.typeKey} onChange={(e) => setV({ ...v, typeKey: e.target.value })} placeholder="Select type" options={types.map((x) => ({ value: x.key, label: x.name }))} required />
        {t && <div className="small muted">Policy haircut {t.defaultHaircutPct}%{t.requiresValuation ? ` · valuation required${t.valuationValidityMonths ? `, valid ${t.valuationValidityMonths} months` : ''}` : ''}{t.requiresPerfection ? ' · perfection required' : ''}{t.cashEquivalent ? ' · cash-equivalent' : ''}{!t.countsTowardsCoverage ? ' · does not count towards cover' : ''}</div>}
        <TextInput label="Owner" value={v.ownerName} onChange={(e) => setV({ ...v, ownerName: e.target.value })} required />
        <TextArea label="Description" value={v.description} onChange={(e) => setV({ ...v, description: e.target.value })} required />
        <div className="grid cols-2"><SelectInput label="Currency" value={v.currency} onChange={(e) => setV({ ...v, currency: e.target.value })} options={['NGN', 'USD'].map((c) => ({ value: c, label: c }))} /><MoneyInput label="Market value" currency={v.currency} value={v.market} onChange={(e) => setV({ ...v, market: e.target.value })} required /></div>
        <div className="grid cols-2"><TextInput label="Valuation date" type="date" value={v.valuationDate} onChange={(e) => setV({ ...v, valuationDate: e.target.value })} required={t?.requiresValuation} /><TextInput label="Valuer / source" value={v.valuationSource} onChange={(e) => setV({ ...v, valuationSource: e.target.value })} required={t?.requiresValuation} /></div>
        <div className="grid cols-2"><TextInput label="Haircut %" type="number" min={0} max={100} value={v.haircut} onChange={(e) => setV({ ...v, haircut: e.target.value })} /><TextInput label="Expiry date" type="date" value={v.expiryDate} onChange={(e) => setV({ ...v, expiryDate: e.target.value })} /></div>
        {override && <TextArea label="Justification for reducing the haircut" value={v.reason} onChange={(e) => setV({ ...v, reason: e.target.value })} required hint="Recorded in the audit trail and shown in the credit memo." />}
        <SelectInput label="Perfection status" value={v.perfectionStatus} onChange={(e) => setV({ ...v, perfectionStatus: e.target.value })} options={['NOT_STARTED', 'IN_PROGRESS', 'PERFECTED', 'NOT_REQUIRED'].map((s) => ({ value: s, label: humanize(s) }))} />
        {market && v.haircut !== '' && <Alert tone="info">Eligible value: {money(Math.round(market * (1 - Number(v.haircut) / 100)), v.currency)}{v.currency !== 'NGN' ? ' before conversion to NGN' : ''}.</Alert>}
        <ErrorAlert error={save.error} />
      </div>
    </Drawer>
  );
}

export function RiskTab({ id }: { id: string }) {
  const { can } = useAuth();
  const q = useFac<any>(id, 'risk', `/api/facilities/${id}/risk`);
  const [card, setCard] = useState<any>(null);
  const refresh = useRefresh(id);
  const frr = useAction(async () => { await api.post(`/api/facilities/${id}/risk-frr`); await refresh(); });
  const combined = useAction(async () => { await api.post(`/api/facilities/${id}/risk-combined`); await refresh(); });
  return (
    <QueryState q={q}>{() => {
      const by = (k: string) => q.data.assessments.find((a: any) => a.kind === k && a.status === 'SUBMITTED');
      const draft = (k: string) => q.data.assessments.find((a: any) => a.kind === k && a.status === 'DRAFT');
      const comb = by('COMBINED');
      return (
        <div className="stack">
          <div className="grid cols-4">
            {['ORR', 'FRR', 'INDUSTRY', 'COLLATERAL'].map((k) => { const a = by(k); return (
              <div key={k} className="metric"><div className="label">{k === 'ORR' ? 'Obligor (ORR)' : k === 'FRR' ? 'Financial (FRR)' : humanize(k)}</div><div className="value">{a ? a.grade : '—'}</div><div className="sub">{a ? `Score ${a.score} · ${a.scorecard} v${a.scorecardVersion}` : draft(k) ? 'Draft saved' : 'Not submitted'}</div></div>); })}
          </div>
          <Panel title="Combined rating" actions={can('risk.assess') && <><Button size="sm" onClick={() => frr.run()} loading={frr.loading}>Rate FRR from analysis</Button><Button size="sm" variant="primary" onClick={() => combined.run()} loading={combined.loading}>Compute combined</Button></>}>
            <ErrorAlert error={frr.error ?? combined.error} />
            {comb ? (
              <div className="row" style={{ ['--gap' as any]: '24px' }}>
                <div><div className="xs muted">GRADE</div><div style={{ fontSize: '2rem', fontFamily: 'var(--font-serif)' }}>{comb.grade}</div></div>
                <div className="grow"><div>{comb.gradeDescription}</div><div className="small muted">Score {comb.score} · model v{comb.scorecardVersion} · {comb.assessedBy} · {dateTime(comb.submittedAt)}</div>
                  <div className="small">{(comb.breakdown ?? []).map((c: any) => `${c.kind} ${c.score ?? '—'} × ${c.weight}%`).join(' · ')}</div></div>
              </div>) : <p className="muted small">Submit ORR, FRR, industry and collateral assessments, then compute the combined rating. Each assessment keeps the exact scorecard version used.</p>}
          </Panel>
          <Panel title="Scorecards" flush>
            <table className="data"><thead><tr><th>Scorecard</th><th>Version</th><th>Latest</th><th /></tr></thead>
              <tbody>{q.data.scorecards.map((s: any) => { const a = by(s.kind) ?? draft(s.kind); return (
                <tr key={s.configId}><td className="primary-cell">{s.name}<div className="xs muted">{s.sections.length} {s.sections.length === 1 ? "section" : "sections"}</div></td><td>v{s.version}</td><td>{a ? <><Status value={a.status} /> {a.grade} ({a.score})</> : '—'}</td>
                  <td className="num">{can('risk.assess') && <Button size="sm" onClick={() => setCard(s)}>{a ? 'Reassess' : 'Assess'}</Button>}</td></tr>); })}</tbody></table>
          </Panel>
          {card && <ScorecardDrawer id={id} card={card} prior={draft(card.kind) ?? by(card.kind)} suggestion={q.data.suggestions} onClose={() => setCard(null)} onDone={async () => { setCard(null); await refresh(); }} />}
        </div>
      );
    }}</QueryState>
  );
}

function ScorecardDrawer({ id, card, prior, suggestion, onClose, onDone }: { id: string; card: any; prior?: any; suggestion: any; onClose: () => void; onDone: () => void }) {
  const [answers, setAnswers] = useState<Record<string, string>>(() => ({ ...(prior?.scorecardConfigId === card.configId ? prior.inputs : {}), ...(card.kind === 'COLLATERAL' && !prior ? { COVERAGE: suggestion.COVERAGE } : {}) }));
  const total = card.sections.reduce((n: number, s: any) => n + s.questions.length, 0);
  const answered = Object.keys(answers).length;
  const save = useAction(async (submit: boolean) => { await api.post(`/api/facilities/${id}/risk/${card.kind}`, { scorecardConfigId: card.configId, answers, submit }); onDone(); });
  return (
    <Drawer title={`${card.name} (v${card.version})`} onClose={onClose} footer={<><span className="small muted grow">{answered} of {total} answered</span><Button onClick={() => save.run(false)} loading={save.loading}>Save draft</Button><Button variant="primary" disabled={answered < total} onClick={() => save.run(true)} loading={save.loading}>Submit</Button></>}>
      <div className="stack">
        {card.sections.map((s: any) => (
          <fieldset key={s.code} className="panel" style={{ padding: 14, margin: 0 }}>
            <legend className="small" style={{ fontWeight: 600, padding: '0 4px' }}>{s.name} · weight {s.weight}%</legend>
            <div className="stack" style={{ ['--gap' as any]: '12px' }}>
              {s.questions.map((qq: any) => (
                <div key={qq.code} role="radiogroup" aria-label={qq.text}>
                  <div className="small" style={{ fontWeight: 500 }}>{qq.text}</div>
                  {qq.guidance && <div className="xs muted">{qq.guidance}{qq.code === 'COVERAGE' && ` System coverage: ${pct(suggestion.coveragePct)}.`}</div>}
                  <div className="stack" style={{ ['--gap' as any]: '4px', marginTop: 4 }}>
                    {qq.options.map((o: any) => <label key={o.code} className="check"><input type="radio" name={qq.code} checked={answers[qq.code] === o.code} onChange={() => setAnswers({ ...answers, [qq.code]: o.code })} /><span>{o.label} <span className="xs muted">({o.score})</span></span></label>)}
                  </div>
                </div>))}
            </div>
          </fieldset>))}
        <ErrorAlert error={save.error} />
      </div>
    </Drawer>
  );
}

export function PricingTab({ id, product }: { id: string; product: any }) {
  const { can } = useAuth();
  const q = useFac<any[]>(id, 'rarorac', `/api/facilities/${id}/rarorac`);
  const [rate, setRate] = useState(String(product.indicativeProfitRatePct ?? ''));
  const [fee, setFee] = useState('1');
  const [just, setJust] = useState('');
  const refresh = useRefresh(id);
  const compute = useAction(async () => { await api.post(`/api/facilities/${id}/rarorac`, { proposedProfitRatePct: Number(rate), managementFeePct: Number(fee) }); await refresh(); });
  const justify = useAction(async (rid: string) => { await api.post(`/api/rarorac/${rid}/justify`, { justification: just }); setJust(''); await refresh(); });
  const latest = q.data?.[0];
  return (
    <div className="stack">
      <Panel title="Pricing & RARORAC" actions={<span className="xs muted">Pricing basis: {humanize(product.pricingBasis)}</span>}>
        {can('rarorac.compute') && (
          <div className="row" style={{ alignItems: 'flex-end' }}>
            <div style={{ width: 200 }}><TextInput label="Proposed profit rate (% p.a.)" type="number" step="0.01" value={rate} onChange={(e) => setRate(e.target.value)} /></div>
            <div style={{ width: 180 }}><TextInput label="Management fee (%)" type="number" step="0.01" value={fee} onChange={(e) => setFee(e.target.value)} /></div>
            <Button variant="primary" onClick={() => compute.run()} loading={compute.loading} disabled={!rate}>Compute RARORAC</Button>
          </div>)}
        <ErrorAlert error={compute.error} />
      </Panel>
      <QueryState q={q} empty={<Panel><Empty title="No RARORAC computation yet">Submit the combined risk rating first.</Empty></Panel>}>{() => (
        <>
          {latest.mode === 'MOCK' && <Alert tone="warn" title="Development pricing adapter">{latest.notes?.[0] ?? 'This is a MOCK computation and is not a production RARORAC result.'}</Alert>}
          <div className="grid cols-4">
            <div className={latest.withinThreshold ? 'metric' : 'metric alert'}><div className="label">RARORAC <MockTag mode={latest.mode} /></div><div className="value">{pct(latest.raroracPct, 2)}</div><div className="sub">Hurdle {pct(latest.hurdlePct, 2)}</div></div>
            <div className="metric"><div className="label">Proposed rate</div><div className="value">{pct(latest.proposedProfitRatePct, 2)}</div></div>
            <div className="metric"><div className="label">Recommended rate</div><div className="value">{pct(latest.recommendedProfitRatePct, 2)}</div></div>
            <div className="metric"><div className="label">Threshold</div><div className="value">{latest.withinThreshold ? 'Within' : 'Exception'}</div><div className="sub">{latest.provider}</div></div>
          </div>
          {latest.exceptionRequired && (
            <Panel title="Pricing exception">
              {latest.justification ? <p><strong>Justified by {latest.justifiedBy}:</strong> {latest.justification}</p> : can('rarorac.justify') ? (
                <div className="stack"><Alert tone="warn">Pricing is outside the configured threshold. A written justification is required, and the approval route will escalate to at least the configured authority.</Alert>
                  <TextArea label="Justification" value={just} onChange={(e) => setJust(e.target.value)} /><div><Button variant="primary" onClick={() => justify.run(latest.id)} loading={justify.loading}>Record justification</Button></div><ErrorAlert error={justify.error} /></div>) : <p className="muted">Awaiting justification by an authorised officer.</p>}
            </Panel>)}
          <Panel title="History" flush><table className="data"><thead><tr><th>Computed</th><th className="num">Rate</th><th className="num">RARORAC</th><th>Result</th></tr></thead><tbody>{q.data!.map((r) => <tr key={r.id}><td className="small">{dateTime(r.computedAt)} <MockTag mode={r.mode} /></td><td className="num">{pct(r.proposedProfitRatePct, 2)}</td><td className="num">{pct(r.raroracPct, 2)}</td><td>{r.status === 'COMPLETED' ? <Status value={r.withinThreshold ? 'OK' : 'WARNING'} label={r.withinThreshold ? 'Within threshold' : 'Exception'} /> : <Status value="FAILED" />}</td></tr>)}</tbody></table></Panel>
        </>)}</QueryState>
    </div>
  );
}

export function EsTab({ id }: { id: string }) {
  const { can } = useAuth();
  const q = useFac<any>(id, 'es', `/api/facilities/${id}/es`);
  const [answers, setAnswers] = useState<Record<string, string> | null>(null);
  const [findings, setFindings] = useState(''); const [rec, setRec] = useState(''); const [conds, setConds] = useState('');
  const refresh = useRefresh(id);
  const a = q.data?.assessment;
  useEffect(() => { if (a && answers === null) { setAnswers(a.answers ?? {}); setFindings(a.findings ?? ''); setRec(a.recommendation ?? ''); setConds((a.conditions ?? []).join('\n')); } }, [a]); // eslint-disable-line react-hooks/exhaustive-deps
  const save = useAction(async (submit: boolean) => { await api.put(`/api/facilities/${id}/es`, { answers: answers ?? {}, findings: findings || undefined, recommendation: rec || undefined, conditions: conds.split('\n').map((c) => c.trim()).filter(Boolean), submit }); await refresh(); });
  return (
    <QueryState q={q}>{() => {
      const t = q.data.trigger;
      if (!q.data.required && !a) return <Panel title="Environmental & social"><Empty title="E&S review not required">{t?.description}</Empty></Panel>;
      const done = a?.status === 'SUBMITTED';
      const analyst = can('es.assess');
      const editable = (analyst || can('es.checklist')) && !done;
      const score = t ? t.questionnaire.reduce((n: number, qq: any) => n + (qq.options.find((o: any) => o.code === answers?.[qq.code])?.weight ?? 0), 0) : 0;
      return (
        <div className="stack">
          <Alert tone="info" title="E&S review required">{t?.description} Trigger v{t?.version}. {(a?.triggerReasons ?? []).join('; ')}</Alert>
          {!analyst && editable && <Alert tone="warn" title="Next step: complete the E&S checklist">Complete the E&S risk checklist with the customer and save it. The E&S risk analyst reviews it concurrently with credit analysis, then records findings and submits.</Alert>}
          <div className="grid cols-3">
            <div className="metric"><div className="label">Category</div><div className="value">{a?.category ?? '—'}</div><div className="sub">A ≥ {t?.thresholds.A}, B ≥ {t?.thresholds.B}; score {score}</div></div>
            <div className="metric"><div className="label">Recommendation</div><div className="value" style={{ fontSize: '1rem' }}>{humanize(a?.recommendation)}</div></div>
            <div className="metric"><div className="label">Status</div><div className="value" style={{ fontSize: '1rem' }}><Status value={a?.status} /></div><div className="sub">{done && dateTime(a.submittedAt)}</div></div>
          </div>
          <Panel title="E&S risk checklist (IFC Performance Standards)" footer={editable && <div className="row end"><Button variant={analyst ? undefined : 'primary'} onClick={() => save.run(false)} loading={save.loading}>{analyst ? 'Save' : 'Save checklist'}</Button>{analyst && <Button variant="primary" onClick={() => save.run(true)} loading={save.loading}>Submit assessment</Button>}</div>}>
            <div className="stack">
              {t?.questionnaire.map((qq: any) => (
                <div key={qq.code} role="radiogroup" aria-label={qq.text}><div className="small" style={{ fontWeight: 500 }}>{qq.text}</div>
                  <div className="row" style={{ marginTop: 4 }}>{qq.options.map((o: any) => <label key={o.code} className="check"><input type="radio" disabled={!editable} name={`es-${qq.code}`} checked={answers?.[qq.code] === o.code} onChange={() => setAnswers({ ...(answers ?? {}), [qq.code]: o.code })} /><span>{o.label}</span></label>)}</div></div>))}
              <TextArea label="Findings" value={findings} disabled={!editable || !analyst} onChange={(e) => setFindings(e.target.value)} />
              <SelectInput label="Recommendation" value={rec} disabled={!editable || !analyst} onChange={(e) => setRec(e.target.value)} placeholder="Select" options={['PROCEED', 'PROCEED_WITH_CONDITIONS', 'DO_NOT_PROCEED'].map((r) => ({ value: r, label: humanize(r) }))} />
              <TextArea label="E&S conditions (one per line)" value={conds} disabled={!editable || !analyst} onChange={(e) => setConds(e.target.value)} />
              <ErrorAlert error={save.error} />
            </div>
          </Panel>
          {void KV}
        </div>
      );
    }}</QueryState>
  );
}
