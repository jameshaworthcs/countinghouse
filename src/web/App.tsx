import { lazy, Suspense, type ReactNode } from 'react';
import { createBrowserRouter, Navigate, RouterProvider, useLocation } from 'react-router';
import { Layout } from './components/Layout';
import { Loading } from './components/ui';
import { useApi } from './lib/api';
import { DataProvider } from './lib/data';
import { Login } from './pages/Login';

const Dashboard = lazy(() => import('./pages/Dashboard'));
const Accounts = lazy(() => import('./pages/Accounts'));
const AccountDetail = lazy(() => import('./pages/AccountDetail'));
const Transactions = lazy(() => import('./pages/Transactions'));
const Spending = lazy(() => import('./pages/Spending'));
const Projections = lazy(() => import('./pages/Projections'));
const Investments = lazy(() => import('./pages/Investments'));
const TaxYear = lazy(() => import('./pages/TaxYear'));
const Import = lazy(() => import('./pages/Import'));
const Review = lazy(() => import('./pages/Review'));
const Settings = lazy(() => import('./pages/Settings'));
const Assumptions = lazy(() => import('./pages/Assumptions'));

interface AuthStatus {
  configured: boolean;
  user: string | null;
  localAccess: boolean;
}

/** Signed in (or local access without a password configured) before anything else loads. */
function RequireAuth({ children }: { children: ReactNode }) {
  const status = useApi<AuthStatus>(['auth-status'], '/auth/status');
  const location = useLocation();
  if (!status.data) return <div className="p-8">{status.error ? status.error.message : <Loading />}</div>;
  const { configured, user, localAccess } = status.data;
  if (configured && !user) {
    // A cached "signed out" can predate the session, so wait for a refetch before redirecting.
    if (status.isFetching) return <div className="p-8"><Loading /></div>;
    return <Navigate to={`/login?next=${encodeURIComponent(location.pathname + location.search)}`} replace />;
  }
  if (!configured && !localAccess) {
    return (
      <div className="mx-auto mt-24 max-w-md rounded-xl border border-line bg-panel p-6 text-sm text-ink-2">
        <h1 className="mb-2 text-lg font-semibold text-ink">Login not configured</h1>
        This server has no username or password yet, so it only accepts local connections. On the server, run <code className="rounded bg-panel-2 px-1">npm run set-password</code> and restart it.
      </div>
    );
  }
  return (
    <DataProvider fallback={<div className="p-8"><Loading /></div>}>
      {children}
    </DataProvider>
  );
}

const page = (node: ReactNode) => <Suspense fallback={<Loading />}>{node}</Suspense>;

const router = createBrowserRouter([
  { path: '/login', element: <Login /> },
  {
    path: '/',
    element: (
      <RequireAuth>
        <Layout />
      </RequireAuth>
    ),
    children: [
      { index: true, element: page(<Dashboard />) },
      { path: 'accounts', element: page(<Accounts />) },
      { path: 'accounts/:id', element: page(<AccountDetail />) },
      { path: 'transactions', element: page(<Transactions />) },
      { path: 'spending', element: page(<Spending />) },
      { path: 'projections', element: page(<Projections />) },
      { path: 'investments', element: page(<Investments />) },
      { path: 'tax', element: page(<TaxYear />) },
      { path: 'tax/:tab', element: page(<TaxYear />) },
      { path: 'assumptions', element: page(<Assumptions />) },
      { path: 'import', element: page(<Import />) },
      { path: 'import/:id', element: page(<Review />) },
      { path: 'settings', element: page(<Settings />) },
      { path: '*', element: <div className="py-20 text-center text-ink-3">Page not found.</div> },
    ],
  },
]);

export function App() {
  return <RouterProvider router={router} />;
}
