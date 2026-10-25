import { useEffect } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { useAuthStore } from '../store/authStore';
import { useMetricsStore } from '../store/metricsStore';
import NexusLogo from './NexusLogo';

const NAV = [
  { to: '/device', label: 'Устройство' },
  { to: '/scenario', label: 'Сценарий работы' },
  { to: '/monitoring', label: 'Мониторинг' }
];

export default function Layout() {
  const logout = useAuthStore((s) => s.logout);
  const startMetrics = useMetricsStore((s) => s.start);
  useEffect(() => startMetrics(), [startMetrics]);

  return (
    <div style={styles.root}>
      <aside style={styles.sidebar}>
        <div style={styles.brand}>
          <NexusLogo size={28} />
          <span>Nexus IoT Platform</span>
        </div>
        <nav style={styles.nav}>
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              style={({ isActive }) => ({ ...styles.navItem, ...(isActive ? styles.navItemActive : {}) })}
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
        <button className="btn" style={{ margin: 12 }} onClick={logout}>
          Выйти
        </button>
      </aside>
      <main style={styles.main}>
        <Outlet />
      </main>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  root: { display: 'flex', height: '100%' },
  sidebar: {
    width: 220,
    background: 'var(--surface)',
    borderRight: '1px solid var(--border)',
    display: 'flex',
    flexDirection: 'column'
  },
  brand: { display: 'flex', alignItems: 'center', gap: 10, padding: '16px', fontWeight: 700, fontSize: 15, borderBottom: '1px solid var(--border)' },
  nav: { display: 'flex', flexDirection: 'column', padding: 12, gap: 4, flex: 1 },
  navItem: {
    padding: '10px 12px',
    borderRadius: 8,
    color: 'var(--muted)',
    textDecoration: 'none',
    fontSize: 14
  },
  navItemActive: { background: 'var(--surface-2)', color: 'var(--text)', fontWeight: 600 },
  main: { flex: 1, overflow: 'auto' }
};
