import { lazy, Suspense, type ReactElement } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useSession } from './session/SessionProvider.js';
import { Login } from './pages/Login.js';
import { Portal } from './pages/Portal.js';
import { Elevate } from './pages/Elevate.js';
import { MfaChallenge } from './pages/MfaChallenge.js';
import { EnrolFactor } from './pages/EnrolFactor.js';
import { Security } from './pages/Security.js';
import { ForgotPassword } from './pages/ForgotPassword.js';
import { ResetPassword } from './pages/ResetPassword.js';
import { CatalogPage } from './pages/automate/CatalogPage.js';
import { RequestFormPage } from './pages/automate/RequestFormPage.js';
import { MyRequestsPage } from './pages/automate/MyRequestsPage.js';
import { RequestDetailPage } from './pages/automate/RequestDetailPage.js';
import { MyAccessPage } from './pages/automate/MyAccessPage.js';
import { MyApprovalsPage } from './pages/automate/MyApprovalsPage.js';
import { ManagedResourcesPage } from './pages/automate/ManagedResourcesPage.js';

/**
 * The console is a separate chunk behind a guard, so a portal-only session
 * never downloads it. The guard is not a security control - every /api/admin
 * request is checked server-side regardless of what the router allows.
 */
const AdminApp = lazy(() =>
  import('./pages/admin/AdminApp.js').then((m) => ({ default: m.AdminApp })),
);

function RequireSession({
  scope,
  children,
}: {
  scope: 'portal' | 'admin';
  children: ReactElement;
}) {
  const { session, loading } = useSession();
  const location = useLocation();

  if (loading) return <BootScreen />;
  if (!session) return <Navigate to="/login" replace state={{ from: location }} />;
  if (scope === 'admin' && session.scope !== 'admin') {
    // Carry where they were headed, so elevating from a deep link returns
    // them there rather than dumping them on the console's first page.
    return <Navigate to="/elevate" replace state={{ from: location }} />;
  }
  return children;
}

/** Shown only while the session probe is in flight, so it stays quiet. */
function BootScreen() {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-bg">
      <span className="sr-only">Loading</span>
      <div className="skeleton h-2 w-32 rounded-full" />
    </div>
  );
}

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route
        path="/"
        element={
          <RequireSession scope="portal">
            <Portal />
          </RequireSession>
        }
      />
      <Route
        path="/elevate"
        element={
          <RequireSession scope="portal">
            <Elevate />
          </RequireSession>
        }
      />
      <Route path="/mfa" element={<MfaChallenge />} />
      {/*
        Outside RequireSession on purpose. A user reaching /enrol has passed
        primary authentication and holds no session — that is the whole point
        of the screen.
      */}
      <Route path="/enrol" element={<EnrolFactor />} />
      <Route path="/forgot-password" element={<ForgotPassword />} />
      <Route path="/reset-password" element={<ResetPassword />} />
      <Route
        path="/security"
        element={
          <RequireSession scope="portal">
            <Security />
          </RequireSession>
        }
      />
      <Route
        path="/catalog"
        element={
          <RequireSession scope="portal">
            <CatalogPage />
          </RequireSession>
        }
      />
      <Route
        path="/catalog/:id"
        element={
          <RequireSession scope="portal">
            <RequestFormPage />
          </RequireSession>
        }
      />
      <Route
        path="/requests"
        element={
          <RequireSession scope="portal">
            <MyRequestsPage />
          </RequireSession>
        }
      />
      <Route
        path="/requests/:id"
        element={
          <RequireSession scope="portal">
            <RequestDetailPage />
          </RequireSession>
        }
      />
      <Route
        path="/access"
        element={
          <RequireSession scope="portal">
            <MyAccessPage />
          </RequireSession>
        }
      />
      <Route
        path="/approvals"
        element={
          <RequireSession scope="portal">
            <MyApprovalsPage />
          </RequireSession>
        }
      />
      <Route
        path="/managed"
        element={
          <RequireSession scope="portal">
            <ManagedResourcesPage />
          </RequireSession>
        }
      />
      <Route
        path="/admin/*"
        element={
          <RequireSession scope="admin">
            <Suspense fallback={<BootScreen />}>
              <AdminApp />
            </Suspense>
          </RequireSession>
        }
      />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
