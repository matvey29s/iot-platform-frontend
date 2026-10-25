import { NODE_DEFS } from './nodeDefs';
import { NodeIcon } from './NodeIcons';
import type { ScenarioNodeType } from '../api/types';

const GROUPS: { title: string; types: ScenarioNodeType[] }[] = [
  { title: 'Логика', types: ['if_else', 'while'] },
  { title: 'RS-485', types: ['rs485_receive', 'rs485_parse', 'rs485_send'] },
  { title: 'Реле', types: ['relay_set'] }
];

export default function NodePalette() {
  function onDragStart(e: React.DragEvent, type: ScenarioNodeType) {
    e.dataTransfer.setData('application/plc-node-type', type);
    e.dataTransfer.effectAllowed = 'move';
  }

  return (
    <aside style={styles.wrap}>
      <div style={styles.title}>Элементы</div>
      {GROUPS.map((g) => (
        <div key={g.title} style={{ marginBottom: 14 }}>
          <div style={styles.groupLabel}>{g.title}</div>
          {g.types.map((t) => {
            const def = NODE_DEFS[t];
            return (
              <div
                key={t}
                draggable
                onDragStart={(e) => onDragStart(e, t)}
                title={def.tooltip}
                style={{ ...styles.item, borderColor: def.color }}
              >
                <span style={{ width: 34, height: 34, borderRadius: 9, background: `${def.color}22`, border: `1px solid ${def.color}66`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  <NodeIcon type={t} size={24} color={def.color} />
                </span>
                {def.label}
              </div>
            );
          })}
        </div>
      ))}
      <p style={styles.hint}>Перетащите элемент на холст. Наведите курсор для подсказки.</p>
    </aside>
  );
}

const styles: Record<string, React.CSSProperties> = {
  wrap: { width: 220, borderLeft: '1px solid var(--border)', background: 'var(--surface)', padding: 14, overflow: 'auto' },
  title: { fontWeight: 700, fontSize: 13, marginBottom: 12 },
  groupLabel: { fontSize: 11, color: 'var(--muted)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.04 },
  item: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '8px 10px',
    marginBottom: 6,
    borderRadius: 6,
    border: '1px solid',
    background: 'var(--surface-2)',
    fontSize: 12,
    cursor: 'grab'
  },
  hint: { fontSize: 11, color: 'var(--muted)', marginTop: 12 }
};
