import { lazy, Suspense, type ComponentType } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { PortalShell, WorkShell } from './components/Shells';
import { NotificationsPage, SessionsPage } from './components/AccountPages';
import { Loading } from './components/ui';

const L = (f: () => Promise<{ default: ComponentType<any> }>) => { const C = lazy(f); return <Suspense fallback={<Loading />}><C /></Suspense>; };

export default function App() {
  return (
    <Routes>
      <Route path="/" element={L(() => import('./pages/public/Welcome'))} />
      <Route path="/onboarding" element={L(() => import('./pages/public/Onboarding'))} />
      <Route path="/login" element={L(() => import('./pages/public/CustomerLogin'))} />
      <Route path="/verify-email" element={L(() => import('./pages/public/VerifyEmail'))} />
      <Route path="/invite" element={L(() => import('./pages/public/AcceptInvite'))} />
      <Route path="/staff/login" element={L(() => import('./pages/public/StaffLogin'))} />
      <Route path="/staff/forgot-password" element={L(() => import('./pages/public/StaffForgotPassword'))} />
      <Route path="/staff/set-password" element={L(() => import('./pages/public/StaffSetPassword'))} />

      <Route path="/portal" element={<PortalShell />}>
        <Route index element={L(() => import('./pages/portal/Dashboard'))} />
        <Route path="profile" element={L(() => import('./pages/portal/Profile'))} />
        <Route path="users" element={L(() => import('./pages/portal/Users'))} />
        <Route path="facilities/new" element={L(() => import('./pages/portal/NewFacility'))} />
        <Route path="facilities/:id/apply" element={L(() => import('./pages/portal/Application'))} />
        <Route path="facilities/:id/*" element={L(() => import('./pages/portal/FacilityDetail'))} />
        <Route path="notifications" element={<NotificationsPage />} />
        <Route path="security" element={<SessionsPage />} />
      </Route>

      <Route path="/work" element={<WorkShell />}>
        <Route index element={L(() => import('./pages/work/Tasks'))} />
        <Route path="queue" element={L(() => import('./pages/work/Tasks'))} />
        <Route path="tasks/:taskId" element={L(() => import('./pages/work/TaskRedirect'))} />
        <Route path="facilities" element={L(() => import('./pages/work/Facilities'))} />
        <Route path="facilities/:id" element={L(() => import('./pages/work/FacilityWorkspace'))} />
        <Route path="facilities/:id/decision" element={L(() => import('./pages/work/Decision'))} />
        <Route path="customers" element={L(() => import('./pages/work/Customers'))} />
        <Route path="customers/:id" element={L(() => import('./pages/work/CustomerView'))} />
        <Route path="monitoring" element={L(() => import('./pages/work/Monitoring'))} />
        <Route path="reports" element={L(() => import('./pages/work/Reports'))} />
        <Route path="reports/drop-off" element={L(() => import('./pages/work/DropOff'))} />
        <Route path="reports/exports" element={L(() => import('./pages/work/Exports'))} />
        <Route path="delegations" element={L(() => import('./pages/work/Delegations'))} />
        <Route path="notifications" element={<NotificationsPage />} />
        <Route path="security" element={<SessionsPage />} />
      </Route>

      <Route path="/admin" element={<WorkShell />}>
        <Route index element={<Navigate to="/admin/config" replace />} />
        <Route path="config" element={L(() => import('./pages/admin/ConfigList'))} />
        <Route path="config/:id" element={L(() => import('./pages/admin/ConfigEdit'))} />
        <Route path="users" element={L(() => import('./pages/admin/Users'))} />
        <Route path="fx-rates" element={L(() => import('./pages/admin/FxRates'))} />
        <Route path="audit" element={L(() => import('./pages/admin/Audit'))} />
        <Route path="health" element={L(() => import('./pages/admin/Health'))} />
        <Route path="data-quality" element={L(() => import('./pages/admin/DataQuality'))} />
      </Route>
      <Route path="*" element={<div className="portal-main"><h1>Page not found</h1><p><a href="/">Return to Gazelle</a></p></div>} />
    </Routes>
  );
}
