import { useState } from 'react';
import { Alert, Button, useAction } from '../../../components/ui';
import { api } from '../../../lib/api';

export function EmailVerifyCard() {
  const [sentTo, setSentTo] = useState<string | null>(null);
  const send = useAction(async () => setSentTo((await api.post<any>('/api/auth/customer/email/send')).sentTo));
  return (
    <Alert tone="warn" title="Confirm your e-mail address">
      <p>Open the link in the welcome e-mail we sent to your company e-mail address. You must confirm it before you can submit a facility request.</p>
      {sentTo ? <span className="small">A new link has been sent to {sentTo}.</span> : <Button size="sm" onClick={() => send.run()} loading={send.loading}>Send a new link</Button>}
      {send.error ? <div className="small">{(send.error as any).message}</div> : null}
    </Alert>
  );
}
