import { useState } from 'react';
import { useAuthStore } from '../store/authStore';

export default function ChangePasswordGate({ children }: { children: React.ReactNode }) {
  const mustChange = useAuthStore((s) => s.mustChangePassword);
  const clear = useAuthStore((s) => s.clearMustChangePassword);
  const [pw1, setPw1] = useState('');
  const [pw2, setPw2] = useState('');
  const [err, setErr] = useState<string | null>(null);

  if (!mustChange) return <>{children}</>;

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (pw1.length < 8) return setErr('Пароль должен быть не короче 8 символов');
    if (pw1 !== pw2) return setErr('Пароли не совпадают');
    // STUB: real implementation will POST /api/auth/change-password here.
    clear();
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
      <form className="card" onSubmit={submit} style={{ width: 340, padding: 24 }}>
        <h2 style={{ fontSize: 16, marginTop: 0 }}>Смените пароль по умолчанию</h2>
        <p style={{ fontSize: 12, color: 'var(--muted)' }}>
          Вы вошли с паролем по умолчанию. Из соображений безопасности задайте новый пароль перед продолжением.
        </p>
        <label style={{ display: 'block', fontSize: 12, color: 'var(--muted)', margin: '10px 0 4px' }}>
          Новый пароль
          <input type="password" value={pw1} onChange={(e) => setPw1(e.target.value)} style={{ width: '100%', marginTop: 4 }} />
        </label>
        <label style={{ display: 'block', fontSize: 12, color: 'var(--muted)', margin: '10px 0 4px' }}>
          Повторите пароль
          <input type="password" value={pw2} onChange={(e) => setPw2(e.target.value)} style={{ width: '100%', marginTop: 4 }} />
        </label>
        {err && <div style={{ color: 'var(--danger)', fontSize: 12, marginTop: 8 }}>{err}</div>}
        <button type="submit" className="btn primary" style={{ width: '100%', marginTop: 14 }}>
          Сохранить и продолжить
        </button>
      </form>
    </div>
  );
}
