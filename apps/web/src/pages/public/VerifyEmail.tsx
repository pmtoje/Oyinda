import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { AuthLayout } from '../../components/Shells';
import { Alert, Loading } from '../../components/ui';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';

/** Target of the link in the welcome e-mail. The token is single-use and is removed from the address bar. */
export default function VerifyEmail() {
  const [sp, setSp] = useSearchParams();
  const { refresh, me } = useAuth();
  const [state, setState] = useState<'pending' | 'ok' | 'failed'>('pending');
  const ran = useRef(false);
  const [token] = useState(() => sp.get('token') ?? '');
  useEffect(() => {
    // Wait for the session probe: a signed-in browser must send its CSRF token with the request.
    if (ran.current || me === undefined) return;
    ran.current = true;
    setSp({}, { replace: true });
    api.post('/api/auth/customer/email/verify-link', { token }).then(async () => { setState('ok'); await refresh(); }).catch(() => setState('failed'));
  }, [me]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <AuthLayout heading="Confirm your e-mail." text="This confirms the company e-mail address you use to sign in to Credit360.">
      {state === 'pending' && <Loading rows={2} />}
      {state === 'ok' && <Alert tone="ok" title="E-mail address confirmed">You can now submit facility requests. {me?.type === 'CUSTOMER' ? <Link to="/portal">Go to your dashboard</Link> : <Link to="/login">Sign in to the portal</Link>}</Alert>}
      {state === 'failed' && <Alert tone="danger" title="This link is invalid or has expired">Sign in and request a new verification link from your dashboard. <Link to="/login">Sign in</Link></Alert>}
    </AuthLayout>
  );
}
