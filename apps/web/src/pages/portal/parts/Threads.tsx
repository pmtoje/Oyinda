import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Empty, ErrorAlert, Loading, Status, TextArea, useAction } from '../../../components/ui';
import { api } from '../../../lib/api';
import { dateTime } from '../../../lib/format';

export function Threads({ facilityId, initial }: { facilityId: string; initial?: string | null }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState<string | null>(initial ?? null);
  const list = useQuery({ queryKey: ['threads', facilityId], queryFn: () => api.get<any[]>(`/api/facilities/${facilityId}/threads`) });
  const thread = useQuery({ queryKey: ['thread', open], queryFn: () => api.get<any>(`/api/threads/${open}`), enabled: !!open });
  const [body, setBody] = useState('');
  const send = useAction(async () => { await api.post(`/api/threads/${open}/messages`, { body }); setBody(''); await Promise.all([thread.refetch(), qc.invalidateQueries({ queryKey: ['threads', facilityId] })]); });
  if (list.isLoading) return <Loading />;
  if (list.error) return <ErrorAlert error={list.error} />;
  if (!list.data?.length) return <Empty title="No messages">If the Bank needs clarification on your request, the question will appear here and you can reply directly.</Empty>;
  return (
    <div className="grid" style={{ gridTemplateColumns: 'minmax(200px, 280px) 1fr' }}>
      <ul className="flag-list" aria-label="Conversations">
        {list.data.map((t) => (
          <li key={t.id}>
            <button className={`choice${open === t.id ? ' selected' : ''}`} onClick={() => setOpen(t.id)}>
              <div className="title">{t.subject}</div>
              <div className="desc row between"><span>{dateTime(t.lastMessageAt ?? t.createdAt)}</span>{t.unread > 0 && <Status value="OPEN" label={`${t.unread} new`} />}</div>
            </button>
          </li>
        ))}
      </ul>
      <div>
        {!open ? <Empty title="Select a conversation" /> : thread.isLoading ? <Loading /> : thread.data ? (
          <div className="stack">
            <h3>{thread.data.subject}</h3>
            <div className="stack" style={{ ['--gap' as any]: '10px' }} aria-live="polite">
              {thread.data.messages.map((m: any) => (
                <div key={m.id} className={`thread-msg${m.mine ? ' mine' : ''}`}>
                  <div className="xs muted">{m.mine ? 'You' : m.senderType === 'STAFF' ? `${m.sender} · Alternative Bank` : m.sender} · {dateTime(m.at)}</div>
                  <div style={{ whiteSpace: 'pre-wrap' }}>{m.body}</div>
                </div>
              ))}
            </div>
            {thread.data.status === 'OPEN' ? (
              <form className="stack" onSubmit={(e) => { e.preventDefault(); void send.run(); }}>
                <ErrorAlert error={send.error} />
                <TextArea label="Your reply" value={body} onChange={(e) => setBody(e.target.value)} maxLength={10000} />
                <div><Button type="submit" variant="primary" loading={send.loading} disabled={!body.trim()}>Send reply</Button></div>
              </form>
            ) : <p className="muted small">This conversation has been closed by the Bank.</p>}
          </div>
        ) : null}
      </div>
    </div>
  );
}
