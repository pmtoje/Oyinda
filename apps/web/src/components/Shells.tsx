import { useEffect, useState, type ReactNode } from 'react';
import { Link, NavLink, Navigate, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { roleLabel } from '../lib/format';
import { useAuth } from '../lib/auth';
import { Loading } from './ui';

export function Brand({ to = '/' }: { to?: string }) {
  return (
    <Link to={to} className="brand" aria-label="Gazelle by Alternative Bank — home">
      <svg className="brand-mark" viewBox="0 0 32 32" aria-hidden><rect width="32" height="32" rx="6" fill="#145040" /><path d="M9 23c3-1 5-4 6-8l2-6 1 5c1 4 3 7 6 9" fill="none" stroke="#C9A25E" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" /></svg>
      <span><span className="brand-name">Gazelle</span><span className="brand-sub">Alternative Bank</span></span>
    </Link>
  );
}

/** Persistent, honest indicator that integrations are mocked (never disguise mock data as live). */
export function ModeBanner() {
  const { meta } = useAuth();
  if (!meta) return null;
  const local = meta.staffAuthMode === 'local';
  const mocks = Object.entries(meta.integrationModes).filter(([k, m]) => m === 'mock' && !(local && k === 'activeDirectory')).map(([k]) => k);
  if (!meta.nonProduction && !mocks.length && !local) return null;
  const parts = [...(meta.nonProduction ? [`${meta.environment.toUpperCase()} environment · DEMO / NON-PRODUCTION data`] : []), ...(mocks.length ? [`Mock integrations: ${mocks.join(', ')}`] : []), ...(local ? ['Interim staff sign-in (Gazelle passwords) until Active Directory'] : [])];
  return <div className="mode-banner" role="note">{parts.join(' · ')}</div>;
}

function Bell({ to }: { to: string }) {
  const n = useQuery({ queryKey: ['notifications', 'count'], queryFn: () => api.get<{ unread: number }>('/api/notifications?limit=1'), refetchInterval: 60_000 });
  const unread = n.data?.unread ?? 0;
  return <Link to={to} className="icon-btn" aria-label={`Notifications${unread ? `, ${unread} unread` : ''}`}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden><path d="M6 8a6 6 0 1 1 12 0c0 7 3 8 3 8H3s3-1 3-8" /><path d="M10 20a2 2 0 0 0 4 0" /></svg>{unread > 0 && <span className="count-dot">{unread > 99 ? '99+' : unread}</span>}</Link>;
}

function useGuard(kind: 'CUSTOMER' | 'STAFF') {
  const { me } = useAuth();
  const loc = useLocation();
  if (me === undefined) return <div style={{ padding: 40 }}><Loading /></div>;
  if (!me || me.type !== kind || (kind === 'STAFF' && !me.mfaSatisfied)) return <Navigate to={kind === 'STAFF' ? '/staff/login' : '/login'} replace state={{ from: loc.pathname }} />;
  return null;
}

export function PortalShell() {
  const blocked = useGuard('CUSTOMER');
  const { me, logout } = useAuth();
  const nav = useNavigate();
  if (blocked) return blocked;
  const links: [string, string][] = [['/portal', 'Overview'], ['/portal/facilities/new', 'New facility request'], ['/portal/profile', 'Business profile'], ['/portal/notifications', 'Notifications'], ['/portal/security', 'Security']];
  return (
    <>
      <a href="#main" className="skip-link">Skip to content</a>
      <ModeBanner />
      <header className="topbar">
        <Brand to="/portal" />
        <span className="spacer" />
        <Bell to="/portal/notifications" />
        <div className="user"><strong>{me!.customer?.name}</strong>{me!.user?.name}</div>
        <button className="icon-btn" onClick={async () => { await logout(); nav('/login'); }}>Sign out</button>
      </header>
      <nav className="portal-nav" aria-label="Portal"><div className="inner">{links.map(([to, l]) => <NavLink key={to} to={to} end={to === '/portal'} className={({ isActive }) => (isActive ? 'active' : '')}>{l}</NavLink>)}</div></nav>
      <main id="main" className="portal-main"><Outlet /></main>
    </>
  );
}

function SideLink({ to, children, end, count }: { to: string; children: ReactNode; end?: boolean; count?: number }) {
  return <NavLink to={to} end={end} className={({ isActive }) => (isActive ? 'active' : '')}><span>{children}</span>{count ? <span className="pill">{count}</span> : null}</NavLink>;
}

export function WorkShell() {
  const blocked = useGuard('STAFF');
  const { me, logout, can } = useAuth();
  const nav = useNavigate();
  const loc = useLocation();
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(false), [loc.pathname]);
  const mine = useQuery({ queryKey: ['tasks', 'mine'], queryFn: () => api.get<any[]>('/api/tasks?scope=mine'), enabled: !blocked && can('task.work'), refetchInterval: 60_000 });
  if (blocked) return blocked;
  const roles: string[] = me!.user.roles;
  return (
    <>
      <a href="#main" className="skip-link">Skip to content</a>
      <ModeBanner />
      <header className="topbar">
        <button className="icon-btn nav-toggle" aria-expanded={open} aria-controls="sidebar" onClick={() => setOpen(!open)}>Menu</button>
        <Brand to="/work" />
        <span className="spacer" />
        <Bell to="/work/notifications" />
        <div className="user"><strong>{me!.user.name}</strong>{roles.map(roleLabel).join(' · ')}</div>
        <button className="icon-btn" onClick={async () => { await logout(); nav('/staff/login'); }}>Sign out</button>
      </header>
      <div className="work">
        <aside id="sidebar" className={open ? 'sidebar open' : 'sidebar'}>
          <nav aria-label="Workspace">
            {can('task.work') && <SideLink to="/work" end count={mine.data?.length}>My tasks</SideLink>}
            {can('task.work') && <SideLink to="/work/queue">Team queue</SideLink>}
            {(can('facility.view.all') || can('facility.view.assigned')) && <SideLink to="/work/facilities">Facilities</SideLink>}
            {(can('customer.view.assigned') || can('customer.view.all')) && <SideLink to="/work/customers">Customers</SideLink>}
            {can('monitoring.manage') || can('facility.view.assigned') ? <SideLink to="/work/monitoring">Monitoring</SideLink> : null}
            {can('report.view') && <><div className="section-label">Insight</div><SideLink to="/work/reports" end>SLM dashboard</SideLink><SideLink to="/work/reports/drop-off">Drop-off analytics</SideLink><SideLink to="/work/reports/exports">Report exports</SideLink></>}
            {(can('config.view') || can('user.manage') || can('audit.view') || can('system.health')) && <div className="section-label">Control centre</div>}
            {can('config.view') && <SideLink to="/admin/config">Configuration</SideLink>}
            {can('user.manage') && <SideLink to="/admin/users">Users & access</SideLink>}
            {can('config.edit') && <SideLink to="/admin/fx-rates">FX rates</SideLink>}
            {can('audit.view') && <SideLink to="/admin/audit">Audit log</SideLink>}
            {can('system.health') && <SideLink to="/admin/health">System health</SideLink>}
            {(can('system.health') || can('report.view')) && <SideLink to="/admin/data-quality">Data quality</SideLink>}
            <div className="section-label">You</div>
            <SideLink to="/work/delegations">Delegations</SideLink>
            <SideLink to="/work/notifications">Notifications</SideLink>
            <SideLink to="/work/security">Sessions</SideLink>
          </nav>
        </aside>
        <main id="main" className="main"><Outlet /></main>
      </div>
    </>
  );
}

/** Public layout used by sign-in and onboarding. */
export function AuthLayout({ heading, text, children }: { heading: string; text: string; children: ReactNode }) {
  return (
    <>
      <ModeBanner />
      <div className="auth-wrap">
        <aside className="auth-aside">
          <Brand />
          <div><h1>{heading}</h1><p>{text}</p></div>
          <div className="fine">Alternative Bank Limited is licensed by the Central Bank of Nigeria as a non-interest bank. Gazelle never asks for your PIN, password or one-time code by phone or email.</div>
        </aside>
        <main className="auth-main" id="main"><div className="auth-card">{children}</div></main>
      </div>
    </>
  );
}
