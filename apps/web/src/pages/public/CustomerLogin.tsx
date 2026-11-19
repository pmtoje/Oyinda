import { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { AuthLayout } from '../../components/Shells';
import { Alert, Button, ErrorAlert, TextInput, useAction } from '../../components/ui';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { OtpField, ResendButton, otpErrorMessage } from './parts/OtpField';

export default function CustomerLogin() {
  const nav = useNavigate();
  const loc = useLocation() as { state?: { from?: string } };
  const { refresh } = useAuth();
  const [email, setEmail] = useState('');
  const [challenge, setChallenge] = useState<{ challengeId: string; message: string } | null>(null);
  const [code, setCode] = useState('');
  const start = useAction(async () => { setChallenge(await api.post('/api/auth/customer/login/start', { email })); setCode(''); });
  const verify = useAction(async () => {
    await api.post('/api/auth/customer/login/verify', { email, challengeId: challenge!.challengeId, code });
    await refresh();
    nav(loc.state?.from?.startsWith('/portal') ? loc.state.from : '/portal', { replace: true });
  });
  return (
    <AuthLayout heading="Welcome back." text="Sign in with your registered email. We will send a one-time code to the mobile number on your Alternative Bank record.">
      {!challenge ? (
        <form className="stack" onSubmit={(e) => { e.preventDefault(); void start.run(); }}>
          <div><h2>Sign in</h2><p className="muted">Customer portal</p></div>
          <ErrorAlert error={start.error} />
          <TextInput label="Email address" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          <Button type="submit" variant="primary" size="lg" loading={start.loading} disabled={!email}>Send sign-in code</Button>
          <p className="small muted">New to Gazelle? <Link to="/">Set up access</Link></p>
        </form>
      ) : (
        <form className="stack" onSubmit={(e) => { e.preventDefault(); void verify.run(); }}>
          <div><h2>Enter your code</h2><p className="muted">{challenge.message}</p></div>
          {verify.error && (verify.error as any).status === 423 ? <Alert tone="danger" title="Sign-in locked">{(verify.error as any).message}</Alert> : null}
          <OtpField value={code} onChange={setCode} error={verify.error && (verify.error as any).status !== 423 ? otpErrorMessage(verify.error) : undefined} />
          <Button type="submit" variant="primary" size="lg" loading={verify.loading} disabled={code.length !== 6}>Sign in</Button>
          <div className="row between">
            <Button variant="ghost" size="sm" onClick={() => { setChallenge(null); setCode(''); }}>Use a different email</Button>
            <ResendButton onResend={() => start.run()} />
          </div>
        </form>
      )}
    </AuthLayout>
  );
}
