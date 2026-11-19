import { useState } from 'react';
import { Alert, Button, useAction } from '../../../components/ui';
import { api } from '../../../lib/api';
import { useAuth } from '../../../lib/auth';
import { OtpField, otpErrorMessage } from '../../public/parts/OtpField';

export function EmailVerifyCard() {
  const { refresh } = useAuth();
  const [ch, setCh] = useState<{ challengeId: string; sentTo: string } | null>(null);
  const [code, setCode] = useState('');
  const send = useAction(async () => setCh(await api.post('/api/auth/customer/email/send')));
  const verify = useAction(async () => { await api.post('/api/auth/customer/email/verify', { challengeId: ch!.challengeId, code }); await refresh(); });
  return (
    <Alert tone="warn" title="Verify your email address">
      <p>You must verify your email before you can submit a facility request.</p>
      {!ch ? <Button size="sm" onClick={() => send.run()} loading={send.loading}>Send verification code</Button> : (
        <form className="stack" style={{ ['--gap' as any]: '8px' }} onSubmit={(e) => { e.preventDefault(); void verify.run(); }}>
          <span className="small">Code sent to {ch.sentTo}.</span>
          <OtpField value={code} onChange={setCode} error={otpErrorMessage(verify.error)} autoFocus />
          <div><Button type="submit" size="sm" variant="primary" disabled={code.length !== 6} loading={verify.loading}>Verify</Button></div>
        </form>
      )}
      {send.error ? <div className="small">{(send.error as any).message}</div> : null}
    </Alert>
  );
}
