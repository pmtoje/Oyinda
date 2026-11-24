import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../../lib/api';
import { Alert, Button, Check, ErrorAlert, Loading, TextArea, TextInput, useAction, fieldError } from '../../../components/ui';

/**
 * "Verify your identity" — BVN and NIN for each director and promoter the Bank's policy requires.
 * Numbers go only in the request body, are never shown back in full, and are checked server-side with approved
 * services (a clearly marked sandbox outside production) and the Bank's own records.
 */
type CheckRow = { kind: 'BVN' | 'NIN'; state: string; stale: boolean; source: 'SANDBOX' | 'LIVE' | null; results: { attribute: string; against: string; result: string }[]; bankRecord: string | null };
type Person = { partyId: string; name: string; partyType: string; ownershipPct: number | null; required: boolean; state: string; dateOfBirthProvided: boolean; bvnLast4: string | null; ninLast4: string | null; checks: CheckRow[]; review: { status: string } | null; canRequestReview: boolean };
type Overview = { policy: { requireBvn: boolean; requireNin: boolean; consentText: string; blockSubmission: boolean }; people: Person[]; requiredCount: number; verifiedCount: number; allVerified: boolean };

export const IDENTITY_LABEL: Record<string, string> = {
  NOT_STARTED: 'Not started', IN_PROGRESS: 'Checking', VERIFIED: 'Verified', DISCREPANCY: 'Details differ',
  REVIEW_REQUIRED: 'With the Bank for review', PROVIDER_UNAVAILABLE: 'Service unavailable', UNSUCCESSFUL: 'Not verified',
};
const TONE: Record<string, string> = { VERIFIED: 'VERIFIED', DISCREPANCY: 'DECLINED', UNSUCCESSFUL: 'DECLINED', REVIEW_REQUIRED: 'PENDING', PROVIDER_UNAVAILABLE: 'PENDING', IN_PROGRESS: 'IN_PROGRESS', NOT_STARTED: 'DRAFT' };
const ROLE: Record<string, string> = { DIRECTOR: 'Director', SHAREHOLDER: 'Shareholder', PROMOTER: 'Promoter', PRINCIPAL_OFFICER: 'Principal officer', BOARD_MEMBER: 'Board member', KEY_EXECUTIVE: 'Key executive' };
const AGAINST: Record<string, string> = { PROVIDED: 'what you entered', BVN_RECORD: 'the BVN record', BANK_RECORD: 'the Bank’s own records' };
const ATTR: Record<string, string> = { fullName: 'Name', dateOfBirth: 'Date of birth' };

function Badge({ state }: { state: string }) {
  return <span className={`badge ${TONE[state] === 'VERIFIED' ? 'ok' : TONE[state] === 'DECLINED' ? 'danger' : TONE[state] === 'PENDING' ? 'warn' : TONE[state] === 'IN_PROGRESS' ? 'info' : ''}`}>{IDENTITY_LABEL[state] ?? state}</span>;
}

/** Plain-language explanation of what differed — attribute level only, never the record's values. */
function differences(p: Person) {
  const out: string[] = [];
  for (const c of p.checks) for (const r of c.results) if (r.result === 'MISMATCH') out.push(`${ATTR[r.attribute] ?? r.attribute} on the ${c.kind} record does not match ${AGAINST[r.against] ?? r.against}.`);
  return [...new Set(out)];
}

const WORST = ['REVIEW_REQUIRED', 'DISCREPANCY', 'UNSUCCESSFUL', 'PROVIDER_UNAVAILABLE', 'IN_PROGRESS', 'NOT_STARTED', 'VERIFIED'];
/** One card per person: the same individual can be both a director and a shareholder (one record per capacity). */
function groupPeople(list: Person[]) {
  const by = new Map<string, Person[]>();
  for (const p of list) { const k = p.name.trim().toLowerCase().replace(/\s+/g, ' '); by.set(k, [...(by.get(k) ?? []), p]); }
  return [...by.values()];
}

function PersonCard({ group, customerId, policy, onDone }: { group: Person[]; customerId: string; policy: Overview['policy']; onDone: () => void }) {
  const state = WORST.find((s) => group.some((g) => g.state === s)) ?? 'VERIFIED';
  const lead = group.find((g) => g.state === state) ?? group[0]!;
  const p: Person = { ...lead, state, required: group.some((g) => g.required), canRequestReview: group.some((g) => g.canRequestReview) };
  const [open, setOpen] = useState(p.state !== 'VERIFIED' && p.state !== 'REVIEW_REQUIRED' && p.required);
  const [f, setF] = useState({ dateOfBirth: '', bvn: '', nin: '', consent: false });
  const [note, setNote] = useState('');
  const [askReview, setAskReview] = useState(false);
  const verify = useAction(async () => {
    // Same identifiers for each capacity this person holds; the server reuses the first result rather than re-checking.
    for (const g of group.filter((x) => x.state !== 'VERIFIED')) await api.post(`/api/customers/${customerId}/parties/${g.partyId}/identity/verify`, { dateOfBirth: f.dateOfBirth, ...(f.bvn ? { bvn: f.bvn } : {}), ...(f.nin ? { nin: f.nin } : {}), consent: f.consent });
    setF({ ...f, bvn: '', nin: '' }); onDone();
  });
  const review = useAction(async () => { for (const g of group.filter((x) => x.canRequestReview)) await api.post(`/api/customers/${customerId}/parties/${g.partyId}/identity/review`, { note }); setAskReview(false); onDone(); });
  const sandbox = p.checks.some((c) => c.source === 'SANDBOX');
  const diffs = differences(p);
  const needBvn = policy.requireBvn && !p.bvnLast4;
  const needNin = policy.requireNin && !p.checks.find((c) => c.kind === 'NIN' && c.state === 'VERIFIED');
  const ready = !!f.dateOfBirth && f.consent && (!needBvn || f.bvn.length === 11) && (!needNin || f.nin.length === 11) && (!f.bvn || f.bvn.length === 11) && (!f.nin || f.nin.length === 11);
  return (
    <section className="id-person" aria-labelledby={`idp-${p.partyId}`}>
      <div className="id-person-head">
        <div style={{ minWidth: 0 }}>
          <h4 id={`idp-${p.partyId}`} className="id-name">{p.name}</h4>
          <div className="small muted">{group.map((g) => `${ROLE[g.partyType] ?? g.partyType}${g.ownershipPct ? ` ${g.ownershipPct}%` : ''}`).join(' · ')}{p.bvnLast4 ? ` · BVN •••${p.bvnLast4}` : ''}{p.ninLast4 ? ` · NIN •••${p.ninLast4}` : ''}{!p.required ? ' · optional' : ''}</div>
        </div>
        <div className="row" style={{ gap: 8 }}>
          {sandbox && <span className="tag mock" title="Checked against the sandbox provider. Not a live BVN/NIN check.">SANDBOX</span>}
          <Badge state={p.state} />
        </div>
      </div>

      {p.state === 'VERIFIED' && <p className="small muted id-msg">Identity confirmed{p.review?.status === 'CLEARED' ? ' after review by the Bank' : ''}.</p>}
      {p.state === 'REVIEW_REQUIRED' && <p className="small id-msg">The Bank is reviewing this person’s identity. You don’t need to do anything; we’ll let you know if we need more.</p>}
      {p.state === 'PROVIDER_UNAVAILABLE' && <Alert tone="warn" title="The verification service is temporarily unavailable">Your details are saved. Please try again in a few minutes.</Alert>}
      {p.state === 'UNSUCCESSFUL' && !p.review && <Alert tone="danger" title="We couldn’t verify these numbers">Check the BVN and NIN and try again. If they are correct, contact your relationship manager.</Alert>}
      {p.state === 'UNSUCCESSFUL' && p.review?.status === 'REJECTED' && <Alert tone="danger" title="Identity not confirmed">After review the Bank could not confirm this person’s identity. Your relationship manager will contact you.</Alert>}
      {p.state === 'DISCREPANCY' && (
        <Alert tone="danger" title="Some details don’t match the identity records">
          <ul>{diffs.map((d) => <li key={d}>{d}</li>)}</ul>
          <p className="small" style={{ margin: '6px 0 0' }}>Check the name in the business profile and the date of birth, then verify again. If the difference is genuine (for example a recent name change), ask the Bank to review it.</p>
        </Alert>
      )}

      {p.canRequestReview && (askReview ? (
        <div className="stack" style={{ ['--gap' as any]: '8px' }}>
          <TextArea label="Why do the details differ?" value={note} onChange={(e) => setNote(e.target.value)} hint="For example: the NIN shows a previous surname; marriage certificate available." />
          <ErrorAlert error={review.error} />
          <div className="row"><Button variant="ghost" onClick={() => setAskReview(false)}>Cancel</Button><Button variant="primary" disabled={note.trim().length < 5} loading={review.loading} onClick={() => review.run()}>Ask the Bank to review</Button></div>
        </div>
      ) : <div><Button size="sm" onClick={() => setAskReview(true)}>Ask the Bank to review</Button></div>)}

      {p.state !== 'VERIFIED' && p.state !== 'REVIEW_REQUIRED' && (
        open ? (
          <form className="stack id-form" onSubmit={(e) => { e.preventDefault(); if (ready) void verify.run(); }} autoComplete="off">
            <div className="grid cols-3">
              <TextInput label="Date of birth" type="date" required value={f.dateOfBirth} max={new Date().toISOString().slice(0, 10)} onChange={(e) => setF({ ...f, dateOfBirth: e.target.value })} error={fieldError(verify.error, 'dateOfBirth')} />
              <TextInput label="BVN" inputMode="numeric" autoComplete="off" spellCheck={false} maxLength={11} required={needBvn} value={f.bvn} onChange={(e) => setF({ ...f, bvn: e.target.value.replace(/\D/g, '') })} hint={p.bvnLast4 ? `Ending ${p.bvnLast4} is on file. Leave blank to use it.` : '11 digits. Dial *565*0# to retrieve it.'} error={fieldError(verify.error, 'bvn')} />
              <TextInput label="NIN" inputMode="numeric" autoComplete="off" spellCheck={false} maxLength={11} required={needNin} value={f.nin} onChange={(e) => setF({ ...f, nin: e.target.value.replace(/\D/g, '') })} hint={needNin ? '11 digits, on the NIN slip or the NIMC app.' : 'Already verified. Enter only to check again.'} error={fieldError(verify.error, 'nin')} />
            </div>
            <Check label={policy.consentText} checked={f.consent} onChange={(e) => setF({ ...f, consent: e.target.checked })} />
            <ErrorAlert error={verify.error} />
            <div className="row"><Button type="submit" variant="primary" disabled={!ready} loading={verify.loading}>Verify {p.name.split(' ')[0]}</Button></div>
          </form>
        ) : <div><Button size="sm" onClick={() => setOpen(true)}>Verify identity</Button></div>
      )}
    </section>
  );
}

export function IdentityPanel({ customerId }: { customerId: string }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['identity', customerId], queryFn: () => api.get<Overview>(`/api/customers/${customerId}/identity`) });
  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: ['identity', customerId] }), qc.invalidateQueries({ queryKey: ['facility'] })]);
  if (q.isLoading) return <Loading rows={3} />;
  if (q.error) return <ErrorAlert error={q.error} />;
  const o = q.data!;
  const required = o.people.filter((p) => p.required);
  const requiredNames = new Set(required.map((p) => p.name.trim().toLowerCase().replace(/\s+/g, ' ')));
  const optional = o.people.filter((p) => !p.required && !requiredNames.has(p.name.trim().toLowerCase().replace(/\s+/g, ' ')));
  return (
    <div className="stack">
      <div className="id-intro">
        <p>We confirm the identity of each director and significant shareholder with their <strong>BVN</strong> and <strong>NIN</strong>. It protects your business against impersonation and is required before a financing request can be submitted.</p>
        <p className="small muted">The numbers are encrypted, checked only with approved verification services and the Bank’s own records, and never shown in full again — not even to you.</p>
      </div>
      {!o.requiredCount ? (
        <Alert tone="info" title="Add your directors and promoters first">Add them in your <Link to="/portal/profile">business profile</Link>, then return here to verify them.</Alert>
      ) : (
        <div className={`id-progress ${o.allVerified ? 'done' : ''}`} role="status">
          <strong>{groupPeople(required).filter((g) => g.every((x) => x.state === 'VERIFIED')).length} of {groupPeople(required).length}</strong> {groupPeople(required).length === 1 ? 'person' : 'people'} verified{o.allVerified ? ' — you’re all set.' : ''}
        </div>
      )}
      {groupPeople(required).map((g) => <PersonCard key={g[0]!.partyId} group={g} customerId={customerId} policy={o.policy} onDone={refresh} />)}
      {optional.length > 0 && (
        <details className="id-optional">
          <summary>Other people in your business ({optional.length}) — optional</summary>
          <div className="stack" style={{ marginTop: 12 }}>{groupPeople(optional).map((g) => <PersonCard key={g[0]!.partyId} group={g} customerId={customerId} policy={o.policy} onDone={refresh} />)}</div>
        </details>
      )}
    </div>
  );
}
