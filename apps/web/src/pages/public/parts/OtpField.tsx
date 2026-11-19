import { useEffect, useState } from 'react';
import { Button, Field } from '../../../components/ui';

/** Six-digit one-time code input with an optional resend countdown. */
export function OtpField({ value, onChange, error, label = 'Enter the 6-digit code', autoFocus = true }: { value: string; onChange: (v: string) => void; error?: string; label?: string; autoFocus?: boolean }) {
  return (
    <Field label={label} error={error} required hint="The code expires after a few minutes. Never share it with anyone, including Bank staff.">
      {(id, d) => (
        <input id={id} className="input otp" inputMode="numeric" autoComplete="one-time-code" maxLength={6} pattern="[0-9]{6}" autoFocus={autoFocus}
          aria-invalid={!!error} aria-describedby={d} value={value} onChange={(e) => onChange(e.target.value.replace(/\D/g, '').slice(0, 6))} />
      )}
    </Field>
  );
}

export function ResendButton({ onResend, seconds = 30 }: { onResend: () => Promise<unknown>; seconds?: number }) {
  const [left, setLeft] = useState(seconds);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (left <= 0) return;
    const t = setTimeout(() => setLeft(left - 1), 1000);
    return () => clearTimeout(t);
  }, [left]);
  return (
    <Button variant="ghost" size="sm" disabled={left > 0} loading={busy} onClick={async () => { setBusy(true); try { await onResend(); setLeft(seconds); } finally { setBusy(false); } }}>
      {left > 0 ? `Resend code in ${left}s` : 'Resend code'}
    </Button>
  );
}

export function otpErrorMessage(e: any): string | undefined {
  if (!e) return undefined;
  const remaining = e?.details?.remainingAttempts;
  return remaining !== undefined ? `${e.message} ${remaining} attempt${remaining === 1 ? '' : 's'} remaining.` : e.message;
}
