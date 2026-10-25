// HashRouter (URLs like /#/monitoring): the page is plain static files served by
// the router's uhttpd, which has no "fallback to index.html" rule. With hash
// routes a browser refresh on any tab can never hit a 404.
import { HashRouter, Navigate, Route, Routes } from 'react-router-dom';
import { useAuthStore } from './store/authStore';
import LoginPage from './pages/LoginPage';
import Layout from './components/Layout';
import DevicePage from './pages/DevicePage';
import ScenarioPage from './pages/ScenarioPage';
import MonitoringPage from './pages/MonitoringPage';
import ChangePasswordGate from './components/ChangePasswordGate';

function RequireAuth({ children }: { children: React.ReactElement }) {
  const token = useAuthStore((s) => s.token);
  if (!token) return <Navigate to="/login" replace />;
  return children;
}

export default function App() {
  return (
    <HashRouter>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route
          element={
            <RequireAuth>
              <ChangePasswordGate>
                <Layout />
              </ChangePasswordGate>
            </RequireAuth>
          }
        >
          <Route path="/device" element={<DevicePage />} />
          <Route path="/scenario" element={<ScenarioPage />} />
          <Route path="/monitoring" element={<MonitoringPage />} />
          <Route path="/" element={<Navigate to="/device" replace />} />
        </Route>
        {/* /login remains reachable to review the screen, but isn't required */}
        <Route path="*" element={<Navigate to="/device" replace />} />
      </Routes>
    </HashRouter>
  );
}
