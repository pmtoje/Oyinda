import { useEffect, useState, type ReactElement } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../../lib/api';
import { Button, Check, SelectInput, TextArea, TextInput } from '../../../components/ui';
import { money } from '../../../lib/format';
import { ConditionBuilder, ConditionPreview, ListInput, NairaField, NumberField, Section, useRoles, type Condition } from './common';

type P = { value: any; onChange: (v: any) => void };
const upd = (arr: any[], i: number, patch: any) => arr.map((x, j) => (j === i ? { ...x, ...patch } : x));
const del = (arr: any[], i: number) => arr.filter((_, j) => j !== i);

function RoleSelect({ label, value, onChange, allowEmpty }: { label: string; value?: string; onChange: (v: string | undefined) => void; allowEmpty?: boolean }) {
  const roles = useRoles();
  const opts = (roles.data ?? []).map((r) => ({ value: r.code, label: `${r.name} (${r.code})` }));
  if (value && !opts.some((o) => o.value === value)) opts.unshift({ value, label: value });
  return <SelectInput label={label} value={value ?? ''} placeholder={allowEmpty ? '—' : undefined} options={opts} onChange={(e) => onChange(e.target.value || undefined)} />;
}

export function AuthorityEditor({ value, onChange }: P) {
  const levels: any[] = value.levels ?? [];
  const overrides: any[] = value.overrides ?? [];
  const set = (patch: any) => onChange({ ...value, ...patch });
  return (
    <>
      <Section title="Approval levels" intro="Ordered from lowest to highest authority. A level joins the chain when the authority amount is above its “joins above” amount; the first level that may be final and whose limit covers the amount approves, and the levels before it recommend.">
        {levels.map((l, i) => {
          const u = (patch: any) => set({ levels: upd(levels, i, patch) });
          const summary = [l.participatesAboveMinor ? `joins above ${money(l.participatesAboveMinor, 'NGN', { compact: true })}` : 'always takes part', l.canBeFinal === false ? 'concurs only' : `final up to ${money(l.limitMinor, 'NGN', { compact: true })}`, l.overrideOnly ? 'reached only by an override' : null].filter(Boolean).join(' · ');
          return (
            <div className="level-card" key={i}>
              <div className="level-head"><span className="level-no">{i + 1}</span><span className="level-title">{l.name || l.code}</span><span className="level-summary">{summary}</span><span className="grow" /><Button size="sm" variant="ghost" onClick={() => set({ levels: del(levels, i) })}>Remove</Button></div>
              <div className="level-grid">
                <TextInput label="Code" value={l.code} onChange={(e) => u({ code: e.target.value.toUpperCase() })} />
                <div className="span-2"><TextArea label="Name" rows={1} className="textarea autosize" value={l.name} onChange={(e) => u({ name: e.target.value })} /></div>
                <SelectInput label="Type" value={l.kind} options={[{ value: 'INDIVIDUAL', label: 'Individual' }, { value: 'COMMITTEE', label: 'Committee' }]} onChange={(e) => u({ kind: e.target.value })} />
                {l.kind === 'COMMITTEE'
                  ? <TextInput label="Committee key" value={l.committeeKey ?? ''} onChange={(e) => u({ committeeKey: e.target.value.toUpperCase(), role: undefined })} />
                  : <RoleSelect label="Role" value={l.role} onChange={(v) => u({ role: v, committeeKey: undefined })} />}
                <NairaField label="Final authority up to" minor={l.limitMinor} onChange={(m) => u({ limitMinor: m ?? 0 })} hint={money(l.limitMinor, 'NGN', { compact: true })} />
                <NairaField label="Joins the chain above" minor={l.participatesAboveMinor} onChange={(m) => u({ participatesAboveMinor: m })} hint="Empty = always takes part" />
                <NairaField label="Cash-backed limit (optional)" minor={l.cashBackedLimitMinor} onChange={(m) => u({ cashBackedLimitMinor: m })} />
                <TextInput label="SLA policy" value={l.slaPolicyKey} onChange={(e) => u({ slaPolicyKey: e.target.value })} />
              </div>
              <div className="row" style={{ marginTop: 10 }}>
                <Check label="Can hold final authority" checked={l.canBeFinal !== false} onChange={(e) => u({ canBeFinal: e.target.checked })} />
                <Check label="Reached only through an override (e.g. insider, PEP)" checked={!!l.overrideOnly} onChange={(e) => u({ overrideOnly: e.target.checked })} />
              </div>
            </div>
          );
        })}
        <div><Button size="sm" onClick={() => set({ levels: [...levels, { code: 'NEW_LEVEL', name: 'New level', kind: 'INDIVIDUAL', role: 'MD', limitMinor: 0, slaPolicyKey: 'APPROVAL_INDIVIDUAL', alwaysReview: false, canBeFinal: true, overrideOnly: false }] })}>Add level</Button></div>
      </Section>
      <Section title="Routing overrides" intro="Special workflows (insider, PEP, SOL breach, pricing exception). A final level forces that authority; a minimum raises the final level when it is lower.">
        {overrides.map((o, i) => (
          <div key={i} className="panel auto-grid-host" style={{ padding: 12 }}>
            <div className="auto-grid">
              <TextInput label="Code" value={o.code} onChange={(e) => set({ overrides: upd(overrides, i, { code: e.target.value.toUpperCase() }) })} />
              <SelectInput label="Final level (forced)" value={o.finalLevel ?? ''} placeholder="—" options={levels.map((l) => ({ value: l.code, label: l.name }))} onChange={(e) => set({ overrides: upd(overrides, i, { finalLevel: e.target.value || undefined }) })} />
              <SelectInput label="Minimum final level" value={o.minimumFinalLevel ?? ''} placeholder="—" options={levels.map((l) => ({ value: l.code, label: l.name }))} onChange={(e) => set({ overrides: upd(overrides, i, { minimumFinalLevel: e.target.value || undefined }) })} />
            </div>
            <TextArea label="Reason (shown in the route explanation)" rows={2} value={o.reason} onChange={(e) => set({ overrides: upd(overrides, i, { reason: e.target.value }) })} />
            <Check label="Every level up to the final level takes part (full chain, regardless of amount)" checked={!!o.fullChain} onChange={(e) => set({ overrides: upd(overrides, i, { fullChain: e.target.checked }) })} />
            <div className="label small" style={{ margin: '8px 0 4px' }}>Applies when</div>
            <ConditionBuilder value={o.when ?? { always: true }} onChange={(c) => set({ overrides: upd(overrides, i, { when: c }) })} />
            <div className="row end" style={{ marginTop: 8 }}><Button size="sm" variant="danger" onClick={() => set({ overrides: del(overrides, i) })}>Remove override</Button></div>
          </div>
        ))}
        <div><Button size="sm" onClick={() => set({ overrides: [...overrides, { code: 'NEW_OVERRIDE', reason: 'Describe the policy basis.', when: { fact: 'customer.isPep', op: 'truthy' }, minimumFinalLevel: levels.at(-1)?.code }] })}>Add override</Button></div>
      </Section>
    </>
  );
}

export function SlaEditor({ value, onChange }: P) {
  const esc: any[] = value.escalations ?? [];
  const set = (patch: any) => onChange({ ...value, ...patch });
  return (
    <>
      <Section title="Service level" intro="Business calendars exclude weekends, out-of-hours and public holidays configured in the business calendar.">
        <div className="grid cols-3">
          <NumberField label="Duration (hours)" required value={value.durationHours} min={0.5} onChange={(v) => set({ durationHours: v })} />
          <SelectInput label="Calendar" value={value.calendar} options={[{ value: 'BUSINESS', label: 'Business hours' }, { value: 'CALENDAR', label: 'Calendar hours' }]} onChange={(e) => set({ calendar: e.target.value })} />
          <NumberField label="Warning at (% of duration)" value={value.warnAtPct} min={1} max={99} onChange={(v) => set({ warnAtPct: v })} />
        </div>
        <Check label="Pause the SLA clock while waiting for a customer clarification" checked={!!value.pauseOnClarification} onChange={(e) => set({ pauseOnClarification: e.target.checked })} />
      </Section>
      <Section title="Escalations" intro="Notified in order once the task has been in breach for the stated number of hours.">
        <div className="table-wrap"><table className="data"><thead><tr><th>Label</th><th>Hours after breach</th><th>Notify roles</th><th /></tr></thead>
          <tbody>{esc.map((e, i) => <tr key={i}>
            <td><input className="input" aria-label="Escalation label" value={e.label} onChange={(x) => set({ escalations: upd(esc, i, { label: x.target.value }) })} /></td>
            <td><input className="input" aria-label="Hours after breach" type="number" min={0} value={e.afterBreachHours} onChange={(x) => set({ escalations: upd(esc, i, { afterBreachHours: Number(x.target.value) }) })} /></td>
            <td><input className="input" aria-label="Roles (comma-separated)" value={(e.notifyRoles ?? []).join(', ')} onChange={(x) => set({ escalations: upd(esc, i, { notifyRoles: x.target.value.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean) }) })} /></td>
            <td><Button size="sm" variant="ghost" onClick={() => set({ escalations: del(esc, i) })}>Remove</Button></td></tr>)}</tbody></table></div>
        <div><Button size="sm" onClick={() => set({ escalations: [...esc, { afterBreachHours: 24, notifyRoles: ['CRO'], label: 'Escalation' }] })}>Add escalation</Button></div>
      </Section>
    </>
  );
}

export function FipgEditor({ value, onChange }: P) {
  const set = (patch: any) => onChange({ ...value, ...patch });
  return (
    <>
      <Section title="Rule" intro="Eligibility rules are evaluated on submission and by credit staff. Customers see only the customer message.">
        <div className="grid cols-2">
          <TextInput label="Rule code" value={value.code} onChange={(e) => set({ code: e.target.value.toUpperCase() })} />
          <TextInput label="Required value (plain language)" value={value.requiredValue} onChange={(e) => set({ requiredValue: e.target.value })} />
        </div>
        <TextInput label="Description" value={value.description} onChange={(e) => set({ description: e.target.value })} />
        <div className="grid cols-3">
          <SelectInput label="Severity" value={value.severity} options={['BLOCKER', 'MAJOR', 'MINOR'].map((v) => ({ value: v, label: v }))} onChange={(e) => set({ severity: e.target.value })} />
          <SelectInput label="Action on failure" value={value.action} options={[{ value: 'DECLINE', label: 'Decline' }, { value: 'REFER', label: 'Refer for review' }, { value: 'EXCEPTION', label: 'Exception required' }, { value: 'WARN', label: 'Warn only' }]} onChange={(e) => set({ action: e.target.value })} />
          <div style={{ paddingTop: 26 }}><Check label="Exception allowed" checked={!!value.exceptionAllowed} onChange={(e) => set({ exceptionAllowed: e.target.checked })} /></div>
        </div>
        <TextArea label="Customer message" hint="Customer-safe: never reveal thresholds or internal policy." rows={2} value={value.customerMessage} onChange={(e) => set({ customerMessage: e.target.value })} />
        <TextArea label="Internal explanation" rows={2} value={value.internalMessage} onChange={(e) => set({ internalMessage: e.target.value })} />
      </Section>
      <Section title="Scope" intro="Leave a list empty to apply to all.">
        <div className="grid cols-3">
          <ListInput label="Customer types" value={value.customerTypes ?? []} onChange={(v) => set({ customerTypes: v })} placeholder="CORPORATE, SME" />
          <ListInput label="Product codes" value={value.productCodes ?? []} onChange={(v) => set({ productCodes: v })} placeholder="MURABAHA" />
          <ListInput label="Sector codes" value={value.sectorCodes ?? []} onChange={(v) => set({ sectorCodes: v })} placeholder="OIL_GAS" />
        </div>
      </Section>
      <Section title="Applies when"><ConditionBuilder label="Applies when" value={value.appliesWhen ?? { always: true }} onChange={(c) => set({ appliesWhen: c })} /></Section>
      <Section title="Passes when"><ConditionBuilder label="Passes when" value={value.passWhen ?? { always: true }} onChange={(c) => set({ passWhen: c })} /><ConditionPreview condition={value.passWhen} /></Section>
    </>
  );
}

export function RatioEditor({ value, onChange }: P) {
  const bands: any[] = value.bands ?? [];
  const set = (patch: any) => onChange({ ...value, ...patch });
  const num = (s: string) => (s.trim() === '' ? undefined : Number(s));
  return (
    <>
      <Section title="Formula" intro="Use line-item codes (e.g. CURRENT_ASSETS), PREV.CODE for the prior period, + − × ÷ ^ and abs/min/max/avg. Flows in partial-year statements are annualised.">
        <div className="grid cols-2"><TextInput label="Code" value={value.code} onChange={(e) => set({ code: e.target.value.toUpperCase() })} /><TextInput label="Name" value={value.name} onChange={(e) => set({ name: e.target.value })} /></div>
        <TextInput label="Formula" className="input mono" value={value.formula} onChange={(e) => set({ formula: e.target.value })} />
        <div className="grid cols-4">
          <SelectInput label="Unit" value={value.unit} options={['x', '%', 'days', 'NGN'].map((v) => ({ value: v, label: v }))} onChange={(e) => set({ unit: e.target.value })} />
          <SelectInput label="Category" value={value.category} options={['PROFITABILITY', 'LIQUIDITY', 'LEVERAGE', 'COVERAGE', 'EFFICIENCY', 'GROWTH'].map((v) => ({ value: v, label: v.toLowerCase() }))} onChange={(e) => set({ category: e.target.value })} />
          <SelectInput label="Direction" value={value.direction} options={[{ value: 'HIGHER_BETTER', label: 'Higher is better' }, { value: 'LOWER_BETTER', label: 'Lower is better' }]} onChange={(e) => set({ direction: e.target.value })} />
          <NumberField label="Weight" value={value.weight} min={0} max={100} onChange={(v) => set({ weight: v ?? 0 })} />
        </div>
        <ListInput label="Applicable sectors" hint="Empty = all sectors" value={value.sectors ?? []} onChange={(v) => set({ sectors: v })} />
      </Section>
      <Section title="Bands & scores" intro="Lower bound inclusive, upper bound exclusive. Scores are 0–10.">
        <div className="table-wrap"><table className="data"><thead><tr><th>From</th><th>To</th><th>Score</th><th>Label</th><th>Risk implication</th><th /></tr></thead>
          <tbody>{bands.map((b, i) => <tr key={i}>
            <td><input className="input" aria-label="From" value={b.min ?? ''} onChange={(e) => set({ bands: upd(bands, i, { min: num(e.target.value) }) })} /></td>
            <td><input className="input" aria-label="To" value={b.max ?? ''} onChange={(e) => set({ bands: upd(bands, i, { max: num(e.target.value) }) })} /></td>
            <td><input className="input" aria-label="Score" type="number" value={b.score} onChange={(e) => set({ bands: upd(bands, i, { score: Number(e.target.value) }) })} /></td>
            <td><input className="input" aria-label="Label" value={b.label} onChange={(e) => set({ bands: upd(bands, i, { label: e.target.value }) })} /></td>
            <td><input className="input" aria-label="Implication" value={b.implication} onChange={(e) => set({ bands: upd(bands, i, { implication: e.target.value }) })} /></td>
            <td><Button size="sm" variant="ghost" onClick={() => set({ bands: del(bands, i) })}>Remove</Button></td></tr>)}</tbody></table></div>
        <div><Button size="sm" onClick={() => set({ bands: [...bands, { score: 5, label: 'Band', implication: 'Describe the implication.' }] })}>Add band</Button></div>
      </Section>
    </>
  );
}

export function CommitteeEditor({ value, onChange }: P) {
  const set = (patch: any) => onChange({ ...value, ...patch });
  return (
    <Section title="Committee" intro="Approval needs the quorum, the required number of approvals and an approval from every required role.">
      <div className="grid cols-2"><TextInput label="Code" value={value.code} onChange={(e) => set({ code: e.target.value.toUpperCase() })} /><TextInput label="Name" value={value.name} onChange={(e) => set({ name: e.target.value })} /></div>
      <ListInput label="Member roles" hint="Users holding any of these roles are members" value={value.memberRoles ?? []} onChange={(v) => set({ memberRoles: v.map((x) => x.toUpperCase()) })} />
      <div className="grid cols-3">
        <NumberField label="Quorum (votes cast)" value={value.quorum} min={1} onChange={(v) => set({ quorum: v })} />
        <NumberField label="Required approvals" value={value.requiredApprovals} min={1} onChange={(v) => set({ requiredApprovals: v })} />
        <SelectInput label="Voting" value={value.voting} options={[{ value: 'PARALLEL', label: 'Parallel (any order)' }, { value: 'SERIAL', label: 'Serial (role order)' }]} onChange={(e) => set({ voting: e.target.value })} />
      </div>
      <ListInput label="Required roles (must approve)" value={value.requiredRoles ?? []} onChange={(v) => set({ requiredRoles: v.map((x) => x.toUpperCase()) })} />
      {value.voting === 'SERIAL' && <ListInput label="Serial order (roles)" value={value.serialOrder ?? []} onChange={(v) => set({ serialOrder: v.map((x) => x.toUpperCase()) })} />}
      {value.requiredApprovals > value.quorum && <p className="small" style={{ color: 'var(--danger-700)' }}>Required approvals cannot exceed the quorum.</p>}
      <RoleSelect label="Add a member role" onChange={(r) => r && !value.memberRoles?.includes(r) && set({ memberRoles: [...(value.memberRoles ?? []), r] })} allowEmpty />
    </Section>
  );
}

export function EsTriggerEditor({ value, onChange }: P) {
  const qn: any[] = value.questionnaire ?? [];
  const set = (patch: any) => onChange({ ...value, ...patch });
  return (
    <>
      <Section title="Trigger" intro="When the condition holds, an E&S review runs concurrently with credit analysis.">
        <TextArea label="Description" rows={2} value={value.description} onChange={(e) => set({ description: e.target.value })} />
        <ConditionBuilder label="Trigger when" value={(value.triggerWhen ?? { always: true }) as Condition} onChange={(c) => set({ triggerWhen: c })} />
        <ConditionPreview condition={value.triggerWhen} />
      </Section>
      <Section title="Categorisation" intro="Sum of answer weights: at or above A → Category A; at or above B → Category B; otherwise C.">
        <div className="grid cols-2">
          <NumberField label="Category A threshold" value={value.categoryThresholds?.A} onChange={(v) => set({ categoryThresholds: { ...value.categoryThresholds, A: v } })} />
          <NumberField label="Category B threshold" value={value.categoryThresholds?.B} onChange={(v) => set({ categoryThresholds: { ...value.categoryThresholds, B: v } })} />
        </div>
      </Section>
      <Section title="Questionnaire">
        {qn.map((q, i) => (
          <div key={i} className="panel auto-grid-host" style={{ padding: 12 }}>
            <div className="auto-grid"><TextInput label="Code" value={q.code} onChange={(e) => set({ questionnaire: upd(qn, i, { code: e.target.value.toUpperCase() }) })} /><div style={{ gridColumn: 'span 2' }}><TextInput label="Question" value={q.text} onChange={(e) => set({ questionnaire: upd(qn, i, { text: e.target.value }) })} /></div></div>
            <div className="table-wrap"><table className="data" style={{ marginTop: 8 }}><thead><tr><th>Option code</th><th>Label</th><th>Weight</th><th /></tr></thead>
              <tbody>{q.options.map((o: any, j: number) => <tr key={j}>
                <td><input className="input" aria-label="Option code" value={o.code} onChange={(e) => set({ questionnaire: upd(qn, i, { options: upd(q.options, j, { code: e.target.value.toUpperCase() }) }) })} /></td>
                <td><input className="input" aria-label="Option label" value={o.label} onChange={(e) => set({ questionnaire: upd(qn, i, { options: upd(q.options, j, { label: e.target.value }) }) })} /></td>
                <td><input className="input" aria-label="Weight" type="number" value={o.weight} onChange={(e) => set({ questionnaire: upd(qn, i, { options: upd(q.options, j, { weight: Number(e.target.value) }) }) })} /></td>
                <td><Button size="sm" variant="ghost" onClick={() => set({ questionnaire: upd(qn, i, { options: del(q.options, j) }) })}>Remove</Button></td></tr>)}</tbody></table></div>
            <div className="row between" style={{ marginTop: 8 }}>
              <Button size="sm" onClick={() => set({ questionnaire: upd(qn, i, { options: [...q.options, { code: 'OPTION', label: 'Option', weight: 0 }] }) })}>Add option</Button>
              <Button size="sm" variant="danger" onClick={() => set({ questionnaire: del(qn, i) })}>Remove question</Button>
            </div>
          </div>
        ))}
        <div><Button size="sm" onClick={() => set({ questionnaire: [...qn, { code: 'NEW_QUESTION', text: 'Question', options: [{ code: 'LOW', label: 'Low', weight: 0 }, { code: 'HIGH', label: 'High', weight: 4 }] }] })}>Add question</Button></div>
      </Section>
    </>
  );
}

const EFF_DEFAULTS = { name: 'Facility efficiency ratio', description: '', formula: '', unit: 'x', direction: 'HIGHER_BETTER', directedBy: 'MANAGEMENT', directionReference: '', bands: [] as any[] };

/** CAM §25 facility efficiency ratio: defined and changed from time to time on management's or the Board's direction. */
export function EfficiencyRatioEditor({ value, onChange }: P) {
  const v = { ...EFF_DEFAULTS, ...(value ?? {}) };
  useEffect(() => { if (!value || !Object.keys(value).length) onChange(EFF_DEFAULTS); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (patch: any) => onChange({ ...v, ...patch });
  const bands: any[] = v.bands ?? [];
  const num = (x: string) => (x.trim() === '' ? null : Number(x));
  const vars = useQuery({ queryKey: ['admin', 'efficiency-variables'], queryFn: () => api.get<{ key: string; description: string }[]>('/api/admin/config/efficiency-variables') });
  const [ref, setRef] = useState('');
  const preview = useQuery({ queryKey: ['admin', 'efficiency-preview', v.formula, ref], queryFn: () => api.post<any>('/api/admin/config/efficiency-preview', { formula: v.formula, ...(ref.trim() ? { facilityRef: ref.trim() } : {}) }), enabled: !!v.formula.trim(), retry: false });
  return (
    <>
      <Section title="Direction" intro="Record who directed this definition. Each change is a new version that a second administrator approves; earlier term sheets keep the version they used.">
        <div className="grid cols-2">
          <SelectInput label="Directed by" value={v.directedBy} options={[{ value: 'MANAGEMENT', label: 'Management' }, { value: 'BOARD', label: 'Board' }]} onChange={(e) => set({ directedBy: e.target.value })} />
          <TextInput label="Direction reference" value={v.directionReference} placeholder="e.g. MANCO minutes 2026/41 or Board resolution 2026/12" onChange={(e) => set({ directionReference: e.target.value })} />
        </div>
      </Section>
      <Section title="Definition" intro="Write the formula with the variables listed below, + − × ÷ ^ and abs/min/max/avg. Amounts are in Naira.">
        <div className="grid cols-2"><TextInput label="Name" value={v.name} onChange={(e) => set({ name: e.target.value })} /><SelectInput label="Unit" value={v.unit} options={[{ value: 'x', label: 'times (×)' }, { value: '%', label: '%' }, { value: 'days', label: 'days' }, { value: 'NGN', label: '₦' }, { value: 'ratio', label: 'ratio' }]} onChange={(e) => set({ unit: e.target.value })} /></div>
        <TextArea label="Description" rows={2} value={v.description} onChange={(e) => set({ description: e.target.value })} hint="What the ratio measures, in plain language. Shown on the term sheet." />
        <TextInput label="Formula" className="input mono" value={v.formula} placeholder="e.g. ANNUAL_CREDIT_TURNOVER / REQUEST_AMOUNT" onChange={(e) => set({ formula: e.target.value.toUpperCase() })} />
        <SelectInput label="Direction" value={v.direction} options={[{ value: 'HIGHER_BETTER', label: 'Higher is better' }, { value: 'LOWER_BETTER', label: 'Lower is better' }, { value: 'NEUTRAL', label: 'Neutral' }]} onChange={(e) => set({ direction: e.target.value })} />
        <div className="panel" style={{ padding: 12 }}>
          <div className="row between"><strong className="small">Preview</strong><input className="input" style={{ maxWidth: 240 }} aria-label="Facility reference for preview" placeholder="Facility reference (optional)" value={ref} onChange={(e) => setRef(e.target.value)} /></div>
          <div className="small" style={{ marginTop: 6 }}>{!v.formula.trim() ? <span className="muted">Enter a formula.</span> : preview.isLoading ? 'Checking…' : preview.error ? <span style={{ color: 'var(--danger-700)' }}>{(preview.error as any).message}</span> : !preview.data?.valid ? <span style={{ color: 'var(--danger-700)' }}>{preview.data?.error}</span> : preview.data.value === undefined ? 'Formula is valid. Enter a facility reference to see its value.' : preview.data.value === null ? `Cannot compute for this facility: missing ${preview.data.missing.join(', ') || preview.data.error}.` : <>Value for {ref}: <strong>{Number(preview.data.value).toLocaleString('en-NG', { maximumFractionDigits: 4 })}</strong></>}</div>
        </div>
        <details className="small"><summary>Available variables</summary><div className="table-wrap"><table className="data"><tbody>{(vars.data ?? []).map((x) => <tr key={x.key}><td className="mono">{x.key}</td><td>{x.description}</td></tr>)}</tbody></table></div></details>
      </Section>
      <Section title="Assessment bands" intro="Optional. Lower bound inclusive, upper bound exclusive; leave a bound empty for open-ended.">
        <div className="table-wrap"><table className="data"><thead><tr><th>From</th><th>To</th><th>Label</th><th>Assessment</th><th /></tr></thead>
          <tbody>{bands.map((b, i) => <tr key={i}>
            <td><input className="input" aria-label="From" value={b.min ?? ''} onChange={(e) => set({ bands: upd(bands, i, { min: num(e.target.value) }) })} /></td>
            <td><input className="input" aria-label="To" value={b.max ?? ''} onChange={(e) => set({ bands: upd(bands, i, { max: num(e.target.value) }) })} /></td>
            <td><input className="input" aria-label="Label" value={b.label} onChange={(e) => set({ bands: upd(bands, i, { label: e.target.value }) })} /></td>
            <td><input className="input" aria-label="Assessment" value={b.assessment} onChange={(e) => set({ bands: upd(bands, i, { assessment: e.target.value }) })} /></td>
            <td><Button size="sm" variant="ghost" onClick={() => set({ bands: del(bands, i) })}>Remove</Button></td></tr>)}</tbody></table></div>
        <div><Button size="sm" onClick={() => set({ bands: [...bands, { min: null, max: null, label: 'Band', assessment: 'Describe the assessment.' }] })}>Add band</Button></div>
      </Section>
    </>
  );
}

/** Session timeout: inactivity limit, warning lead time and maximum session length (validated on the server too). */
export function SessionPolicyEditor({ value, onChange }: P) {
  const v = { idleMinutes: 15, absoluteHours: 8, warningSeconds: 120, ...(value ?? {}) };
  const set = (patch: any) => onChange({ ...v, ...patch });
  const problems = [
    v.warningSeconds >= v.idleMinutes * 60 && 'The warning must appear before the inactivity timeout.',
    v.idleMinutes > v.absoluteHours * 60 && 'The inactivity timeout cannot be longer than the maximum session length.',
  ].filter(Boolean) as string[];
  return (
    <Section title="Timeout" intro="Applies to every session of this audience within 30 seconds of approval. Background refreshes never count as activity; typing, clicking or scrolling does.">
      <div className="grid cols-3">
        <NumberField label="Sign out after inactivity (minutes)" min={5} max={120} required value={v.idleMinutes} onChange={(x) => set({ idleMinutes: x })} hint="5 – 120 minutes" />
        <NumberField label="Warn before sign-out (seconds)" min={30} max={600} required value={v.warningSeconds} onChange={(x) => set({ warningSeconds: x })} hint="30 – 600 seconds; the user can choose to stay signed in" />
        <NumberField label="Maximum session length (hours)" min={1} max={24} required value={v.absoluteHours} onChange={(x) => set({ absoluteHours: x })} hint="1 – 24 hours, regardless of activity" />
      </div>
      {problems.length > 0 && <div className="alert danger" role="alert"><div><ul style={{ margin: 0 }}>{problems.map((p) => <li key={p}>{p}</li>)}</ul></div></div>}
      <p className="small muted">A user idle for {v.idleMinutes} minutes sees a {Math.round(v.warningSeconds / 6) / 10}-minute warning at minute {Math.round((v.idleMinutes - v.warningSeconds / 60) * 10) / 10}. No session lasts longer than {v.absoluteHours} hours.</p>
    </Section>
  );
}

export const STRUCTURED: Partial<Record<string, (p: P) => ReactElement>> = {
  session_policy: SessionPolicyEditor,
  approval_authority: AuthorityEditor, sla_policy: SlaEditor, fipg_rule: FipgEditor, ratio: RatioEditor, committee: CommitteeEditor, es_trigger: EsTriggerEditor, facility_efficiency_ratio: EfficiencyRatioEditor,
};
