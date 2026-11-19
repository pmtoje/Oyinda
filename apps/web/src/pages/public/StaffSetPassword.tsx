import { useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { AuthLayout } from '../../components/Shells';
import { Alert, Button, Drawer, ErrorAlert, Loading, TextInput, useAction } from '../../components/ui';
import { api } from '../../lib/api';

interface Policy { minLength: number; maxLength: number; requireUpper: boolean; requireLower: boolean; requireDigit: boolean; requireSymbol: boolean; disallowPersonalInfo: boolean; maxAgeDays: number; historyCount: number }

/** Client mirror of the server rules for immediate feedback; the server checks every rule again. */
function unmet(p: Policy, pw: string) {
  const out: string[] = [];
  if (pw.length < p.minLength) out.push(`At least ${p.minLength} characters`);
  if (pw.length > p.maxLength) out.push(`No more than ${p.maxLength} characters`);
  if (p.requireUpper && !/[A-Z]/.test(pw)) out.push('At least one upper-case letter');
  if (p.requireLower && !/[a-z]/.test(pw)) out.push('At least one lower-case letter');
  if (p.requireDigit && !/[0-9]/.test(pw)) out.push('At least one number');
  if (p.requireSymbol && !/[^A-Za-z0-9]/.test(pw)) out.push('At least one special character');
  return out;
}

/** Target of the activation and reset e-mails (interim staff sign-in). The token is removed from the address bar. */
export default function StaffSetPassword() {
  const [sp, setSp] = useSearchParams();
  const tokenRef = useRef(sp.get('token') ?? '');
  const token = tokenRef.current;
  const info = useQuery({ queryKey: ['staff-link'], queryFn: async () => { const r = await api.get<any>(`/api/auth/staff/password/link?token=${encodeURIComponent(token)}`); setSp({}, { replace: true }); return r; }, retry: false, staleTime: Infinity });
  const [pw, setPw] = useState(''); const [confirm, setConfirm] = useState('');
  const [popup, setPopup] = useState<string[] | null>(null);
  const [done, setDone] = useState(false);
  const issues = useMemo(() => (info.data ? unmet(info.data.policy, pw) : []), [info.data, pw]);
  const save = useAction(async () => {
    try { await api.post('/api/auth/staff/password/set', { token, password: pw }); setDone(true); }
    catch (e: any) { if (e?.code === 'PASSWORD_POLICY') { setPopup(e.details?.unmet ?? [e.message]); return; } throw e; }
  });
  const submit = () => { if (issues.length) return setPopup(issues); if (pw !== confirm) return setPopup(['The two passwords do not match']); void save.run(); };
  return (
    <AuthLayout heading="Set your Gazelle password." text="Interim staff sign-in until Active Directory is connected. You will set up your authenticator app at your first sign-in.">
      {info.isLoading ? <Loading rows={3} /> : info.error ? (
        <Alert tone="danger" title="This link is invalid or has expired">Ask for a new link from the <Link to="/staff/forgot-password">password reset page</Link> or from your administrator.</Alert>
      ) : done ? (
        <Alert tone="ok" title="Password set">Sign in with username <strong className="mono">{info.data.username}</strong> and your new password. <Link to="/staff/login">Go to sign-in</Link></Alert>
      ) : (
        <form className="stack" onSubmit={(e) => { e.preventDefault(); submit(); }}>
          <div><h2>{info.data.purpose === 'ACTIVATE' ? 'Activate your account' : 'Choose a new password'}</h2><p className="muted">Username: <span className="mono">{info.data.username}</span></p></div>
          <TextInput label="New password" type="password" autoComplete="new-password" required value={pw} onChange={(e) => setPw(e.target.value)} />
          <ul className="checklist small" aria-label="Password requirements">
            {unmet(info.data.policy, '').map((r) => <li key={r} className={issues.includes(r) ? '' : 'ok'}>{r}</li>)}
            {info.data.policy.disallowPersonalInfo && <li>Must not contain your name, username or e-mail address</li>}
            {info.data.policy.historyCount > 0 && <li>Must not be one of your last {info.data.policy.historyCount} passwords</li>}
          </ul>
          <TextInput label="Confirm new password" type="password" autoComplete="new-password" required value={confirm} onChange={(e) => setConfirm(e.target.value)} />
          {info.data.policy.maxAgeDays > 0 && <p className="xs muted">Passwords must be changed every {info.data.policy.maxAgeDays} days.</p>}
          <ErrorAlert error={save.error} />
          <Button type="submit" variant="primary" size="lg" loading={save.loading} disabled={!pw || !confirm}>Set password</Button>
        </form>
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
