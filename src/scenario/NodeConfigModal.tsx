import { useEffect, useMemo, useState } from 'react';
import type { Edge, Node } from 'reactflow';
import { MAX_CONDITIONS, MAX_TASKS, NODE_DEFS, conditionsOf } from './nodeDefs';
import type { PortState, RegisterTableRow, ScenarioNodeData } from '../api/types';
import VariableInput from './VariableInput';
import { buildVariables, modulesOfType } from './variables';

interface Props {
  data: ScenarioNodeData;
  /** live data for the drop-downs: connected modules and the whole graph */
  ports: PortState[];
  nodes: Node<ScenarioNodeData>[];
  edges: Edge[];
  onSave: (config: Record<string, unknown>) => void;
  onClose: () => void;
}

const TYPE_SIZE: Record<string, number> = { uint8: 1, int8: 1, bool: 1, uint16: 2, int16: 2, uint32: 4, int32: 4, float32: 4 };
interface SendRow { dataType: string; value: string; order?: string }
interface Cond { variable: string; operator: string; value: string }

function normalize(c: Record<string, unknown>): Record<string, unknown> {
  const out = { ...c };
  if (typeof out.tasks === 'number') out.tasks = Math.min(MAX_TASKS, Math.max(1, Math.round(out.tasks)));
  if (typeof out.priority === 'number') out.priority = Math.max(0, Math.round(out.priority));
  return out;
}

export default function NodeConfigModal({ data, ports, nodes, edges, onSave, onClose }: Props) {
  const def = NODE_DEFS[data.type];
  const [config, setConfig] = useState<Record<string, unknown>>({ ...data.config });

  function set(key: string, value: unknown) {
    setConfig((c) => ({ ...c, [key]: value }));
  }

  const variables = useMemo(() => buildVariables(ports, nodes, edges), [ports, nodes, edges]);

  // a module field that is still empty gets the first connected module of that type
  useEffect(() => {
    for (const f of def.fields) {
      if (f.type !== 'module' || config[f.key]) continue;
      const first = modulesOfType(ports, f.moduleType!)[0];
      if (first?.name) setConfig((c) => ({ ...c, [f.key]: first.name }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ports]);

  const rows = (config.registerTable as RegisterTableRow[]) ?? [];
  // the byte of a row = the sum of the sizes of all rows above it, so it is always recalculated
  const relayout = (list: RegisterTableRow[]): RegisterTableRow[] => {
    let off = 0;
    return list.map((r) => {
      const row = { ...r, byteIndex: off };
      off += TYPE_SIZE[r.dataType] ?? 1;
      return row;
    });
  };
  const setRows = (list: RegisterTableRow[]) => set('registerTable', relayout(list));
  const updateRow = (i: number, patch: Partial<RegisterTableRow>) => setRows(rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  const insertRow = (after: number) => {
    const copy = [...rows];
    copy.splice(after + 1, 0, { byteIndex: 0, name: '', dataType: 'uint8', description: '' });
    setRows(copy);
  };
  const removeRow = (i: number) => setRows(rows.filter((_, idx) => idx !== i));

  const sendRows = (config.rows as SendRow[]) ?? [];
  const setSendRows = (list: SendRow[]) => set('rows', list);
  const conds = conditionsOf(config);
  const setConds = (list: Cond[]) => set('conditions', list);

  return (
    <div style={styles.backdrop} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="card" style={{ ...styles.modal, width: ['rs485_parse', 'rs485_send', 'if_else'].includes(data.type) ? 700 : 420 }}>
        <h2 style={{ fontSize: 15, margin: '0 0 2px' }}>{def.label}</h2>
        <p style={{ fontSize: 11, color: 'var(--muted)', margin: '0 0 14px' }}>{def.tooltip}</p>

        {def.fields.map((f) => {
          if (f.type === 'registerTable') {
            return (
              <div key={f.key}>
                <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 6 }}>{f.label}. Имя строки станет переменной с тем же именем и описанием.</div>
                <table style={styles.table}>
                  <thead>
                    <tr><th>Байт</th><th>Имя</th><th>Тип</th><th>Описание</th><th /></tr>
                  </thead>
                  <tbody>
                    {rows.map((row, i) => (
                      <tr key={i}>
                        <td style={{ width: 44, color: 'var(--muted)' }}>{row.byteIndex}</td>
                        <td><input style={{ width: 110 }} value={row.name} onChange={(e) => updateRow(i, { name: e.target.value })} /></td>
                        <td>
                          <select value={row.dataType} onChange={(e) => updateRow(i, { dataType: e.target.value as RegisterTableRow['dataType'] })}>
                            {Object.keys(TYPE_SIZE).map((t) => <option key={t} value={t}>{t}</option>)}
                          </select>
                        </td>
                        <td><input style={{ width: '100%' }} value={row.description} onChange={(e) => updateRow(i, { description: e.target.value })} /></td>
                        <td style={{ whiteSpace: 'nowrap' }}>
                          <button type="button" className="btn" title="Вставить строку ниже" onClick={() => insertRow(i)}>＋</button>{' '}
                          <button type="button" className="btn" title="Удалить строку" onClick={() => removeRow(i)}>✕</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <button type="button" className="btn" onClick={() => insertRow(rows.length - 1)}>+ Регистр</button>
              </div>
            );
          }
          if (f.type === 'sendTable') {
            let off = 0;
            return (
              <div key={f.key}>
                <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 6 }}>{f.label}. Значение — число или имя переменной; для типа text можно писать {'{'}переменная{'}'} и \r \n.</div>
                <table style={styles.table}>
                  <thead>
                    <tr><th>Байт</th><th>Тип</th><th>Значение / переменная</th><th>Порядок байт</th><th /></tr>
                  </thead>
                  <tbody>
                    {sendRows.map((row, i) => {
                      const start = off;
                      off += row.dataType === 'text' ? String(row.value ?? '').length : TYPE_SIZE[row.dataType] ?? 1;
                      const multi = (TYPE_SIZE[row.dataType] ?? 1) > 1;
                      return (
                        <tr key={i}>
                          <td style={{ width: 44, color: 'var(--muted)' }}>{start}</td>
                          <td>
                            <select value={row.dataType} onChange={(e) => setSendRows(sendRows.map((r, k) => (k === i ? { ...r, dataType: e.target.value } : r)))}>
                              {[...Object.keys(TYPE_SIZE), 'text'].map((t) => <option key={t} value={t}>{t}</option>)}
                            </select>
                          </td>
                          <td>
                            <VariableInput value={String(row.value ?? '')} onChange={(v) => setSendRows(sendRows.map((r, k) => (k === i ? { ...r, value: v } : r)))} options={variables} placeholder="число или переменная" />
                          </td>
                          <td>
                            <select disabled={!multi} value={row.order ?? 'BE'} onChange={(e) => setSendRows(sendRows.map((r, k) => (k === i ? { ...r, order: e.target.value } : r)))}>
                              <option value="BE">старший первым (BE)</option>
                              <option value="LE">младший первым (LE)</option>
                            </select>
                          </td>
                          <td style={{ whiteSpace: 'nowrap' }}>
                            <button type="button" className="btn" title="Вставить строку ниже" onClick={() => { const c = [...sendRows]; c.splice(i + 1, 0, { dataType: 'uint8', value: '0', order: 'BE' }); setSendRows(c); }}>＋</button>{' '}
                            <button type="button" className="btn" title="Удалить строку" onClick={() => setSendRows(sendRows.filter((_, k) => k !== i))}>✕</button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                <button type="button" className="btn" onClick={() => setSendRows([...sendRows, { dataType: 'uint8', value: '0', order: 'BE' }])}>+ Строка</button>
              </div>
            );
          }
          if (f.type === 'conditions') {
            return (
              <div key={f.key}>
                <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 6 }}>{f.label} ({conds.length} из {MAX_CONDITIONS}). Условие №N — выход N блока; out — когда ни одно не выполнено или после выполнения ветки.</div>
                <div style={{ maxHeight: 280, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 6 }}>
                  <table style={{ ...styles.table, marginBottom: 0 }}>
                    <thead style={{ position: 'sticky', top: 0, background: 'var(--surface)' }}>
                      <tr><th style={{ width: 28 }}>№</th><th>Переменная</th><th style={{ width: 70 }}>Оператор</th><th>Значение</th><th style={{ width: 30 }} /></tr>
                    </thead>
                    <tbody>
                      {conds.map((cd, i) => (
                        <tr key={i}>
                          <td style={{ color: 'var(--muted)' }}>{i + 1}</td>
                          <td><VariableInput value={cd.variable} onChange={(v) => setConds(conds.map((x, k) => (k === i ? { ...x, variable: v } : x)))} options={variables} /></td>
                          <td>
                            <select value={cd.operator} onChange={(e) => setConds(conds.map((x, k) => (k === i ? { ...x, operator: e.target.value } : x)))}>
                              {['==', '!=', '>', '<', '>=', '<='].map((o) => <option key={o} value={o}>{o}</option>)}
                            </select>
                          </td>
                          <td><VariableInput value={cd.value} onChange={(v) => setConds(conds.map((x, k) => (k === i ? { ...x, value: v } : x)))} options={variables} /></td>
                          <td><button type="button" className="btn" disabled={conds.length <= 1} onClick={() => setConds(conds.filter((_, k) => k !== i))}>✕</button></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <button type="button" className="btn" style={{ marginTop: 8 }} disabled={conds.length >= MAX_CONDITIONS} onClick={() => setConds([...conds, { variable: 'BTN-1', operator: '==', value: '1' }])}>+ Добавить условие</button>
              </div>
            );
          }
          if (f.type === 'module') {
            const mods = modulesOfType(ports, f.moduleType!);
            const cur = String(config[f.key] ?? '');
            const known = mods.some((m) => m.name === cur);
            return (
              <label key={f.key} style={{ display: 'block', fontSize: 12, color: 'var(--muted)', margin: '0 0 10px' }}>
                {f.label}
                <div style={{ marginTop: 4 }}>
                  <select value={cur} onChange={(e) => set(f.key, e.target.value)} style={{ width: '100%' }}>
                    {cur && !known && <option value={cur}>{cur} (не подключён)</option>}
                    {!cur && mods.length === 0 && <option value="">нет подключённых модулей</option>}
                    {mods.map((m) => (
                      <option key={m.id} value={m.name}>{m.name} — отсек {m.slot}</option>
                    ))}
                  </select>
                </div>
              </label>
            );
          }
          if (f.type === 'variable') {
            return (
              <div key={f.key} style={{ display: 'block', fontSize: 12, color: 'var(--muted)', margin: '0 0 10px' }}>
                {f.label}
                <div style={{ marginTop: 4 }}>
                  <VariableInput
                    value={String(config[f.key] ?? '')}
                    onChange={(v) => set(f.key, v)}
                    options={variables}
                    placeholder="начните вводить имя переменной"
                  />
                </div>
              </div>
            );
          }
          return (
            <label key={f.key} style={{ display: 'block', fontSize: 12, color: 'var(--muted)', margin: '0 0 10px' }}>
              {f.label}
              <div style={{ marginTop: 4 }}>
                {f.type === 'select' ? (
                  <select value={String(config[f.key] ?? '')} onChange={(e) => set(f.key, e.target.value)}>
                    {f.options!.map((o) => <option key={o} value={o}>{f.optionLabels?.[o] ?? o}</option>)}
                  </select>
                ) : (
                  <input
                    type={f.type === 'number' ? 'number' : 'text'}
                    value={String(config[f.key] ?? '')}
                    onChange={(e) => set(f.key, f.type === 'number' ? Number(e.target.value) : e.target.value)}
                  />
                )}
              </div>
            </label>
          );
        })}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
          <button className="btn" onClick={onClose}>Отмена</button>
          <button className="btn primary" onClick={() => onSave(normalize(config))}>Сохранить</button>
        </div>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  backdrop: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 },
  modal: { width: 420, maxHeight: '85vh', overflow: 'auto', padding: '20px 24px' },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 11, marginBottom: 8 }
};
