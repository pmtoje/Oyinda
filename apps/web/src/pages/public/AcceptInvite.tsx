import { useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { AuthLayout } from '../../components/Shells';
import { Alert, Button, Check, Drawer, ErrorAlert, Field, Loading, TextInput, fieldError, useAction } from '../../components/ui';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { OtpField, ResendButton, otpErrorMessage } from './parts/OtpField';

function unmet(p: any, pw: string): string[] {
  if (!p) return [];
  const out: string[] = [];
  if (pw.length < p.minLength) out.push(`At least ${p.minLength} characters`);
  if (p.requireUpper && !/[A-Z]/.test(pw)) out.push('At least one upper-case letter');
  if (p.requireLower && !/[a-z]/.test(pw)) out.push('At least one lower-case letter');
  if (p.requireDigit && !/[0-9]/.test(pw)) out.push('At least one number');
  if (p.requireSymbol && !/[^A-Za-z0-9]/.test(pw)) out.push('At least one special character');
  return out;
}

/** A colleague's invitation to join their business on Credit360. */
export default function AcceptInvite() {
  const [sp, setSp] = useSearchParams();
  const nav = useNavigate();
  const { refresh } = useAuth();
  const token = useRef(sp.get('token') ?? '').current;
  const info = useQuery({ queryKey: ['invite'], queryFn: async () => { const r = await api.get<any>(`/api/portal-invites?token=${encodeURIComponent(token)}`); setSp({}, { replace: true }); return r; }, retry: false, staleTime: Infinity });
  const [phone, setPhone] = useState(''); const [sentTo, setSentTo] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [f, setF] = useState({ password: '', confirm: '', acceptTerms: false, privacyConsent: false });
  const [popup, setPopup] = useState<string[] | null>(null);
  const issues = useMemo(() => unmet(info.data?.passwordPolicy, f.password), [info.data, f.password]);
  const sendCode = useAction(async () => { setSentTo((await api.post<any>('/api/portal-invites/phone', { token, phone })).otpSentTo); setCode(''); });
  const accept = useAction(async () => {
    try { await api.post('/api/portal-invites/accept', { token, code, password: f.password, acceptTerms: f.acceptTerms, privacyConsent: f.privacyConsent, termsVersion: info.data.terms?.version ?? '' }); await refresh(); nav('/portal', { replace: true }); }
    catch (e: any) { if (e?.code === 'PASSWORD_POLICY') { setPopup(e.details?.unmet ?? [e.message]); return; } throw e; }
  });
  const submit = () => { if (issues.length) return setPopup(issues); if (f.password !== f.confirm) return setPopup(['The two passwords do not match']); void accept.run(); };
  const d = info.data;
  return (
    <AuthLayout heading="Join your business on Credit360." text="A colleague has invited you. Verify your mobile number and set a password to get started.">
      {info.isLoading ? <Loading rows={3} /> : info.error ? (
        <Alert tone="danger" title="This invitation is invalid or has expired">Ask your colleague to send a new invitation. <Link to="/login">Sign in</Link></Alert>
      ) : (
        <div className="stack">
          <div><h2>{d.business}</h2><p className="muted">Invitation for <strong>{d.name}</strong> ({d.roleInCompany}) · username <span className="mono">{d.email}</span></p></div>
          {!sentTo ? (
            <form className="stack" onSubmit={(e) => { e.preventDefault(); void sendCode.run(); }}>
              <TextInput label="Your mobile number" inputMode="tel" autoComplete="tel" required value={phone} onChange={(e) => setPhone(e.target.value)} hint="Sign-in codes are sent here." error={fieldError(sendCode.error, 'phone')} />
              <ErrorAlert error={sendCode.error && !fieldError(sendCode.error, 'phone') ? sendCode.error : null} />
              <Button type="submit" variant="primary" size="lg" disabled={!phone} loading={sendCode.loading}>Send verification code</Button>
            </form>
          ) : (
            <form className="stack" onSubmit={(e) => { e.preventDefault(); submit(); }}>
              <p className="small muted">We sent a 6-digit code to <strong>{sentTo}</strong>.</p>
              <OtpField value={code} onChange={setCode} error={String((accept.error as any)?.code ?? '').startsWith('OTP_') ? otpErrorMessage(accept.error) : undefined} />
              <div className="row end"><ResendButton onResend={() => sendCode.run()} /></div>
              <TextInput label="Password" type="password" autoComplete="new-password" required value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} />
              <ul className="checklist small" aria-label="Password requirements">{unmet(d.passwordPolicy, '').map((r) => <li key={r} className={issues.includes(r) ? '' : 'ok'}>{r}</li>)}<li>Must not contain your name or e-mail address</li></ul>
              <TextInput label="Confirm password" type="password" autoComplete="new-password" required value={f.confirm} onChange={(e) => setF({ ...f, confirm: e.target.value })} />
              {d.terms && <>
                <Field label={`Terms and conditions (version ${d.terms.version})`}>{() => <div className="panel small" style={{ maxHeight: 120, overflowY: 'auto', padding: 12 }} tabIndex={0}>{d.terms.termsText}</div>}</Field>
                <Check label="I have read and accept the terms and conditions." checked={f.acceptTerms} onChange={(e) => setF({ ...f, acceptTerms: e.target.checked })} />
                <Field label="Data privacy terms">{() => <div className="panel small" style={{ maxHeight: 120, overflowY: 'auto', padding: 12 }} tabIndex={0}>{d.terms.privacyText}</div>}</Field>
                <Check label="I accept the data privacy terms (NDPA 2023)." checked={f.privacyConsent} onChange={(e) => setF({ ...f, privacyConsent: e.target.checked })} />
              </>}
              {accept.error && !String((accept.error as any)?.code ?? '').startsWith('OTP_') ? <ErrorAlert error={accept.error} /> : null}
              <Button type="submit" variant="primary" size="lg" loading={accept.loading} disabled={code.length !== 6 || !f.password || !f.confirm || !f.acceptTerms || !f.privacyConsent}>Join {d.business}</Button>
            </form>
          )}
        </div>
      )}
      {popup && (
        <Drawer center title="Your password needs attention" onClose={() => setPopup(null)} footer={<Button variant="primary" onClick={() => setPopup(null)}>Update password</Button>}>
          <p>Your password does not meet the Bank's requirements:</p><ul>{popup.map((x) => <li key={x}>{x}</li>)}</ul>
        </Drawer>
      )}
    </AuthLayout>
  );
}
