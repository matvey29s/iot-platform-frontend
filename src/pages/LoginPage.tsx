import { useRef, useState } from 'react';
import DOMPurify from 'dompurify';
import { useAuthStore } from '../store/authStore';

export default function LoginPage() {
  const { login, error, loading } = useAuthStore();
  const usernameRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const [logoSvg, setLogoSvg] = useState<string | null>(null);

  async function handleLogoUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.name.toLowerCase().endsWith('.svg')) return;
    const raw = await file.text();
    // Sanitize before ever rendering -- an uploaded SVG is untrusted input
    // and could otherwise carry <script>/onload payloads (stored XSS).
    const clean = DOMPurify.sanitize(raw, { USE_PROFILES: { svg: true, svgFilters: true } });
    setLogoSvg(clean);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    // Read straight from the DOM rather than React state: browser autofill
    // (and some password managers) set the input's value directly without
    // firing a React "input"/"change" event, so controlled `value`/`onChange`
    // state can silently stay empty/stale even though the field looks
    // filled on screen. Reading .value here always reflects what's actually
    // in the field at submit time.
    const username = usernameRef.current?.value.trim() ?? '';
    const password = passwordRef.current?.value ?? '';
    await login(username, password);
  }

  return (
    <div style={styles.wrap}>
      <form className="card" style={styles.card} onSubmit={handleSubmit}>
        <label style={styles.logoSlot} title="Логотип компании (SVG)">
          {logoSvg ? (
            <span dangerouslySetInnerHTML={{ __html: logoSvg }} style={styles.logoImg} />
          ) : (
            <span style={styles.logoPlaceholder}>+ Логотип (SVG)</span>
          )}
          <input type="file" accept=".svg,image/svg+xml" onChange={handleLogoUpload} style={{ display: 'none' }} />
        </label>

        <h1 style={styles.title}>Nexus IoT Platform</h1>

        <label style={styles.label}>
          Логин
          <input ref={usernameRef} name="username" defaultValue="admin" autoComplete="username" />
        </label>
        <label style={styles.label}>
          Пароль
          <input ref={passwordRef} name="password" type="password" defaultValue="" autoComplete="current-password" />
        </label>

        {error && <div style={styles.error}>{error}</div>}

        <button type="submit" className="btn primary" style={{ width: '100%', marginTop: 12 }} disabled={loading}>
          {loading ? 'Входим…' : 'Войти'}
        </button>

        <p style={styles.hint}>По умолчанию: admin / admin</p>
      </form>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  wrap: { display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100%', padding: 24 },
  card: { width: 340, padding: '28px 28px 22px', display: 'flex', flexDirection: 'column', alignItems: 'stretch' },
  logoSlot: {
    alignSelf: 'center',
    width: 96,
    height: 96,
    borderRadius: 12,
    border: '1px dashed var(--border)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 18,
    cursor: 'pointer',
    overflow: 'hidden'
  },
  logoImg: { width: '80%', height: '80%', display: 'flex', alignItems: 'center', justifyContent: 'center' },
  logoPlaceholder: { fontSize: 11, color: 'var(--muted)', textAlign: 'center', padding: 8 },
  title: { fontSize: 18, textAlign: 'center', margin: '0 0 20px' },
  label: { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: 'var(--muted)', marginBottom: 12 },
  error: { color: 'var(--danger)', fontSize: 13, marginBottom: 8 },
  hint: { fontSize: 11, color: 'var(--muted)', textAlign: 'center', marginTop: 14 }
};
