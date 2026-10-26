import { useEffect, useRef, useState } from 'react';
import * as api from '../api';
import type { RS485Entry, RS485SendRequest } from '../api/types';

interface Props {
  slot: number;
  onClose: () => void;
  onSettings: () => void;
}

const MAX_LINES = 300;

function fmtTime(ts: number) {
  const d = new Date(ts);
  return d.toLocaleTimeString('ru-RU') + '.' + String(d.getMilliseconds()).padStart(3, '0');
}
function fmtHex(hex: string) {
  return hex.replace(/(..)/g, '$1 ').trim().toUpperCase();
}

/** Small terminal window: everything the module receives (←) and transmits (→). */
export default function Rs485Terminal({ slot, onClose, onSettings }: Props) {
  const [lines, setLines] = useState<RS485Entry[]>([]);
  const [mode, setMode] = useState<RS485SendRequest['mode']>('text');
  const [eol, setEol] = useState<RS485SendRequest['eol']>('crlf');
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<'both' | 'hex' | 'text'>('both');
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    api.fetchRs485Log(slot).then((l) => alive && setLines((cur) => (cur.length ? cur : l.slice(-MAX_LINES))));
    const unsub = api.subscribeLive((e) => {
      if (e.type === 'rs485_data' && e.payload.slot === slot) setLines((cur) => [...cur, e.payload].slice(-MAX_LINES));
    });
    return () => {
      alive = false;
      unsub();
    };
  }, [slot]);

  useEffect(() => {
    const el = boxRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines]);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    if (!text) return;
    setError(null);
    const res = await api.sendRs485(slot, { mode, data: text, eol: mode === 'hex' ? 'none' : eol });
    if (!res.ok) setError(res.error ?? 'Ошибка отправки');
    else setText('');
  }

  return (
    <div className="card" style={styles.win} role="dialog" aria-label={`Терминал RS-485, модуль ${slot}`} onClick={(e) => e.stopPropagation()}>
      <div style={styles.head}>
        <strong style={{ fontSize: 13 }}>Терминал RS-485 · модуль {slot}</strong>
        <span style={{ flex: 1 }} />
        <select value={view} onChange={(e) => setView(e.target.value as typeof view)} aria-label="Вид данных" style={{ fontSize: 11 }}>
          <option value="both">HEX + текст</option>
          <option value="hex">HEX</option>
          <option value="text">Текст</option>
        </select>
        <button className="btn" style={styles.small} onClick={() => setLines([])}>Очистить</button>
        <button className="btn" style={styles.small} onClick={onSettings}>Параметры порта</button>
        <button className="btn" style={styles.small} onClick={onClose} aria-label="Закрыть">✕</button>
      </div>

      <div ref={boxRef} style={styles.log}>
        {lines.length === 0 && <div style={{ color: 'var(--muted)' }}>Данных пока нет. Принятое появится здесь автоматически.</div>}
        {lines.map((l, i) => (
          <div key={i} style={{ display: 'flex', gap: 8, color: l.dir === 'rx' ? '#7be3a4' : '#7cc2ff' }}>
            <span style={{ color: 'var(--muted)', flexShrink: 0 }}>{fmtTime(l.ts)}</span>
            <span style={{ flexShrink: 0 }}>{l.dir === 'rx' ? '←' : '→'}</span>
            <span style={{ wordBreak: 'break-all' }}>
              {view !== 'text' && fmtHex(l.hex)}
              {view === 'both' && '  '}
              {view !== 'hex' && <span style={{ opacity: view === 'both' ? 0.7 : 1 }}>{view === 'both' ? `│${l.text}│` : l.text}</span>}
            </span>
          </div>
        ))}
      </div>

      <form onSubmit={send} style={styles.form}>
        <select value={mode} onChange={(e) => setMode(e.target.value as typeof mode)} aria-label="Формат" style={{ fontSize: 12 }}>
          <option value="text">Текст</option>
          <option value="hex">HEX</option>
        </select>
        <input
          style={{ flex: 1, fontFamily: 'ui-monospace, monospace', fontSize: 12 }}
          value={text}
          placeholder={mode === 'hex' ? '01 03 00 00 00 02 C4 0B' : 'Данные для отправки'}
          onChange={(e) => setText(e.target.value)}
        />
        {mode === 'text' && (
          <select value={eol} onChange={(e) => setEol(e.target.value as typeof eol)} aria-label="Окончание строки" style={{ fontSize: 12 }}>
            <option value="none">без окончания</option>
            <option value="cr">CR</option>
            <option value="lf">LF</option>
            <option value="crlf">CR+LF</option>
          </select>
        )}
        <button className="btn primary" type="submit" style={styles.small}>Отправить</button>
      </form>
      {error && <div style={{ color: 'var(--danger)', fontSize: 12, padding: '0 12px 8px' }}>{error}</div>}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  win: { position: 'fixed', right: 24, bottom: 24, width: 560, maxWidth: 'calc(100vw - 48px)', zIndex: 60, background: '#071a44', padding: 0, overflow: 'hidden', boxShadow: '0 12px 36px rgba(0,0,0,0.5)' },
  head: { display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', borderBottom: '1px solid var(--border)' },
  log: { height: 240, overflow: 'auto', padding: '8px 12px', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12, lineHeight: 1.55, background: '#030f2b' },
  form: { display: 'flex', gap: 8, padding: 10, borderTop: '1px solid var(--border)' },
  small: { padding: '4px 10px', fontSize: 12 }
};
