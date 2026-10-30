import { useEffect, useMemo, useState } from 'react';
import type { Edge, Node } from 'reactflow';
import { NODE_DEFS } from './nodeDefs';
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
  function updateRow(i: number, patch: Partial<RegisterTableRow>) {
    const next = rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r));
    set('registerTable', next);
  }
  function addRow() {
    set('registerTable', [...rows, { byteIndex: rows.length ? rows[rows.length - 1].byteIndex + 2 : 0, name: '', dataType: 'uint16', description: '' }]);
  }
  function removeRow(i: number) {
    set('registerTable', rows.filter((_, idx) => idx !== i));
  }

  return (
    <div style={styles.backdrop} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="card" style={styles.modal}>
        <h2 style={{ fontSize: 15, margin: '0 0 2px' }}>{def.label}</h2>
        <p style={{ fontSize: 11, color: 'var(--muted)', margin: '0 0 14px' }}>{def.tooltip}</p>

        {def.fields.map((f) => {
          if (f.type === 'registerTable') {
            return (
              <div key={f.key}>
                <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 6 }}>{f.label}</div>
                <table style={styles.table}>
                  <thead>
                    <tr><th>Байт</th><th>Имя</th><th>Тип</th><th>Описание</th><th /></tr>
                  </thead>
                  <tbody>
                    {rows.map((row, i) => (
                      <tr key={i}>
                        <td><input type="number" style={{ width: 50 }} value={row.byteIndex} onChange={(e) => updateRow(i, { byteIndex: Number(e.target.value) })} /></td>
                        <td><input style={{ width: 90 }} value={row.name} onChange={(e) => updateRow(i, { name: e.target.value })} /></td>
                        <td>
                          <select value={row.dataType} onChange={(e) => updateRow(i, { dataType: e.target.value as RegisterTableRow['dataType'] })}>
                            {['uint8', 'int8', 'uint16', 'int16', 'uint32', 'int32', 'float32', 'bool'].map((t) => <option key={t} value={t}>{t}</option>)}
                          </select>
                        </td>
                        <td><input style={{ width: 120 }} value={row.description} onChange={(e) => updateRow(i, { description: e.target.value })} /></td>
                        <td><button type="button" className="btn" onClick={() => removeRow(i)}>✕</button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <button type="button" className="btn" onClick={addRow}>+ Регистр</button>
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
                    {f.options!.map((o) => <option key={o} value={o}>{o}</option>)}
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
          <button className="btn primary" onClick={() => onSave(config)}>Сохранить</button>
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
