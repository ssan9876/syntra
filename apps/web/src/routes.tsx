import { lazy, Suspense, type ReactElement } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useSession } from './session/SessionProvider.js';
import { Login } from './pages/Login.js';
import { Portal } from './pages/Portal.js';
import { Elevate } from './pages/Elevate.js';

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
    return <Navigate to="/elevate" replace />;
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
