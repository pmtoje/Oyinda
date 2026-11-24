import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../../lib/api';
import { useAuth } from '../../../lib/auth';
import { dateTime } from '../../../lib/format';
import { Alert, Button, Drawer, Empty, ErrorAlert, Loading, Panel, Status, TextArea, useAction } from '../../../components/ui';

const ACTION_LABEL: Record<string, string> = { CREATE: 'New user', UPDATE: 'Changes', NO_CHANGE: 'No change', ERROR: 'Error' };
const STATUS_LABEL: Record<string, string> = { INVALID: 'Has errors', PENDING_APPROVAL: 'Awaiting approval', APPLIED: 'Applied', REJECTED: 'Rejected', WITHDRAWN: 'Withdrawn' };

/** Staff directory by spreadsheet: the interim substitute for Active Directory synchronisation. */
export function StaffImport() {
  const qc = useQueryClient();
  const { me } = useAuth();
  const list = useQuery({ queryKey: ['admin', 'user-imports'], queryFn: () => api.get<any[]>('/api/admin/user-imports') });
  const [file, setFile] = useState<File | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: ['admin', 'user-imports'] }), qc.invalidateQueries({ queryKey: ['admin', 'users'] })]);
  const up = useAction(async () => { const r = await api.upload<any>('/api/admin/user-imports', file!); setFile(null); await refresh(); setOpen(r.id); });
  return (
    <div className="stack">
      <Alert tone="info" title="Interim staff directory">
        Until Active Directory synchronisation is connected, staff, roles, reporting lines, personal approval limits and sectors are loaded from a spreadsheet.
        For each person in the file, the Roles column is their complete set of roles; people not in the file are not changed. Nothing is applied until a second administrator approves the upload.
      </Alert>
      <Panel title="Upload a staff list" actions={<a className="btn sm" href="/api/admin/user-imports/template.xlsx" download>Download template</a>}>
        <form className="row" onSubmit={(e) => { e.preventDefault(); void up.run(); }}>
          <div className="field" style={{ flex: 1 }}><label htmlFor="staff-file">Spreadsheet (.xlsx or .csv, up to 5 MB)</label><input id="staff-file" type="file" className="input" accept=".xlsx,.csv" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></div>
          <Button type="submit" variant="primary" disabled={!file} loading={up.loading}>Validate file</Button>
        </form>
        <ErrorAlert error={up.error} />
      </Panel>
      <Panel title="Uploads" flush>
        {list.isLoading ? <Loading /> : list.error ? <ErrorAlert error={list.error} /> : !list.data?.length ? <Empty title="No staff lists uploaded yet" /> : (
          <div className="table-wrap"><table className="data"><thead><tr><th>File</th><th>Uploaded</th><th className="num">Rows</th><th className="num">New</th><th className="num">Changed</th><th className="num">Errors</th><th>Status</th><th /></tr></thead>
            <tbody>{list.data.map((b) => (
              <tr key={b.id}><td className="primary-cell">{b.filename}</td><td className="small">{b.maker} · {dateTime(b.createdAt)}</td><td className="num">{b.rowCount}</td><td className="num">{b.summary.create}</td><td className="num">{b.summary.update}</td><td className="num">{b.summary.errors}</td>
                <td><Status value={b.status === 'APPLIED' ? 'OK' : b.status === 'INVALID' ? 'FAILED' : b.status === 'PENDING_APPROVAL' ? 'PENDING' : b.status} label={STATUS_LABEL[b.status]} /></td>
                <td className="num"><Button size="sm" onClick={() => setOpen(b.id)}>Review</Button></td></tr>))}</tbody></table></div>
        )}
      </Panel>
      {open && <ImportDrawer id={open} myId={me?.user?.id} onClose={() => setOpen(null)} onDone={async () => { setOpen(null); await refresh(); }} />}
    </div>
  );
}

function ImportDrawer({ id, myId, onClose, onDone }: { id: string; myId?: string; onClose: () => void; onDone: () => void }) {
  const q = useQuery({ queryKey: ['admin', 'user-import', id], queryFn: () => api.get<any>(`/api/admin/user-imports/${id}`) });
  const [note, setNote] = useState('');
  const [only, setOnly] = useState<'ALL' | 'CHANGES' | 'ERROR'>('CHANGES');
  const decide = useAction(async (decision: 'APPROVE' | 'REJECT') => { await api.post(`/api/admin/user-imports/${id}/decide`, { decision, note: note || undefined }); onDone(); });
  const withdraw = useAction(async () => { await api.post(`/api/admin/user-imports/${id}/withdraw`); onDone(); });
  const b = q.data;
  const mine = b && b.makerId === myId;
  const rows = (b?.preview ?? []).filter((p: any) => only === 'ALL' || (only === 'ERROR' ? p.action === 'ERROR' : p.action !== 'NO_CHANGE'));
  return (
    <Drawer title={b ? `Staff list — ${b.filename}` : 'Staff list'} onClose={onClose}
      footer={b && (b.status === 'PENDING_APPROVAL' || b.status === 'INVALID') && <>
        {mine && <Button onClick={() => withdraw.run()} loading={withdraw.loading}>Withdraw</Button>}
        {b.status === 'PENDING_APPROVAL' && !mine && <><Button variant="danger" onClick={() => decide.run('REJECT')} loading={decide.loading}>Reject</Button><Button variant="primary" onClick={() => decide.run('APPROVE')} loading={decide.loading}>Approve and apply</Button></>}
      </>}>
      {q.isLoading ? <Loading /> : q.error ? <ErrorAlert error={q.error} /> : (
        <div className="stack">
          {b.status === 'INVALID' && <Alert tone="danger" title={`${b.summary.errors} row(s) need correcting`}>Correct the rows below in the spreadsheet and upload it again. A file with errors cannot be applied.</Alert>}
          {b.status === 'PENDING_APPROVAL' && (mine ? <Alert tone="info">Another administrator must review and approve this upload.</Alert> : <Alert tone="warn" title="Review before approving">{b.summary.create} new user(s), {b.summary.update} changed{b.summary.privilegedChanges ? `, including ${b.summary.privilegedChanges} with privileged (administrator) access` : ''}. Changed users are signed out so their new access applies at the next sign-in.</Alert>)}
          {b.status === 'APPLIED' && <Alert tone="ok" title="Applied">{b.checker} approved on {dateTime(b.decidedAt)}{b.decisionNote ? ` — ${b.decisionNote}` : ''}.</Alert>}
          <div className="row">{(['CHANGES', 'ERROR', 'ALL'] as const).map((k) => <Button key={k} size="sm" variant={only === k ? 'primary' : undefined} onClick={() => setOnly(k)}>{k === 'CHANGES' ? 'Changes' : k === 'ERROR' ? 'Errors' : 'All rows'}</Button>)}</div>
          {!rows.length ? <Empty title="Nothing to show" /> : (
            <div className="table-wrap"><table className="data"><thead><tr><th className="num">Row</th><th>Username</th><th>Result</th><th>Details</th></tr></thead>
              <tbody>{rows.map((p: any) => (
                <tr key={p.rowNo}><td className="num mono small">{p.rowNo}</td><td className="small"><span className="mono">{p.username || '—'}</span><div className="xs muted">{p.name}</div></td>
                  <td><Status value={p.action === 'ERROR' ? 'FAILED' : p.action === 'NO_CHANGE' ? 'INACTIVE' : 'OK'} label={ACTION_LABEL[p.action]} />{p.privileged && <div className="xs muted">Privileged</div>}</td>
                  <td className="small"><ul style={{ margin: 0, paddingLeft: 16 }}>{[...p.errors, ...p.changes].map((x: string, i: number) => <li key={i}>{x}</li>)}</ul></td></tr>))}</tbody></table></div>
          )}
          {b.status === 'PENDING_APPROVAL' && !mine && <TextArea label="Note (optional)" rows={2} value={note} onChange={(e) => setNote(e.target.value)} />}
          <ErrorAlert error={decide.error ?? withdraw.error} />
        </div>
      )}
    </Drawer>
  );
}
