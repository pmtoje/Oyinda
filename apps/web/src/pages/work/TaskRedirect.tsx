import { useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { ErrorAlert, Loading } from '../../components/ui';

export default function TaskRedirect() {
  const { taskId = '' } = useParams();
  const nav = useNavigate();
  const q = useQuery({ queryKey: ['task-redirect', taskId], queryFn: () => api.get<any>(`/api/tasks/${taskId}`), retry: false });
  useEffect(() => { if (q.data) nav(`/work/facilities/${q.data.facilityId}?task=${taskId}`, { replace: true }); }, [q.data, nav, taskId]);
  return q.error ? <ErrorAlert error={q.error} title="This task could not be opened" /> : <Loading />;
}
