import type { ReactElement } from 'react';
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
      <Section title="Approval levels" intro="Ordered from lowest to highest authority. The chain runs up to the first level whose limit covers the amount; lower levels recommend.">
        <div className="table-wrap"><table className="data">
          <thead><tr><th>#</th><th>Code / name</th><th>Type</th><th>Role or committee</th><th className="num">Limit</th><th className="num">Cash-backed limit</th><th>SLA policy</th><th /></tr></thead>
          <tbody>{levels.map((l, i) => (
            <tr key={i}>
              <td>{i + 1}</td>
              <td><input className="input" aria-label="Level code" value={l.code} onChange={(e) => set({ levels: upd(levels, i, { code: e.target.value.toUpperCase() }) })} /><input className="input" aria-label="Level name" style={{ marginTop: 4 }} value={l.name} onChange={(e) => set({ levels: upd(levels, i, { name: e.target.value }) })} /></td>
              <td><select className="select" aria-label="Level type" value={l.kind} onChange={(e) => set({ levels: upd(levels, i, { kind: e.target.value }) })}><option value="INDIVIDUAL">Individual</option><option value="COMMITTEE">Committee</option></select></td>
              <td>{l.kind === 'COMMITTEE'
                ? <input className="input" aria-label="Committee key" value={l.committeeKey ?? ''} onChange={(e) => set({ levels: upd(levels, i, { committeeKey: e.target.value.toUpperCase(), role: undefined }) })} />
                : <input className="input" aria-label="Role code" value={l.role ?? ''} onChange={(e) => set({ levels: upd(levels, i, { role: e.target.value.toUpperCase(), committeeKey: undefined }) })} />}</td>
              <td className="num"><NairaField label="Limit" minor={l.limitMinor} onChange={(m) => set({ levels: upd(levels, i, { limitMinor: m ?? 0 }) })} hint={money(l.limitMinor, 'NGN', { compact: true })} /></td>
              <td className="num"><NairaField label="Cash-backed" minor={l.cashBackedLimitMinor} onChange={(m) => set({ levels: upd(levels, i, { cashBackedLimitMinor: m }) })} /></td>
              <td><input className="input" aria-label="SLA policy key" value={l.slaPolicyKey} onChange={(e) => set({ levels: upd(levels, i, { slaPolicyKey: e.target.value }) })} /></td>
              <td><Button size="sm" variant="ghost" onClick={() => set({ levels: del(levels, i) })}>Remove</Button></td>
            </tr>))}</tbody>
        </table></div>
        <div><Button size="sm" onClick={() => set({ levels: [...levels, { code: 'NEW_LEVEL', name: 'New level', kind: 'INDIVIDUAL', role: 'MD', limitMinor: 0, slaPolicyKey: 'APPROVAL_INDIVIDUAL', alwaysReview: false }] })}>Add level</Button></div>
      </Section>
      <Section title="Routing overrides" intro="Special workflows (insider, PEP, SOL breach, pricing exception). A final level forces that authority; a minimum raises the final level when it is lower.">
        {overrides.map((o, i) => (
          <div key={i} className="panel" style={{ padding: 12 }}>
            <div className="grid cols-3">
              <TextInput label="Code" value={o.code} onChange={(e) => set({ overrides: upd(overrides, i, { code: e.target.value.toUpperCase() }) })} />
              <SelectInput label="Final level (forced)" value={o.finalLevel ?? ''} placeholder="—" options={levels.map((l) => ({ value: l.code, label: l.name }))} onChange={(e) => set({ overrides: upd(overrides, i, { finalLevel: e.target.value || undefined }) })} />
              <SelectInput label="Minimum final level" value={o.minimumFinalLevel ?? ''} placeholder="—" options={levels.map((l) => ({ value: l.code, label: l.name }))} onChange={(e) => set({ overrides: upd(overrides, i, { minimumFinalLevel: e.target.value || undefined }) })} />
            </div>
            <TextArea label="Reason (shown in the route explanation)" rows={2} value={o.reason} onChange={(e) => set({ overrides: upd(overrides, i, { reason: e.target.value }) })} />
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
          <div key={i} className="panel" style={{ padding: 12 }}>
            <div className="grid cols-3"><TextInput label="Code" value={q.code} onChange={(e) => set({ questionnaire: upd(qn, i, { code: e.target.value.toUpperCase() }) })} /><div style={{ gridColumn: 'span 2' }}><TextInput label="Question" value={q.text} onChange={(e) => set({ questionnaire: upd(qn, i, { text: e.target.value }) })} /></div></div>
            <table className="data" style={{ marginTop: 8 }}><thead><tr><th>Option code</th><th>Label</th><th>Weight</th><th /></tr></thead>
              <tbody>{q.options.map((o: any, j: number) => <tr key={j}>
                <td><input className="input" aria-label="Option code" value={o.code} onChange={(e) => set({ questionnaire: upd(qn, i, { options: upd(q.options, j, { code: e.target.value.toUpperCase() }) }) })} /></td>
                <td><input className="input" aria-label="Option label" value={o.label} onChange={(e) => set({ questionnaire: upd(qn, i, { options: upd(q.options, j, { label: e.target.value }) }) })} /></td>
                <td><input className="input" aria-label="Weight" type="number" value={o.weight} onChange={(e) => set({ questionnaire: upd(qn, i, { options: upd(q.options, j, { weight: Number(e.target.value) }) }) })} /></td>
                <td><Button size="sm" variant="ghost" onClick={() => set({ questionnaire: upd(qn, i, { options: del(q.options, j) }) })}>Remove</Button></td></tr>)}</tbody></table>
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

export const STRUCTURED: Partial<Record<string, (p: P) => ReactElement>> = {
  approval_authority: AuthorityEditor, sla_policy: SlaEditor, fipg_rule: FipgEditor, ratio: RatioEditor, committee: CommitteeEditor, es_trigger: EsTriggerEditor,
};
