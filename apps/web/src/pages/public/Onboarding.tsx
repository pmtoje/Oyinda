import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { AuthLayout } from '../../components/Shells';
import { Alert, Button, Check, Drawer, ErrorAlert, Field, KV, TextInput, fieldError, useAction } from '../../components/ui';
import { api } from '../../lib/api';
import { date } from '../../lib/format';
import { useAuth } from '../../lib/auth';
import { OtpField, ResendButton, otpErrorMessage } from './parts/OtpField';

type Stage = 'ACCOUNT' | 'OTP' | 'PASSWORD' | 'DONE';
const STAGES: [Stage, string][] = [['ACCOUNT', 'Account'], ['OTP', 'Verify'], ['PASSWORD', 'Create account'], ['DONE', 'Welcome']];

interface Policy { minLength: number; maxLength: number; requireUpper: boolean; requireLower: boolean; requireDigit: boolean; requireSymbol: boolean; disallowPersonalInfo: boolean }
interface Verified {
  business: { name: string; accountName: string; rcNumber: string | null; tin: string | null; incorporationDate: string | null; address: string; accounts: { account: string; currency: string; product: string }[]; registeredPhone: string };
  applicant: { name: string; roleInCompany: string };
  username: string | null;
  alreadyOnGazelle: boolean;
  passwordPolicy: Policy | null;
  terms: { version: string; termsText: string; privacyText: string } | null;
}

/** Client-side mirror of the server policy, for immediate feedback only — the server re-checks every rule. */
function unmet(p: Policy | null, pw: string): string[] {
  if (!p) return [];
  const out: string[] = [];
  if (pw.length < p.minLength) out.push(`At least ${p.minLength} characters`);
  if (pw.length > p.maxLength) out.push(`No more than ${p.maxLength} characters`);
  if (p.requireUpper && !/[A-Z]/.test(pw)) out.push('At least one upper-case letter');
  if (p.requireLower && !/[a-z]/.test(pw)) out.push('At least one lower-case letter');
  if (p.requireDigit && !/[0-9]/.test(pw)) out.push('At least one number');
  if (p.requireSymbol && !/[^A-Za-z0-9]/.test(pw)) out.push('At least one special character');
  return out;
}

export default function Onboarding() {
  const nav = useNavigate();
  const { refresh } = useAuth();
  const [stage, setStage] = useState<Stage>('ACCOUNT');
  const [form, setForm] = useState({ accountNumber: '', fullName: '', roleInCompany: '' });
  const [sentTo, setSentTo] = useState<{ phone: string; email: string | null } | null>(null);
  const [code, setCode] = useState('');
  const [verified, setVerified] = useState<Verified | null>(null);
  const [pw, setPw] = useState({ password: '', confirm: '', acceptTerms: false, privacyConsent: false });
  const [popup, setPopup] = useState<string[] | null>(null);
  const [done, setDone] = useState<{ username: string; welcomeEmailSentTo: string } | null>(null);

  const start = useAction(async () => { const r = await api.post('/api/onboarding/start', form); setSentTo(r.otpSentTo); setCode(''); setStage('OTP'); });
  const resend = () => api.post('/api/onboarding/resend-otp').then((r: any) => setSentTo(r.otpSentTo));
  const verify = useAction(async () => { setVerified(await api.post('/api/onboarding/verify-otp', { code })); setStage('PASSWORD'); });
  const complete = useAction(async () => {
    try {
      setDone(await api.post('/api/onboarding/complete', { password: pw.password, acceptTerms: pw.acceptTerms, privacyConsent: pw.privacyConsent, termsVersion: verified!.terms?.version ?? '' }));
      await refresh();
      setStage('DONE');
    } catch (e: any) {
      if (e?.code === 'PASSWORD_POLICY') { setPopup(e.details?.unmet ?? [e.message]); return; }
      throw e;
    }
  });
  const issues = useMemo(() => unmet(verified?.passwordPolicy ?? null, pw.password), [verified, pw.password]);
  const submitPassword = () => {
    // SWR: where the password does not meet the requirements, notify the customer with a pop-up.
    if (issues.length) { setPopup(issues); return; }
    if (pw.password !== pw.confirm) { setPopup(['The two passwords do not match']); return; }
    void complete.run();
  };

  const idx = STAGES.findIndex(([s]) => s === stage);
  return (
    <AuthLayout heading="Set up Gazelle for your business." text="We verify your business against the Bank's records. Your registered details come directly from core banking, so you do not need to re-enter them.">
      <ol className="stepper" aria-label="Onboarding progress" style={{ marginBottom: 24 }}>
        {STAGES.map(([s, l], i) => <li key={s} className={i < idx ? 'done' : i === idx ? 'current' : ''} aria-current={i === idx ? 'step' : undefined}>{l}</li>)}
      </ol>

      {stage === 'ACCOUNT' && (
        <form className="stack" onSubmit={(e) => { e.preventDefault(); void start.run(); }}>
          <div><h2>Your business account</h2><p className="muted">Enter your Alternative Bank business account number, your name and your role in the company.</p></div>
          <ErrorAlert error={start.error && !fieldError(start.error, 'accountNumber') ? start.error : null} />
          <TextInput label="Company account number" inputMode="numeric" maxLength={10} required autoFocus value={form.accountNumber} onChange={(e) => setForm({ ...form, accountNumber: e.target.value.replace(/\D/g, '').slice(0, 10) })} hint="10-digit NUBAN." error={fieldError(start.error, 'accountNumber')} />
          <TextInput label="Your full name" required autoComplete="name" value={form.fullName} onChange={(e) => setForm({ ...form, fullName: e.target.value })} error={fieldError(start.error, 'fullName')} />
          <TextInput label="Your role in the company" required placeholder="e.g. Chief Financial Officer" value={form.roleInCompany} onChange={(e) => setForm({ ...form, roleInCompany: e.target.value })} error={fieldError(start.error, 'roleInCompany')} />
          <p className="xs muted">A verification code will be sent to the phone number and e-mail address registered on the account with the Bank.</p>
          <Button type="submit" variant="primary" size="lg" loading={start.loading} disabled={form.accountNumber.length !== 10 || form.fullName.trim().length < 3 || form.roleInCompany.trim().length < 2}>Continue</Button>
          <p className="small muted">Already registered? <Link to="/login">Sign in</Link></p>
        </form>
      )}

      {stage === 'OTP' && sentTo && (
        <form className="stack" onSubmit={(e) => { e.preventDefault(); void verify.run(); }}>
          <div><h2>Verify it’s you</h2><p className="muted">If the account could be verified, we sent a 6-digit code to <strong>{sentTo.phone}</strong>{sentTo.email && <> and <strong>{sentTo.email}</strong></>}, the details registered with the Bank.</p></div>
          <OtpField value={code} onChange={setCode} error={otpErrorMessage(verify.error)} />
          <Button type="submit" variant="primary" size="lg" loading={verify.loading} disabled={code.length !== 6}>Verify</Button>
          <div className="row between">
            <Button variant="ghost" size="sm" onClick={() => { setStage('ACCOUNT'); setCode(''); }}>Change account number</Button>
            <ResendButton onResend={resend} />
          </div>
          <p className="xs muted">No longer have access to these details? Contact your relationship manager to update the account record before continuing.</p>
        </form>
      )}

      {stage === 'PASSWORD' && verified && (
        <form className="stack" onSubmit={(e) => { e.preventDefault(); submitPassword(); }}>
          <div><h2>{verified.business.accountName}</h2><p className="muted">Account verified. These details are held on the Bank's core banking record and cannot be edited here.</p></div>
          {verified.alreadyOnGazelle && <Alert tone="info" title="This business is already registered on Gazelle">Sign in with the company e-mail address. <Link to="/login">Go to sign in</Link></Alert>}
          <div className="panel"><div className="panel-body">
            <KV items={[
              ['Account name', <strong key="n">{verified.business.accountName}</strong>],
              ['RC number', verified.business.rcNumber],
              ['TIN', verified.business.tin],
              ['Incorporated', date(verified.business.incorporationDate)],
              ['Accounts', verified.business.accounts.map((a) => `${a.account} · ${a.currency} · ${a.product}`).join('\n')],
              ['Applicant', `${verified.applicant.name} — ${verified.applicant.roleInCompany}`],
            ]} />
          </div></div>
          {!verified.username ? (
            <Alert tone="warn" title="No company e-mail on record">The Bank does not hold a company e-mail address for this account. Ask your relationship manager or branch to update it, then start again.</Alert>
          ) : (
            <>
              <h3>Create your Gazelle account</h3>
              <TextInput label="Username (company e-mail on the Bank's record)" value={verified.username} readOnly hint="You will sign in with this e-mail address." />
              <TextInput label="Password" type="password" autoComplete="new-password" required value={pw.password} onChange={(e) => setPw({ ...pw, password: e.target.value })} />
              {verified.passwordPolicy && (
                <ul className="checklist small" aria-label="Password requirements">
                  {unmet(verified.passwordPolicy, '').map((rule) => <li key={rule} className={issues.includes(rule) ? '' : 'ok'}>{rule}</li>)}
                  {verified.passwordPolicy.disallowPersonalInfo && <li>Must not contain your name or e-mail address</li>}
                </ul>
              )}
              <TextInput label="Confirm password" type="password" autoComplete="new-password" required value={pw.confirm} onChange={(e) => setPw({ ...pw, confirm: e.target.value })} />
              {verified.terms ? (
                <>
                  <Field label={`Terms and conditions (version ${verified.terms.version})`}>{() => <div className="panel small" style={{ maxHeight: 140, overflowY: 'auto', padding: 12 }} tabIndex={0}>{verified.terms!.termsText}</div>}</Field>
                  <Check label="I have read and accept the terms and conditions, and I am authorised to act for this business." checked={pw.acceptTerms} onChange={(e) => setPw({ ...pw, acceptTerms: e.target.checked })} />
                  <Field label="Data privacy terms">{() => <div className="panel small" style={{ maxHeight: 140, overflowY: 'auto', padding: 12 }} tabIndex={0}>{verified.terms!.privacyText}</div>}</Field>
                  <Check label="I accept the data privacy terms (NDPA 2023)." checked={pw.privacyConsent} onChange={(e) => setPw({ ...pw, privacyConsent: e.target.checked })} />
                </>
              ) : <Alert tone="warn">The terms are temporarily unavailable. Please try again shortly.</Alert>}
              <ErrorAlert error={complete.error} />
              <Button type="submit" variant="primary" size="lg" loading={complete.loading} disabled={!verified.terms || !pw.acceptTerms || !pw.privacyConsent || !pw.password || !pw.confirm || verified.alreadyOnGazelle}>Create account</Button>
            </>
          )}
        </form>
      )}

      {stage === 'DONE' && done && (
        <div className="stack">
          <div><h2>Your account is ready</h2><p className="muted">We sent a welcome e-mail to <strong>{done.welcomeEmailSentTo}</strong> with a link to confirm the address. You can start a facility request once it is confirmed.</p></div>
          <Alert tone="ok" title="Next step">Open your dashboard to review your business details, then confirm your e-mail using the link we sent.</Alert>
          <Button variant="primary" size="lg" onClick={() => nav('/portal', { replace: true })}>Go to my dashboard</Button>
        </div>
      )}

      {popup && (
        <Drawer center title="Your password needs attention" onClose={() => setPopup(null)} footer={<Button variant="primary" onClick={() => setPopup(null)}>Update password</Button>}>
          <p>Your password does not meet the Bank's requirements:</p>
          <ul>{popup.map((x) => <li key={x}>{x}</li>)}</ul>
        </Drawer>
      )}
    </AuthLayout>
  );
}
