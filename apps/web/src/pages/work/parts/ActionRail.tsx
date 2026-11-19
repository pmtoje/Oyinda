import { useMemo, useState } from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import { api, idem } from '../../../lib/api';
import { useAuth } from '../../../lib/auth';
import { roleLabel, dateTime, humanize } from '../../../lib/format';
import { Alert, Button, Check, Drawer, ErrorAlert, Panel, SelectInput, Status, TextArea, TextInput, useAction } from '../../../components/ui';
import { SlaBadge, useRefresh } from './common';

const SECTIONS = ['DETAILS', 'PRODUCT_INFO', 'SECURITY', 'FINANCIALS', 'BANK_STATEMENTS', 'DOCUMENTS', 'PROFILE', 'OTHER'];
const ACTION_HELP: Record<string, string> = {
  APPROVE: 'Approve within your authority. The approved terms are frozen as a new version.',
  RECOMMEND: 'Recommend to the next authority in the route.',
  COMPLETE: 'Mark this stage complete. All prerequisites must be met.',
  DECLINE: 'Decline the request. A reason is required and is recorded permanently.',
  RETURN: 'Return for rework. Say exactly what needs attention.',
  REQUEST_CLARIFICATION: 'Ask a question without leaving Gazelle. The task stays with you.',
  COMMENT: 'Add a comment to the record without moving the task.',
  VOTE: 'Cast your committee vote. Each member votes once.',
  RECORD_DECISION: 'Record the decision taken at the committee meeting. Cite the signed minutes; the record is permanent.',
};

/** Pick the task this user should see: the one in the URL, else the first open task they can act on. */
export function useCurrentTask(facilityId: string, preferred?: string | null) {
  const wf = useQuery({ queryKey: ['fac', facilityId, 'workflow'], queryFn: () => api.get<any>(`/api/facilities/${facilityId}/workflow`) });
  const open = (wf.data?.tasks ?? []).filter((t: any) => ['OPEN', 'CLAIMED'].includes(t.status));
  const ids: string[] = preferred && open.some((t: any) => t.id === preferred) ? [preferred, ...open.filter((t: any) => t.id !== preferred).map((t: any) => t.id)] : open.map((t: any) => t.id);
  const details = useQueries({ queries: ids.map((id) => ({ queryKey: ['fac', facilityId, 'task', id], queryFn: () => api.get<any>(`/api/tasks/${id}`), retry: false })) });
  const loaded = details.map((d) => d.data).filter(Boolean);
  const actionable = loaded.find((t: any) => t.availableActions.some((a: any) => a.code !== 'RELEASE')) ?? loaded[0] ?? null;
  return { workflow: wf, task: actionable as any, openCount: open.length, loading: wf.isLoading || details.some((d) => d.isLoading) };
}

export function ActionRail({ facilityId, task, loading, openCount }: { facilityId: string; task: any; loading: boolean; openCount: number }) {
  const refresh = useRefresh(facilityId);
  const { can } = useAuth();
  const [action, setAction] = useState<string | null>(null);
  const [reassign, setReassign] = useState(false);
  const claim = useAction(async () => { await api.post(`/api/tasks/${task.id}/claim`); await refresh(); });
  const release = useAction(async () => { await api.post(`/api/tasks/${task.id}/release`); await refresh(); });

  if (loading) return <Panel title="Your task"><div className="skeleton" /></Panel>;
  if (!task) return <Panel title="Your task"><p className="small muted">{openCount ? 'Open tasks on this facility belong to other roles or officers.' : 'There is no open task on this facility.'}</p></Panel>;
  const codes: string[] = task.availableActions.map((a: any) => a.code);
  const decisionActions = task.availableActions.filter((a: any) => !['CLAIM', 'RELEASE'].includes(a.code));
  const unmet = (task.prerequisites ?? []).filter((p: any) => !p.met);

  return (
    <>
      <Panel title={task.stageName} actions={<SlaBadge sla={task.sla} />}>
        <div className="stack" style={{ ['--gap' as any]: '12px' }}>
          <div className="small muted">
            {humanize(task.taskType)} · role {roleLabel(task.role)}<br />
            {task.claimedBy ? <>With <strong>{task.claimedBy}</strong> since {dateTime(task.claimedAt)}</> : task.assignedTo ? <>Assigned to <strong>{task.assignedTo}</strong></> : 'Unclaimed, in the team queue'}
            {task.sla?.dueAt && <><br />Due {dateTime(task.sla.dueAt)}</>}
          </div>
          {task.authority?.limitMinor !== undefined && task.authority?.level && <div className="small">Authority level <strong>{task.authority.level}</strong>{task.authority.isFinal ? ' — final approver' : ' — recommends to the next level'}</div>}
          {task.onBehalfOf && <Alert tone="info">You are acting under delegated authority.</Alert>}
          {task.notes?.map((n: string, i: number) => <Alert key={i} tone="warn">{n}</Alert>)}
          {(task.prerequisites ?? []).length > 0 && (
            <div>
              <h4 style={{ marginBottom: 6 }}>Before you finish</h4>
              <ul className="vsteps">{task.prerequisites.map((p: any) => <li key={p.code} className={p.met ? 'done' : ''}><span className="small">{p.label}{!p.met && <span className="muted"> — outstanding</span>}</span></li>)}</ul>
            </div>
          )}
          {codes.includes('CLAIM') && <Button variant="primary" onClick={() => claim.run()} loading={claim.loading}>Claim task</Button>}
          <ErrorAlert error={claim.error ?? release.error} />
          {decisionActions.length > 0 && (
            <div className="stack" style={{ ['--gap' as any]: '8px' }}>
              {decisionActions.map((a: any) => (
                <Button key={a.code} variant={['APPROVE', 'RECOMMEND', 'COMPLETE', 'VOTE', 'RECORD_DECISION'].includes(a.code) ? 'primary' : a.code === 'DECLINE' ? 'danger' : undefined} className="block"
                  disabled={['APPROVE', 'RECOMMEND', 'COMPLETE'].includes(a.code) && unmet.length > 0} onClick={() => setAction(a.code)}
                  title={['APPROVE', 'RECOMMEND', 'COMPLETE'].includes(a.code) && unmet.length ? 'Complete the outstanding items first' : undefined}>{a.label}</Button>
              ))}
            </div>
          )}
          <div className="row">
            {codes.includes('RELEASE') && <Button size="sm" variant="ghost" onClick={() => release.run()} loading={release.loading}>Release to queue</Button>}
            {can('task.reassign') && task.taskType !== 'COMMITTEE' && <Button size="sm" variant="ghost" onClick={() => setReassign(true)}>Reassign</Button>}
          </div>
        </div>
      </Panel>
      {task.committee && <CommitteePanel c={task.committee} />}
      {action && <ActionDrawer facilityId={facilityId} task={task} action={action} onClose={() => setAction(null)} onDone={async () => { setAction(null); await refresh(); }} />}
      {reassign && <ReassignDrawer task={task} onClose={() => setReassign(false)} onDone={async () => { setReassign(false); await refresh(); }} />}
    </>
  );
}

function CommitteePanel({ c }: { c: any }) {
  const approvals = c.votes.filter((v: any) => v.vote === 'APPROVE').length;
  return (
    <Panel title={`${c.key} committee`} actions={<Status value={c.status === 'DECIDED' ? c.decision : 'OPEN'} />}>
      <div className="small stack" style={{ ['--gap' as any]: '8px' }}>
        <div>Quorum {c.rules.quorum} · approvals required {c.rules.requiredApprovals}{c.rules.requiredRoles?.length ? ` · must include ${c.rules.requiredRoles.join(', ')}` : ''} · {humanize(c.rules.voting)} voting</div>
        <div><strong>{c.votes.length}</strong> of {c.memberCount} members voted · <strong>{approvals}</strong> approve</div>
        {c.votes.length > 0 && <table className="data"><thead><tr><th>Member</th><th>Vote</th></tr></thead><tbody>{c.votes.map((v: any, i: number) => <tr key={i}><td>{v.member}<div className="xs muted">{roleLabel(v.role)} · {dateTime(v.at)}</div>{v.comment && <div className="xs">{v.comment}</div>}</td><td><Status value={v.vote === 'APPROVE' ? 'APPROVED' : v.vote === 'DECLINE' ? 'DECLINED' : 'PENDING'} label={humanize(v.vote)} /></td></tr>)}</tbody></table>}
      </div>
    </Panel>
  );
}

function ActionDrawer({ facilityId, task, action, onClose, onDone }: { facilityId: string; task: any; action: string; onClose: () => void; onDone: () => void }) {
  const [comment, setComment] = useState('');
  const [target, setTarget] = useState<string>(task.returnTargets?.[0] ?? 'PREVIOUS');
  const [items, setItems] = useState<{ section: string; message: string }[]>([{ section: 'DOCUMENTS', message: '' }]);
  const [conditions, setConditions] = useState<string[]>([]);
  const [vote, setVote] = useState('APPROVE');
  const [minutes, setMinutes] = useState('');
  const [toCustomer, setToCustomer] = useState(true);
  const [toUserId, setToUserId] = useState('');
  const [subject, setSubject] = useState('');
  const key = useMemo(() => idem(), []);
  const staff = useQuery({ queryKey: ['staff-directory'], queryFn: () => api.get<any[]>('/api/staff/directory'), retry: false, enabled: action === 'REQUEST_CLARIFICATION' });
  const submit = useAction(async () => {
    const body: any = { action, idempotencyKey: key, rowVersion: task.rowVersion };
    if (comment.trim()) body.comment = comment.trim();
    if (action === 'RETURN') { body.returnTarget = target; if (target === 'CUSTOMER') body.reworkItems = items.filter((i) => i.message.trim()); }
    if (action === 'VOTE' || action === 'RECORD_DECISION') body.vote = vote;
    if (action === 'RECORD_DECISION') body.minutesReference = minutes.trim();
    if (['APPROVE', 'RECOMMEND'].includes(action) && conditions.some((c) => c.trim())) body.conditions = conditions.filter((c) => c.trim());
    if (action === 'REQUEST_CLARIFICATION') body.clarification = { subject: subject.trim(), ...(toCustomer ? { toCustomer: true } : { toUserId }) };
    await api.post(`/api/tasks/${task.id}/actions`, body);
    onDone();
  });
  const needsComment = ['DECLINE', 'RETURN', 'REQUEST_CLARIFICATION', 'COMMENT', 'RECORD_DECISION'].includes(action) || (action === 'VOTE' && vote === 'DECLINE');
  const label = task.availableActions.find((a: any) => a.code === action)?.label ?? humanize(action);
  return (
    <Drawer title={`${label} — ${task.stageName}`} onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant={action === 'DECLINE' ? 'danger' : 'primary'} loading={submit.loading} onClick={() => submit.run()} disabled={(needsComment && comment.trim().length < 5) || (action === 'RECORD_DECISION' && minutes.trim().length < 3)}>{label}</Button></>}>
      <div className="stack">
        <p className="small muted">{ACTION_HELP[action]}</p>
        {action === 'RECORD_DECISION' && (
          <>
            <SelectInput label="Committee decision" value={vote} onChange={(e) => setVote(e.target.value)} options={[{ value: 'APPROVE', label: 'Approved' }, { value: 'DECLINE', label: 'Declined' }]} />
            <TextInput label="Minutes reference" value={minutes} onChange={(e) => setMinutes(e.target.value)} required hint="Reference of the signed minutes, e.g. MIC/2026/41." />
          </>
        )}
        {action === 'VOTE' && <SelectInput label="Your vote" value={vote} onChange={(e) => setVote(e.target.value)} options={[{ value: 'APPROVE', label: 'Approve' }, { value: 'DECLINE', label: 'Decline' }, { value: 'ABSTAIN', label: 'Abstain' }]} />}
        {action === 'RETURN' && (
          <>
            <SelectInput label="Return to" value={target} onChange={(e) => setTarget(e.target.value)} options={(task.returnTargets ?? ['PREVIOUS']).map((t: string) => ({ value: t, label: t === 'CUSTOMER' ? 'Customer (rework)' : t === 'RM' ? 'Relationship Manager' : 'Previous stage' }))} />
            {target === 'CUSTOMER' && (
              <div className="stack" style={{ ['--gap' as any]: '10px' }}>
                <h4>What the customer must address</h4>
                {items.map((it, i) => (
                  <div key={i} className="panel" style={{ padding: 12 }}>
                    <SelectInput label="Section" value={it.section} onChange={(e) => setItems(items.map((x, j) => (j === i ? { ...x, section: e.target.value } : x)))} options={SECTIONS.map((s) => ({ value: s, label: humanize(s) }))} />
                    <TextArea label="Instruction to the customer" value={it.message} onChange={(e) => setItems(items.map((x, j) => (j === i ? { ...x, message: e.target.value } : x)))} hint="Customer-visible. Be specific." />
                    {items.length > 1 && <Button size="sm" variant="ghost" onClick={() => setItems(items.filter((_, j) => j !== i))}>Remove</Button>}
                  </div>
                ))}
                <Button size="sm" onClick={() => setItems([...items, { section: 'DOCUMENTS', message: '' }])}>Add another item</Button>
              </div>
            )}
          </>
        )}
        {action === 'REQUEST_CLARIFICATION' && (
          <>
            <TextInput label="Subject" value={subject} onChange={(e) => setSubject(e.target.value)} required />
            <Check label="Ask the customer" checked={toCustomer} onChange={(e) => setToCustomer(e.target.checked)} />
            {!toCustomer && (staff.data ? <SelectInput label="Ask a colleague" value={toUserId} onChange={(e) => setToUserId(e.target.value)} placeholder="Select officer" options={staff.data.filter((u) => u.status === 'ACTIVE').map((u) => ({ value: u.id, label: `${u.name} (${u.roles.join(', ')})` }))} /> : <Alert tone="info">The staff directory is not available to your role. Ask the customer, or use the Messages tab.</Alert>)}
          </>
        )}
        {['APPROVE', 'RECOMMEND'].includes(action) && (
          <div className="stack" style={{ ['--gap' as any]: '8px' }}>
            <h4>Conditions (optional)</h4>
            {conditions.map((c, i) => <div key={i} className="row"><input className="input grow" aria-label={`Condition ${i + 1}`} value={c} onChange={(e) => setConditions(conditions.map((x, j) => (j === i ? e.target.value : x)))} /><Button size="sm" variant="ghost" onClick={() => setConditions(conditions.filter((_, j) => j !== i))}>Remove</Button></div>)}
            <Button size="sm" onClick={() => setConditions([...conditions, ''])}>Add condition</Button>
          </div>
        )}
        <TextArea label={needsComment ? 'Comment (required)' : 'Comment'} value={comment} onChange={(e) => setComment(e.target.value)} required={needsComment} hint="Recorded permanently with your name, role and the time." />
        <ErrorAlert error={submit.error} />
        {void facilityId}
      </div>
    </Drawer>
  );
}

function ReassignDrawer({ task, onClose, onDone }: { task: any; onClose: () => void; onDone: () => void }) {
  const users = useQuery({ queryKey: ['assignees', task.id], queryFn: () => api.get<any[]>(`/api/tasks/${task.id}/eligible-assignees`) });
  const [to, setTo] = useState(''); const [reason, setReason] = useState('');
  const go = useAction(async () => { await api.post(`/api/tasks/${task.id}/reassign`, { toUserId: to, reason }); onDone(); });
  return (
    <Drawer title="Reassign task" onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!to || reason.trim().length < 5} loading={go.loading} onClick={() => go.run()}>Reassign</Button></>}>
      <div className="stack">
        <SelectInput label="Reassign to" value={to} onChange={(e) => setTo(e.target.value)} placeholder="Select officer" options={(users.data ?? []).map((u) => ({ value: u.id, label: `${u.name}${u.businessUnit ? ` — ${u.businessUnit}` : ''}` }))} />
        <TextArea label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} required />
        <ErrorAlert error={go.error ?? users.error} />
      </div>
    </Drawer>
  );
}
