import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, api, setCsrf } from './api';

export interface StaffUser { id: string; name: string; email: string; roles: string[]; permissions: string[]; businessUnit: string | null }
export interface Me {
  type: 'STAFF' | 'CUSTOMER'; csrfToken: string; mfaSatisfied?: boolean; preferences?: { theme: 'light' | 'dark' | 'system' };
  user: any; customer?: { id: string; ref: string; name: string };
}
interface Meta { environment: string; nonProduction: boolean; integrationModes: Record<string, string>; staffAuthMode?: 'directory' | 'local' }
const Ctx = createContext<{ me: Me | null | undefined; meta?: Meta; refresh: () => Promise<void>; logout: () => Promise<void>; can: (p: string) => boolean } | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const meta = useQuery({ queryKey: ['meta'], queryFn: () => api.get<Meta>('/api/meta'), staleTime: Infinity });
  // Only a definite answer changes who is signed in: "no session" or 401. A busy server (429), an outage (5xx)
  // or a dropped connection must never sign anyone out — keep what we know and retry with backoff.
  const refresh = useCallback(async () => {
    for (let attempt = 0; ; attempt++) {
      try { const m = await api.get<Me | null>('/api/auth/session'); if (m) setCsrf(m.csrfToken); setMe(m); return; }
      catch (e) {
        if (e instanceof ApiError && e.status === 401) { setMe(null); return; }
        if (attempt >= 5) { setMe((cur) => (cur === undefined ? null : cur)); return; }
        await new Promise((r) => setTimeout(r, Math.min(8000, 500 * 2 ** attempt)));
      }
    }
  }, []);
  const logout = useCallback(async () => {
    try { await api.post('/api/auth/logout'); } catch { /* already signed out */ }
    setCsrf(undefined); setMe(null); qc.clear();
  }, [qc]);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    const h = () => setMe(null);
    window.addEventListener('gz:unauthorized', h);
    return () => window.removeEventListener('gz:unauthorized', h);
  }, []);
  const can = (p: string) => me?.type === 'STAFF' && !!me.user?.permissions?.includes(p);
  return <Ctx.Provider value={{ me, meta: meta.data, refresh, logout, can }}>{children}</Ctx.Provider>;
}

export function useAuth() {
  const c = useContext(Ctx);
  if (!c) throw new Error('useAuth outside provider');
  return c;
}
