import { useState } from 'react';
import { Link } from 'react-router-dom';
import { AuthLayout } from '../../components/Shells';
import { Alert, Button, ErrorAlert, TextInput, useAction } from '../../components/ui';
import { api } from '../../lib/api';

export default function StaffForgotPassword() {
  const [username, setUsername] = useState('');
  const [done, setDone] = useState<string | null>(null);
  const go = useAction(async () => setDone((await api.post<any>('/api/auth/staff/password/forgot', { username })).message));
  return (
    <AuthLayout heading="Reset your Gazelle password." text="A single-use link is sent to the work e-mail address the Bank holds for you. Nobody at the Bank will ask for your password.">
      {done ? <Alert tone="ok" title="Check your work e-mail">{done} The link is valid for one hour. <Link to="/staff/login">Back to sign-in</Link></Alert> : (
        <form className="stack" onSubmit={(e) => { e.preventDefault(); void go.run(); }}>
          <div><h2>Forgotten password</h2></div>
          <ErrorAlert error={go.error} />
          <TextInput label="Username" autoComplete="username" required value={username} onChange={(e) => setUsername(e.target.value)} />
          <Button type="submit" variant="primary" size="lg" loading={go.loading} disabled={!username}>Send reset link</Button>
          <p className="small muted"><Link to="/staff/login">Back to sign-in</Link></p>
        </form>
      )}
    </AuthLayout>
  );
}
