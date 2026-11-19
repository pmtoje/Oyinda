import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { Button, Drawer, ErrorAlert, SelectInput, TextInput, useAction } from './ui';

/** SWR §2: retrieve an Alternative Bank statement directly from core banking (owner-checked on the server). */
export function SpoolStatementButton({ facilityId, onDone }: { facilityId: string; onDone: () => unknown }) {
  const [open, setOpen] = useState(false);
  const today = new Date();
  const end = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 0)).toISOString().slice(0, 10);
  const start = new Date(Date.UTC(today.getUTCFullYear() - 1, today.getUTCMonth(), 1)).toISOString().slice(0, 10);
  const [m, setM] = useState({ accountNumber: '', periodStart: start, periodEnd: end });
  const accounts = useQuery({ queryKey: ['altbank-accounts', facilityId], queryFn: () => api.get<any[]>(`/api/facilities/${facilityId}/altbank-accounts`), enabled: open });
  const go = useAction(async () => { await api.post(`/api/facilities/${facilityId}/bank-statements/spool`, m); setOpen(false); await onDone(); });
  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>Retrieve Alternative Bank statement</Button>
      {open && (
        <Drawer title="Retrieve statement from Alternative Bank" onClose={() => setOpen(false)} footer={<><Button onClick={() => setOpen(false)}>Cancel</Button><Button variant="primary" loading={go.loading} disabled={!m.accountNumber || !m.periodStart || !m.periodEnd} onClick={() => go.run()}>Retrieve</Button></>}>
          <div className="stack">
            <p className="small muted">Statements for your Alternative Bank accounts are retrieved directly from the Bank’s records — no upload needed. Statements from other banks must still be uploaded.</p>
            <SelectInput label="Account" placeholder="Select an account" value={m.accountNumber} onChange={(e) => setM({ ...m, accountNumber: e.target.value })} options={(accounts.data ?? []).map((a) => ({ value: a.accountNumber, label: `${a.accountNumber} · ${a.currency} · ${a.product ?? a.accountName}` }))} />
            <TextInput label="From" type="date" value={m.periodStart} onChange={(e) => setM({ ...m, periodStart: e.target.value })} />
            <TextInput label="To" type="date" value={m.periodEnd} onChange={(e) => setM({ ...m, periodEnd: e.target.value })} hint="Up to 12 months per statement." />
            <ErrorAlert error={go.error ?? accounts.error} />
          </div>
        </Drawer>
      )}
    </>
  );
}
