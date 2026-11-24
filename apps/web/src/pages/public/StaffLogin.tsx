import { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { AuthLayout } from '../../components/Shells';
import { Alert, Button, ErrorAlert, TextInput, useAction } from '../../components/ui';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { SignedOutNotice } from '../../lib/session-timeout';
import { OtpField } from './parts/OtpField';

export default function StaffLogin() {
  const nav = useNavigate();
  const loc = useLocation() as { state?: { from?: string; reason?: string } };
  const { refresh, meta } = useAuth();
  const local = meta?.staffAuthMode === 'local';
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [mfa, setMfa] = useState<{ mfa: 'ENROL' | 'VERIFY'; enrolment?: { secret: string; uri: string } } | null>(null);
  const [code, setCode] = useState('');
  const login = useAction(async () => { const r = await api.post('/api/auth/staff/login', { username, password }); setPassword(''); setMfa(r); });
  const verify = useAction(async () => {
    await api.post('/api/auth/staff/mfa/verify', { code });
    await refresh();
    const from = loc.state?.from;
    nav(from && (from.startsWith('/work') || from.startsWith('/admin')) ? from : '/work', { replace: true });
  });
  return (
    <AuthLayout heading="Credit360 staff workspace." text={local ? 'Sign in with your Credit360 username and password. A second factor from your authenticator app is required.' : 'Sign in with your Alternative Bank network (Active Directory) credentials. A second factor from your authenticator app is required.'}>
      {!mfa ? (
        <form className="stack" onSubmit={(e) => { e.preventDefault(); void login.run(); }}>
          <div><h2>Staff sign-in</h2><p className="muted">Restricted to authorised Alternative Bank staff. Activity is logged.</p></div>
          <SignedOutNotice reason={loc.state?.reason} />
          <ErrorAlert error={login.error} />
          {local && <Alert tone="info">Interim sign-in until Active Directory is connected: use the Credit360 password you set from your activation e-mail.</Alert>}
          <TextInput label={local ? 'Username' : 'Network username'} autoComplete="username" required value={username} onChange={(e) => setUsername(e.target.value)} />
          <TextInput label={local ? 'Credit360 password' : 'Password'} type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
          <Button type="submit" variant="primary" size="lg" loading={login.loading} disabled={!username || !password}>Continue</Button>
          {local && <p className="small muted"><Link to="/staff/forgot-password">Forgotten your password?</Link></p>}
        </form>
      ) : (
        <form className="stack" onSubmit={(e) => { e.preventDefault(); void verify.run(); }}>
          {mfa.mfa === 'ENROL' && mfa.enrolment ? (
            <>
              <div><h2>Set up your authenticator</h2><p className="muted">Multi-factor authentication is required for all staff. This is a one-time setup.</p></div>
              <ol className="small" style={{ paddingLeft: 18, margin: 0 }}>
                <li>Open the Bank-approved authenticator app on your work phone.</li>
                <li>Choose <strong>Add account</strong> → <strong>Enter a setup key</strong>, account name “Credit360”, time-based.</li>
                <li>Enter the key below, then type the 6-digit code the app shows.</li>
              </ol>
              <div className="panel"><div className="panel-body">
                <div className="xs muted">Setup key</div>
                <div className="mono" style={{ fontSize: '1.05rem', letterSpacing: '0.08em', wordBreak: 'break-all' }} aria-label="Setup key">{mfa.enrolment.secret.match(/.{1,4}/g)?.join(' ')}</div>
                <details className="small" style={{ marginTop: 8 }}><summary>Show full setup link</summary><div className="mono xs" style={{ wordBreak: 'break-all' }}>{mfa.enrolment.uri}</div></details>
              </div></div>
              <Alert tone="warn">Do not share this key. If you are not setting up a new device, stop and contact Information Security.</Alert>
            </>
          ) : (
            <div><h2>Verification code</h2><p className="muted">Enter the 6-digit code from your authenticator app.</p></div>
          )}
          <OtpField value={code} onChange={setCode} label="Authenticator code" error={verify.error ? (verify.error as any).message : undefined} />
          <Button type="submit" variant="primary" size="lg" loading={verify.loading} disabled={code.length !== 6}>Verify and continue</Button>
          <Button variant="ghost" size="sm" onClick={() => { setMfa(null); setCode(''); }}>Start again</Button>
        </form>
      )}
    </AuthLayout>
  );
}
