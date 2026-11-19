import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../../lib/api';
import { useAuth } from '../../../lib/auth';
import { roleLabel, dateTime, humanize } from '../../../lib/format';
import { Button, Check, Drawer, Empty, ErrorAlert, Panel, Status, TextArea, TextInput, useAction } from '../../../components/ui';
import { QueryState, SlaBadge, useFac, useRefresh } from './common';

const ACTION_LABEL: Record<string, string> = { SUBMIT: 'Submitted', RESUBMIT: 'Resubmitted', CLAIM: 'Claimed', RELEASE: 'Released', REASSIGN: 'Reassigned', APPROVE: 'Approved', RECOMMEND: 'Recommended', DECLINE: 'Declined', RETURN: 'Returned', REQUEST_CLARIFICATION: 'Requested clarification', COMMENT: 'Commented', VOTE: 'Voted', COMPLETE: 'Completed', ROUTE: 'Route determined', ESCALATE: 'Escalated', SKIP: 'Skipped', CANCEL: 'Cancelled' };

export function WorkflowTab({ id }: { id: string }) {
  const q = useFac<any>(id, 'workflow', `/api/facilities/${id}/workflow`);
  const [showAll, setShowAll] = useState(false);
  return (
    <QueryState q={q}>{() => {
      const { instances, tasks, actions } = q.data;
      if (!instances.length) return <Panel><Empty title="No workflow yet">The workflow starts when the request is submitted.</Empty></Panel>;
      const shown = showAll ? actions : actions.filter((a: any) => !['CLAIM', 'RELEASE'].includes(a.action));
      return (
        <div className="stack">
          {instances.map((inst: any) => (
            <Panel key={inst.id} title={`${humanize(inst.kind)} — ${inst.definition}`} actions={<Status value={inst.outcome ?? inst.status} />}>
              <div className="grid cols-2">
                <div>
                  <h4 style={{ marginBottom: 8 }}>Route</h4>
                  <ul className="vsteps">{inst.route.stages.map((s: any, i: number) => {
                    const st = tasks.filter((t: any) => t.stageKey === s.key || (s.branches ?? []).some((b: any) => b.key === t.branchKey || b.key === t.stageKey));
                    const done = i < inst.currentStageIndex || inst.status !== 'ACTIVE';
                    return (
                      <li key={i} className={s.skipped ? '' : done ? 'done' : i === inst.currentStageIndex ? 'current' : ''}>
                        <div className="small"><strong>{s.name}</strong>{s.skipped && <span className="muted"> — not required</span>}{s.level && <span className="muted"> · {s.level.kind === 'COMMITTEE' ? 'committee' : roleLabel(s.level.role)}{s.level.isFinal ? ' · final authority' : ''}</span>}
                          {s.branches && <div className="xs muted">{s.branches.map((b: any) => `${b.name}${b.included ? '' : ' (not required)'}`).join(' ∥ ')}</div>}
                          {st.length > 0 && <div className="xs muted">{st.map((t: any) => `${t.stageName}: ${humanize(t.outcome ?? t.status)}`).join(' · ')}</div>}</div>
                      </li>);
                  })}</ul>
                </div>
                <div>
                  <h4 style={{ marginBottom: 8 }}>Why this route</h4>
                  <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>{inst.route.explanation.map((e: string, i: number) => <li key={i}>{e}</li>)}</ul>
                  <div className="xs muted" style={{ marginTop: 8 }}>Started {dateTime(inst.startedAt)}{inst.completedAt && ` · completed ${dateTime(inst.completedAt)}`}</div>
                </div>
              </div>
            </Panel>))}
          <Panel title="Tasks" flush>
            <div className="table-wrap"><table className="data"><thead><tr><th>Stage</th><th>Role</th><th>Officer</th><th>Status</th><th>SLA</th><th>Opened</th><th>Closed</th></tr></thead>
              <tbody>{tasks.map((t: any) => <tr key={t.id}><td className="primary-cell">{t.stageName}</td><td>{roleLabel(t.role)}</td><td className="small">{t.claimedBy ?? t.assignedTo ?? <span className="muted">Queue</span>}</td><td><Status value={t.outcome === 'APPROVE' ? 'APPROVED' : t.outcome === 'DECLINE' ? 'DECLINED' : t.outcome === 'RETURN' ? 'RETURNED' : t.status} label={t.outcome ? humanize(t.outcome) : undefined} /></td><td><SlaBadge sla={t.sla} /></td><td className="small">{dateTime(t.createdAt)}</td><td className="small">{dateTime(t.completedAt)}</td></tr>)}</tbody></table></div>
          </Panel>
          <Panel title="Decision record" actions={<label className="check small"><input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} /><span>Include claims and releases</span></label>}>
            <ul className="timeline">{shown.map((a: any) => (
              <li key={a.id}><span className="when">{dateTime(a.at)}</span>
                <div><strong>{a.actor}</strong>{a.role && <span className="muted small"> · {roleLabel(a.role)}</span>}{a.onBehalfOf && <span className="muted small"> · for {a.onBehalfOf}</span>} — {ACTION_LABEL[a.action] ?? humanize(a.action)}{a.payload?.vote && `: ${humanize(a.payload.vote)}`}
                  {a.comment && <div className="small" style={{ marginTop: 2 }}>{a.comment}</div>}
                  {a.payload?.reworkItems?.length > 0 && <ul className="small">{a.payload.reworkItems.map((r: any, i: number) => <li key={i}>{humanize(r.section)}: {r.message}</li>)}</ul>}
                  {a.payload?.conditions?.length > 0 && <div className="small muted">Conditions: {a.payload.conditions.join('; ')}</div>}
                  {a.payload?.explanation && <div className="xs muted">{a.payload.explanation.join(' ')}</div>}</div></li>))}</ul>
          </Panel>
        </div>
      );
    }}</QueryState>
  );
}

export function MessagesTab({ id, initialThread }: { id: string; initialThread?: string | null }) {
  const { can } = useAuth();
  const threads = useFac<any[]>(id, 'threads', `/api/facilities/${id}/threads`);
  const [open, setOpen] = useState<string | null>(initialThread ?? null);
  const [creating, setCreating] = useState(false);
  useEffect(() => { if (!open && threads.data?.length) setOpen(threads.data[0].id); }, [threads.data, open]);
  const refresh = useRefresh(id);
  return (
    <div className="grid" style={{ gridTemplateColumns: 'minmax(220px, 1fr) 2fr' }}>
      <Panel title="Threads" flush actions={can('thread.participate') && <Button size="sm" onClick={() => setCreating(true)}>New</Button>}>
        <QueryState q={threads} empty={<Empty title="No conversations">Clarifications with the customer or colleagues stay here, linked to this request.</Empty>}>{() => (
          <ul className="flag-list" style={{ padding: '0 14px' }}>{threads.data!.map((t) => (
            <li key={t.id}><button className="btn ghost block" style={{ justifyContent: 'space-between', fontWeight: open === t.id ? 600 : 400 }} onClick={() => setOpen(t.id)} aria-current={open === t.id}>
              <span style={{ textAlign: 'left', overflow: 'hidden', textOverflow: 'ellipsis' }}>{t.subject}</span>{t.unread > 0 && <span className="badge info plain">{t.unread}</span>}</button>
              <div className="xs muted" style={{ padding: '0 14px' }}>{t.audience === 'CUSTOMER' ? 'With customer' : 'Internal'} · {humanize(t.status)} · {dateTime(t.lastMessageAt)}</div></li>))}</ul>)}</QueryState>
      </Panel>
      {open ? <ThreadView threadId={open} onChange={refresh} /> : <Panel><Empty title="Select a conversation" /></Panel>}
      {creating && <NewThreadDrawer id={id} onClose={() => setCreating(false)} onDone={async (tid) => { setCreating(false); await refresh(); setOpen(tid); }} />}
    </div>
  );
}

function ThreadView({ threadId, onChange }: { threadId: string; onChange: () => void }) {
  const q = useQuery({ queryKey: ['thread', threadId], queryFn: () => api.get<any>(`/api/threads/${threadId}`) });
  const [body, setBody] = useState('');
  const send = useAction(async () => { await api.post(`/api/threads/${threadId}/messages`, { body }); setBody(''); await q.refetch(); onChange(); });
  const resolve = useAction(async () => { await api.post(`/api/threads/${threadId}/resolve`); await q.refetch(); onChange(); });
  return (
    <Panel title={q.data?.subject ?? 'Conversation'} actions={q.data?.status === 'OPEN' && <Button size="sm" variant="ghost" onClick={() => resolve.run()}>Mark resolved</Button>}
      footer={<div className="stack" style={{ ['--gap' as any]: '8px' }}><TextArea label="Reply" value={body} onChange={(e) => setBody(e.target.value)} hint={q.data?.audience === 'CUSTOMER' ? 'The customer will see this message.' : 'Internal — not visible to the customer.'} /><div className="row end"><Button variant="primary" disabled={!body.trim()} loading={send.loading} onClick={() => send.run()}>Send</Button></div><ErrorAlert error={send.error} /></div>}>
      <QueryState q={q}>{() => (
        <div className="stack" style={{ ['--gap' as any]: '10px' }}>{q.data.messages.map((m: any) => (
          <div key={m.id} className={m.mine ? 'thread-msg mine' : 'thread-msg'}><div className="xs muted">{m.sender}{m.senderType === 'CUSTOMER' ? ' (customer)' : ''} · {dateTime(m.at)}{m.mine && m.readByOthers ? ' · read' : ''}</div><div style={{ whiteSpace: 'pre-wrap' }}>{m.body}</div></div>))}</div>)}</QueryState>
    </Panel>
  );
}

function NewThreadDrawer({ id, onClose, onDone }: { id: string; onClose: () => void; onDone: (threadId: string) => void }) {
  const staff = useQuery({ queryKey: ['staff-directory'], queryFn: () => api.get<any[]>('/api/staff/directory'), retry: false });
  const [subject, setSubject] = useState(''); const [message, setMessage] = useState(''); const [toCustomer, setToCustomer] = useState(true); const [toUserId, setToUserId] = useState('');
  const go = useAction(async () => { const r = await api.post<{ id: string }>(`/api/facilities/${id}/threads`, { subject, message, ...(toCustomer ? { toCustomer: true } : { toUserId }) }); onDone(r.id); });
  return (
    <Drawer title="New conversation" onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={subject.trim().length < 3 || !message.trim() || (!toCustomer && !toUserId)} loading={go.loading} onClick={() => go.run()}>Send</Button></>}>
      <div className="stack">
        <Check label="With the customer" checked={toCustomer} onChange={(e) => setToCustomer(e.target.checked)} />
        {!toCustomer && (staff.data ? (
          <div className="field"><label htmlFor="to-user">Colleague</label><select id="to-user" className="select" value={toUserId} onChange={(e) => setToUserId(e.target.value)}><option value="">Select officer</option>{staff.data.filter((u) => u.status === 'ACTIVE').map((u) => <option key={u.id} value={u.id}>{u.name} ({u.roles.join(', ')})</option>)}</select></div>
        ) : <p className="small muted">The staff directory is not available to your role.</p>)}
        <TextInput label="Subject" value={subject} onChange={(e) => setSubject(e.target.value)} required />
        <TextArea label="Message" value={message} onChange={(e) => setMessage(e.target.value)} required />
        <ErrorAlert error={go.error} />
      </div>
    </Drawer>
  );
}
