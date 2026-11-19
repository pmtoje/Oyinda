import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { dateTime } from '../lib/format';
import { Button, Empty, ErrorAlert, Loading, PageHeader, Panel, Status } from './ui';

export function NotificationsPage() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['notifications', 'list'], queryFn: () => api.get<{ unread: number; items: any[] }>('/api/notifications?limit=100') });
  const readAll = useMutation({ mutationFn: () => api.post('/api/notifications/read-all'), onSuccess: () => qc.invalidateQueries({ queryKey: ['notifications'] }) });
  const read = (id: string) => api.post(`/api/notifications/${id}/read`).then(() => qc.invalidateQueries({ queryKey: ['notifications'] }));
  return (
    <>
      <PageHeader title="Notifications" sub={q.data ? `${q.data.unread} unread` : undefined} actions={<Button size="sm" onClick={() => readAll.mutate()} disabled={!q.data?.unread}>Mark all as read</Button>} />
      <Panel flush>
        {q.isLoading ? <Loading /> : q.error ? <ErrorAlert error={q.error} /> : !q.data?.items.length ? <Empty title="No notifications yet">Updates about your requests and tasks will appear here.</Empty> : (
          <ul className="flag-list" style={{ padding: '0 18px' }}>
            {q.data.items.map((n) => (
              <li key={n.id} style={{ display: 'flex', gap: 12, alignItems: 'flex-start', opacity: n.readAt ? 0.72 : 1 }}>
                <div className="grow">
                  <div className="row" style={{ ['--gap' as any]: '8px' }}>{!n.readAt && <span className="sr-only">Unread</span>}<Link to={n.link ?? '#'} onClick={() => read(n.id)} style={{ fontWeight: n.readAt ? 400 : 600 }}>{n.title}</Link>{n.severity !== 'INFO' && <Status value={n.severity === 'ACTION' ? 'PENDING' : n.severity} label={n.severity === 'ACTION' ? 'Action' : undefined} />}</div>
                  <div className="small muted">{n.body}</div>
                </div>
                <div className="xs muted nowrap">{dateTime(n.createdAt)}</div>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </>
  );
}

export function SessionsPage() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['sessions'], queryFn: () => api.get<any[]>('/api/auth/sessions') });
  const revoke = useMutation({ mutationFn: (id: string) => api.del(`/api/auth/sessions/${id}`), onSuccess: () => qc.invalidateQueries({ queryKey: ['sessions'] }) });
  const others = useMutation({ mutationFn: () => api.post('/api/auth/sessions/revoke-others'), onSuccess: () => qc.invalidateQueries({ queryKey: ['sessions'] }) });
  return (
    <>
      <PageHeader title="Signed-in devices" sub="Sessions end automatically after a period of inactivity. Sign out of any device you do not recognise." actions={<Button size="sm" onClick={() => others.mutate()} loading={others.isPending}>Sign out all other devices</Button>} />
      <Panel flush>
        {q.isLoading ? <Loading /> : q.error ? <ErrorAlert error={q.error} /> : (
          <div className="table-wrap"><table className="data"><thead><tr><th>Device</th><th>IP address</th><th>Signed in</th><th>Last active</th><th /></tr></thead>
            <tbody>{q.data!.map((s) => <tr key={s.id}><td className="primary-cell">{s.device_label}{s.current && <> <Status value="ACTIVE" label="This device" /></>}</td><td className="mono">{s.ip}</td><td>{dateTime(s.created_at)}</td><td>{dateTime(s.last_seen_at)}</td><td className="num">{!s.current && <Button size="sm" variant="danger" onClick={() => revoke.mutate(s.id)}>Sign out</Button>}</td></tr>)}</tbody></table></div>
        )}
      </Panel>
    </>
  );
}
