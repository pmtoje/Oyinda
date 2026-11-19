import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApiError } from './lib/api';
import { AuthProvider, useAuth } from './lib/auth';
import { api } from './lib/api';
import { ThemeAccountSync, ThemeProvider, type ThemePref } from './lib/theme';
import App from './App';
import { watchScrollRegions } from './lib/scroll-regions';
import './styles/app.css';

const qc = new QueryClient({ defaultOptions: { queries: { staleTime: 15_000, refetchOnWindowFocus: false, retry: (n, e) => !(e instanceof ApiError && e.status < 500 && e.status !== 429) && n < 3, retryDelay: (n) => Math.min(8000, 750 * 2 ** n) } } });

const saveTheme = (theme: ThemePref) => { api.put('/api/me/preferences', { theme }).catch(() => { /* signed out: kept on this device */ }); };
function ThemedApp() {
  const { me } = useAuth();
  const save = (p: ThemePref) => { if (me && (me.type === 'CUSTOMER' || me.mfaSatisfied)) saveTheme(p); };
  return <ThemeProvider onChange={save}><ThemeAccountSync me={me} save={save} /><App /></ThemeProvider>;
}

watchScrollRegions();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={qc}>
      <BrowserRouter>
        <AuthProvider><ThemedApp /></AuthProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
