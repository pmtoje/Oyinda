import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { AuthLayout } from '../../components/Shells';
import { Alert, Button, Check, ErrorAlert, Field, KV, TextInput, fieldError, useAction } from '../../components/ui';
import { api } from '../../lib/api';
import { date } from '../../lib/format';
import { useAuth } from '../../lib/auth';
import { OtpField, ResendButton, otpErrorMessage } from './parts/OtpField';

type Stage = 'ACCOUNT' | 'OTP' | 'DETAILS' | 'EMAIL';
const STAGES: [Stage, string][] = [['ACCOUNT', 'Account'], ['OTP', 'Verify'], ['DETAILS', 'Your details'], ['EMAIL', 'Email']];

interface Verified {
  business: { name: string; rcNumber: string | null; tin: string | null; incorporationDate: string | null; address: string; accounts: { account: string; currency: string; product: string }[]; registeredPhone: string };
  alreadyOnGazelle: boolean;
  terms: { version: string; termsText: string; privacyText: string } | null;
}

export default function Onboarding() {
  const nav = useNavigate();
  const { refresh } = useAuth();
  const [stage, setStage] = useState<Stage>('ACCOUNT');
  const [account, setAccount] = useState('');
  const [sentTo, setSentTo] = useState('');
  const [code, setCode] = useState('');
  const [verified, setVerified] = useState<Verified | null>(null);
  const [form, setForm] = useState({ fullName: '', email: '', designation: '', acceptTerms: false, privacyConsent: false });
  const [emailCh, setEmailCh] = useState<{ id: string; sentTo: string } | null>(null);
  const [emailCode, setEmailCode] = useState('');

  const start = useAction(async () => { const r = await api.post('/api/onboarding/start', { accountNumber: account }); setSentTo(r.otpSentTo); setCode(''); setStage('OTP'); });
  const resend = () => api.post('/api/onboarding/resend-otp').then((r: any) => setSentTo(r.otpSentTo));
  const verify = useAction(async () => { setVerified(await api.post('/api/onboarding/verify-otp', { code })); setStage('DETAILS'); });
  const complete = useAction(async () => {
    const r = await api.post('/api/onboarding/complete', { ...form, termsVersion: verified!.terms?.version ?? '' });
    setEmailCh({ id: r.emailVerificationChallengeId, sentTo: r.emailVerificationSentTo });
    await refresh();
    setStage('EMAIL');
  });
  const verifyEmail = useAction(async () => { await api.post('/api/auth/customer/email/verify', { challengeId: emailCh!.id, code: emailCode }); await refresh(); nav('/portal', { replace: true }); });
  const resendEmail = () => api.post('/api/auth/customer/email/send').then((r: any) => setEmailCh({ id: r.challengeId, sentTo: r.sentTo }));

  const idx = STAGES.findIndex(([s]) => s === stage);
  return (
    <AuthLayout heading="Set up Gazelle for your business." text="We verify your business against the Bank's records. Your registered details come directly from core banking, so you do not need to re-enter them.">
      <ol className="stepper" aria-label="Onboarding progress" style={{ marginBottom: 24 }}>
        {STAGES.map(([s, l], i) => <li key={s} className={i < idx ? 'done' : i === idx ? 'current' : ''} aria-current={i === idx ? 'step' : undefined}>{l}</li>)}
      </ol>

      {stage === 'ACCOUNT' && (
        <form className="stack" onSubmit={(e) => { e.preventDefault(); void start.run(); }}>
          <div><h2>Your business account</h2><p className="muted">Enter your Alternative Bank business account number (NUBAN).</p></div>
          <ErrorAlert error={start.error} />
          <TextInput label="Account number" inputMode="numeric" maxLength={10} required autoFocus value={account} onChange={(e) => setAccount(e.target.value.replace(/\D/g, '').slice(0, 10))} hint="10 digits. A code will be sent to the mobile number registered on the account." error={fieldError(start.error, 'accountNumber')} />
          <Button type="submit" variant="primary" size="lg" loading={start.loading} disabled={account.length !== 10}>Continue</Button>
          <p className="small muted">Already set up? <Link to="/login">Sign in</Link></p>
        </form>
      )}

      {stage === 'OTP' && (
        <form className="stack" onSubmit={(e) => { e.preventDefault(); void verify.run(); }}>
          <div><h2>Verify it’s you</h2><p className="muted">We sent a 6-digit code by SMS to <strong>{sentTo}</strong>, the number on your account record.</p></div>
          <OtpField value={code} onChange={setCode} error={otpErrorMessage(verify.error)} />
          <Button type="submit" variant="primary" size="lg" loading={verify.loading} disabled={code.length !== 6}>Verify</Button>
          <div className="row between">
            <Button variant="ghost" size="sm" onClick={() => { setStage('ACCOUNT'); setCode(''); }}>Change account number</Button>
            <ResendButton onResend={resend} />
          </div>
          <p className="xs muted">No longer have this number? Contact your relationship manager to update the account record before continuing.</p>
        </form>
      )}

      {stage === 'DETAILS' && verified && (
        <form className="stack" onSubmit={(e) => { e.preventDefault(); void complete.run(); }}>
          <div><h2>Confirm your business</h2><p className="muted">These details are held on the Bank's core banking record and cannot be edited here.</p></div>
          {verified.alreadyOnGazelle && <Alert tone="info" title="Your business is already on Gazelle">You will be added as an additional user for this business. If you already have access, <Link to="/login">sign in</Link> instead.</Alert>}
          <div className="panel"><div className="panel-body">
            <KV items={[
              ['Business name', <strong key="n">{verified.business.name}</strong>],
              ['RC number', verified.business.rcNumber],
              ['TIN', verified.business.tin],
              ['Incorporated', date(verified.business.incorporationDate)],
              ['Registered address', verified.business.address || '—'],
              ['Accounts', verified.business.accounts.map((a) => `${a.account} · ${a.currency} · ${a.product}`).join('\n')],
            ]} />
            <p className="xs muted" style={{ marginTop: 10, marginBottom: 0 }}>Something wrong? Contact your relationship manager; changes must be made on the account record.</p>
          </div></div>
          <h3>Your details</h3>
          <ErrorAlert error={complete.error && !Array.isArray((complete.error as any).details) ? complete.error : null} />
          <TextInput label="Full name" required autoComplete="name" value={form.fullName} onChange={(e) => setForm({ ...form, fullName: e.target.value })} error={fieldError(complete.error, 'fullName')} />
          <TextInput label="Work email" type="email" required autoComplete="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} hint="You will use this to sign in. We will send a code to verify it." error={fieldError(complete.error, 'email')} />
          <TextInput label="Designation" required placeholder="e.g. Chief Financial Officer" value={form.designation} onChange={(e) => setForm({ ...form, designation: e.target.value })} error={fieldError(complete.error, 'designation')} />
          {verified.terms ? (
            <>
              <Field label={`Terms of use (version ${verified.terms.version})`}>{() => <div className="panel small" style={{ maxHeight: 140, overflowY: 'auto', padding: 12 }} tabIndex={0}>{verified.terms!.termsText}</div>}</Field>
              <Check label="I have read and accept the terms of use, and I am authorised to act for this business." checked={form.acceptTerms} onChange={(e) => setForm({ ...form, acceptTerms: e.target.checked })} />
              <Field label="Privacy notice">{() => <div className="panel small" style={{ maxHeight: 140, overflowY: 'auto', padding: 12 }} tabIndex={0}>{verified.terms!.privacyText}</div>}</Field>
              <Check label="I consent to the processing of personal data described in the privacy notice (NDPA 2023)." checked={form.privacyConsent} onChange={(e) => setForm({ ...form, privacyConsent: e.target.checked })} />
            </>
          ) : <Alert tone="warn">The terms are temporarily unavailable. Please try again shortly.</Alert>}
          <Button type="submit" variant="primary" size="lg" loading={complete.loading} disabled={!verified.terms || !form.acceptTerms || !form.privacyConsent || !form.fullName || !form.email || !form.designation}>Create access</Button>
        </form>
      )}

      {stage === 'EMAIL' && emailCh && (
        <form className="stack" onSubmit={(e) => { e.preventDefault(); void verifyEmail.run(); }}>
          <div><h2>Verify your email</h2><p className="muted">Your access is set up. We sent a code to <strong>{emailCh.sentTo}</strong>. You must verify your email before submitting a facility request.</p></div>
          <OtpField value={emailCode} onChange={setEmailCode} error={otpErrorMessage(verifyEmail.error)} />
          <Button type="submit" variant="primary" size="lg" loading={verifyEmail.loading} disabled={emailCode.length !== 6}>Verify email</Button>
          <div className="row between">
            <Button variant="ghost" size="sm" onClick={() => nav('/portal')}>Do this later</Button>
            <ResendButton onResend={resendEmail} />
          </div>
        </form>
      )}
    </AuthLayout>
  );
}
