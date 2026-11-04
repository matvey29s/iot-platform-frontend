import { useCallback, useEffect, useState } from 'react';
import * as api from '../api';
import type { VarFormat, VariableView } from '../api/types';

const FORMATS: Record<VarFormat, string> = { bool: 'bool (вкл/выкл)', int: 'int (целое)', float: 'float (дробное)', string: 'string (текст)' };
const SKIP_KEY = 'nexus_var_convert_skip';

function skipWarning(): boolean {
  try {
    return localStorage.getItem(SKIP_KEY) === '1';
  } catch {
    return false;
  }
}

/** Format of what the user typed: true/false -> bool, 12 -> int, 1.5 -> float, anything else -> string. */
function literalFormat(t: string): VarFormat {
  const x = t.trim().toLowerCase();
  if (x === 'true' || x === 'false') return 'bool';
  if (/^-?\d+$/.test(x)) return 'int';
  if (/^-?\d*[.,]\d+$/.test(x)) return 'float';
  return 'string';
}

function fmtValue(v: VariableView): string {
  if (v.value === null || v.value === undefined) return '—';
  if (v.format === 'bool') return v.value ? 'true' : 'false';
  return String(v.value);
}

interface Pending {
  target: VariableView;
  text: string;
  fromVar: boolean;
  srcFormat: VarFormat;
}

export default function VariablesPage() {
  const [vars, setVars] = useState<VariableView[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [notes, setNotes] = useState<string[]>([]); // the alert at the top: every conversion that happened
  const [pending, setPending] = useState<Pending | null>(null);
  const [dontShow, setDontShow] = useState(false);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [descDraft, setDescDraft] = useState<Record<string, string>>({});
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState('');
  const [newFormat, setNewFormat] = useState<VarFormat>('int');

  const load = useCallback(() => {
    api.fetchVariables().then((v) => { setVars(v); setErr(null); }).catch(() => setErr('Нет связи с контроллером'));
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 1000);
    const unsub = api.subscribeLive((e) => {
      if (e.type === 'variable' || e.type === 'io_led' || e.type === 'io_button' || e.type === 'port_state') load();
    });
    return () => { clearInterval(t); unsub(); };
  }, [load]);

  async function doAssign(p: Pending) {
    const body = p.fromVar ? { name: p.target.name, from: p.text.trim() } : { name: p.target.name, value: parseLiteral(p.text) };
    const res = await api.setVariable(body);
    if (!res.ok) {
      setErr(res.error ?? 'Не удалось присвоить значение');
      return;
    }
    setErr(null);
    if (p.srcFormat !== p.target.format) {
      const msg = `${p.target.name}: значение (${p.srcFormat}) преобразовано в ${p.target.format}`;
      setNotes((n) => [msg, ...n.filter((x) => x !== msg)].slice(0, 5));
    }
    setDraft((d) => ({ ...d, [p.target.name]: '' }));
    load();
  }

  function parseLiteral(t: string): unknown {
    const f = literalFormat(t);
    if (f === 'bool') return t.trim().toLowerCase() === 'true';
    if (f === 'int' || f === 'float') return Number(t.trim().replace(',', '.'));
    return t;
  }

  function assign(target: VariableView) {
    const text = (draft[target.name] ?? '').trim();
    if (!text) return;
    const src = vars.find((v) => v.name.toUpperCase() === text.toUpperCase());
    const fromVar = !!src;
    const srcFormat: VarFormat = src ? src.format : literalFormat(text);
    const p: Pending = { target, text, fromVar, srcFormat };
    if (srcFormat !== target.format && !skipWarning()) {
      setDontShow(false);
      setPending(p);
      return;
    }
    void doAssign(p);
  }

  async function confirmPending() {
    if (!pending) return;
    if (dontShow) {
      try {
        localStorage.setItem(SKIP_KEY, '1');
      } catch {
        /* storage unavailable: the warning simply stays on */
      }
    }
    const p = pending;
    setPending(null);
    await doAssign(p);
  }

  async function saveDesc(v: VariableView) {
    const text = descDraft[v.name];
    if (text === undefined || text === v.description) return;
    await api.saveVariable({ name: v.name, description: text });
    setDescDraft((d) => { const n = { ...d }; delete n[v.name]; return n; });
    load();
  }

  async function addVar() {
    const name = newName.trim();
    if (!name) return;
    const res = await api.saveVariable({ name, format: newFormat, description: '' });
    if (!res.ok) { setErr(res.error ?? 'Не удалось создать переменную'); return; }
    setNewName('');
    setAdding(false);
    load();
  }

  const SRC: Record<string, string> = { button: 'кнопка', led: 'светодиод', relay: 'реле', rs485: 'RS-485', custom: 'своя' };

  return (
    <div style={{ padding: 24, maxWidth: 1200 }}>
      <h1 style={{ fontSize: 18, margin: '0 0 12px' }}>Переменные</h1>

      {notes.length > 0 && (
        <div role="alert" style={{ padding: '10px 14px', marginBottom: 12, background: 'rgba(255,200,61,0.15)', border: '1px solid #FFC83D', borderRadius: 8, fontSize: 13 }}>
          <b>Внимание, преобразование формата:</b>
          {notes.map((n) => <div key={n}>{n}</div>)}
          <button className="btn" style={{ marginTop: 6 }} onClick={() => setNotes([])}>Скрыть</button>
        </div>
      )}
      {err && <div role="alert" style={{ padding: '8px 12px', marginBottom: 12, border: '1px solid var(--danger)', borderRadius: 8, fontSize: 13, color: 'var(--danger)' }}>{err}</div>}

      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ textAlign: 'left', color: 'var(--muted)', fontSize: 11 }}>
              <th style={th}>Имя</th><th style={th}>Формат</th><th style={th}>Значение</th><th style={th}>Присвоить (число или переменная)</th><th style={th}>Описание</th><th style={th}>Источник</th><th style={th} />
            </tr>
          </thead>
          <tbody>
            {vars.map((v) => (
              <tr key={v.name} style={{ borderTop: '1px solid var(--border)' }}>
                <td style={td}><b>{v.name}</b></td>
                <td style={td}>{v.format}</td>
                <td style={{ ...td, fontVariantNumeric: 'tabular-nums', color: v.format === 'bool' && v.value ? 'var(--accent)' : undefined }}>{fmtValue(v)}</td>
                <td style={td}>
                  {v.writable ? (
                    <div style={{ display: 'flex', gap: 4 }}>
                      <input
                        list="var-names"
                        style={{ width: 150 }}
                        value={draft[v.name] ?? ''}
                        placeholder={v.format === 'bool' ? 'true / false' : 'значение'}
                        onChange={(e) => setDraft((d) => ({ ...d, [v.name]: e.target.value }))}
                        onKeyDown={(e) => e.key === 'Enter' && assign(v)}
                      />
                      <button className="btn" onClick={() => assign(v)}>=</button>
                    </div>
                  ) : (
                    <span style={{ color: 'var(--muted)' }}>только чтение</span>
                  )}
                </td>
                <td style={td}>
                  <input
                    style={{ width: '100%', minWidth: 180 }}
                    value={descDraft[v.name] ?? v.description}
                    placeholder="заметка"
                    onChange={(e) => setDescDraft((d) => ({ ...d, [v.name]: e.target.value }))}
                    onBlur={() => void saveDesc(v)}
                    onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
                  />
                </td>
                <td style={{ ...td, color: 'var(--muted)' }}>{SRC[v.source] ?? v.source}</td>
                <td style={td}>
                  {v.deletable && <button className="btn" title="Удалить переменную" onClick={() => void api.deleteVariable(v.name).then(load)}>✕</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <datalist id="var-names">{vars.map((v) => <option key={v.name} value={v.name} />)}</datalist>

      <div style={{ marginTop: 14 }}>
        {adding ? (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <input placeholder="имя (без пробелов)" value={newName} onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void addVar()} />
            <select value={newFormat} onChange={(e) => setNewFormat(e.target.value as VarFormat)}>
              {(Object.keys(FORMATS) as VarFormat[]).map((f) => <option key={f} value={f}>{FORMATS[f]}</option>)}
            </select>
            <button className="btn primary" onClick={() => void addVar()}>Добавить</button>
            <button className="btn" onClick={() => setAdding(false)}>Отмена</button>
          </div>
        ) : (
          <button className="btn" onClick={() => setAdding(true)}>+ Своя переменная</button>
        )}
      </div>

      {pending && (
        <div style={backdrop} onClick={(e) => e.target === e.currentTarget && setPending(null)}>
          <div className="card" style={{ width: 420, padding: '20px 24px' }} role="dialog" aria-modal="true">
            <h2 style={{ fontSize: 15, margin: '0 0 8px' }}>Преобразование формата</h2>
            <p style={{ fontSize: 13, margin: '0 0 12px' }}>
              Значение «{pending.text}» имеет формат <b>{pending.srcFormat}</b>, а переменная <b>{pending.target.name}</b> — <b>{pending.target.format}</b>. Значение будет преобразовано, часть информации может быть потеряна (например, дробная часть).
            </p>
            <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12, color: 'var(--muted)' }}>
              <input type="checkbox" checked={dontShow} onChange={(e) => setDontShow(e.target.checked)} />
              Больше не показывать это окно (предупреждение вверху страницы останется)
            </label>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
              <button className="btn" onClick={() => setPending(null)}>Отмена</button>
              <button className="btn primary" onClick={() => void confirmPending()}>Присвоить</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const th: React.CSSProperties = { padding: '6px 8px', fontWeight: 500 };
const td: React.CSSProperties = { padding: '6px 8px', verticalAlign: 'middle' };
const backdrop: React.CSSProperties = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 };
