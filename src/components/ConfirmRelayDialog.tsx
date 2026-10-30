import { useEffect, useState } from 'react';

const SKIP_KEY = 'nexus.relayConfirm.skip';

/** True when the user ticked "don't show again" earlier (per browser). */
export function relayConfirmSkipped(): boolean {
  try {
    return localStorage.getItem(SKIP_KEY) === '1';
  } catch {
    return false;
  }
}

interface Props {
  name: string;
  turnOn: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

/** Full-page warning shown before the relay is switched by hand from the web UI. */
export default function ConfirmRelayDialog({ name, turnOn, onCancel, onConfirm }: Props) {
  const [dontAsk, setDontAsk] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onCancel();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  function confirm() {
    if (dontAsk) {
      try {
        localStorage.setItem(SKIP_KEY, '1');
      } catch {
        /* storage unavailable: the question will simply be asked again */
      }
    }
    onConfirm();
  }

  return (
    <div style={styles.backdrop} role="alertdialog" aria-modal="true" aria-labelledby="relay-confirm-title">
      <div className="card" style={styles.box}>
        <h2 id="relay-confirm-title" style={{ fontSize: 18, margin: '0 0 8px' }}>
          Подтвердите действие
        </h2>
        <p style={{ margin: '0 0 6px', fontSize: 14 }}>
          Вы собираетесь <b>{turnOn ? 'включить' : 'выключить'}</b> реле <b>{name}</b> вручную.
        </p>
        <p style={{ margin: '0 0 16px', fontSize: 13, color: 'var(--muted)' }}>
          Состояние подключённой к реле нагрузки изменится сразу. Убедитесь, что вы осознаёте, что делаете.
        </p>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, marginBottom: 18, cursor: 'pointer' }}>
          <input type="checkbox" checked={dontAsk} onChange={(e) => setDontAsk(e.target.checked)} />
          Больше не показывать
        </label>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button className="btn" onClick={onCancel} autoFocus>Отмена</button>
          <button className="btn primary" onClick={confirm}>Да, {turnOn ? 'включить' : 'выключить'}</button>
        </div>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  backdrop: { position: 'fixed', inset: 0, zIndex: 200, background: 'rgba(0,0,0,0.72)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 },
  box: { width: 440, maxWidth: '100%', padding: '22px 24px', background: 'var(--surface-2)', boxShadow: '0 16px 48px rgba(0,0,0,0.6)' }
};
