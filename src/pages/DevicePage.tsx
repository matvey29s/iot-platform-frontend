import { useEffect, useState } from 'react';
import * as api from '../api';
import type { ModuleType, PortState, SlotState } from '../api/types';
import { PORT_META } from '../data/portMeta';
import DeviceDiagram from '../components/DeviceDiagram';
import ModuleConfigModal from '../components/ModuleConfigModal';

export default function DevicePage() {
  const [ports, setPorts] = useState<PortState[]>([]);
  const [hovered, setHovered] = useState<string | null>(null);
  const [configTarget, setConfigTarget] = useState<{ id: string; type: ModuleType } | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    const load = () => api.fetchPorts().then(setPorts).catch(() => {});
    load();
    const poll = setInterval(load, 5000); // safety net in case a live event was missed
    const unsub = api.subscribeLive((event) => {
      if (event.type === 'port_state') {
        setPorts((prev) => prev.map((p) => (p.id === event.payload.id ? event.payload : p)));
      }
    });
    return () => {
      clearInterval(poll);
      unsub();
    };
  }, []);

  const byId = new Map(ports.map((p) => [p.id, p]));

  const slots = (byId.get('modules')?.slots ?? []).filter((s) => s.connected && s.detectedType);

  function openSlot(s: SlotState) {
    setMenu(null);
    setConfigTarget({ id: `module${s.slot}`, type: s.detectedType! });
  }

  function openConfig(id: string, x: number, y: number) {
    if (id !== 'modules') return;
    if (slots.length === 1) openSlot(slots[0]);
    else if (slots.length > 1) setMenu({ x, y });
  }

  const hoveredPort = hovered ? byId.get(hovered) : undefined;

  return (
    <div style={styles.page} onClick={() => menu && setMenu(null)}>
      <header style={styles.header}>
        <h1 style={styles.title}>Устройство</h1>
        <p style={styles.hint}>Наведите курсор на элемент для описания. ПКМ по «Modules» — настройка подключённого модуля.</p>
      </header>

      {/* SVG centered both horizontally and vertically in the available area */}
      <div style={styles.stage}>
        <div style={styles.diagram}>
          <DeviceDiagram ports={ports} onHover={setHovered} onContextMenu={openConfig} />
        </div>
      </div>

      <div style={styles.tooltipSlot}>{hoveredPort && <Tooltip port={hoveredPort} />}</div>

      {menu && (
        <div className="card" style={{ ...styles.menu, left: menu.x, top: menu.y }} role="menu" onClick={(e) => e.stopPropagation()}>
          {slots.map((sl) => (
            <button key={sl.slot} className="btn" role="menuitem" style={{ display: 'block', width: '100%', textAlign: 'left' }} onClick={() => openSlot(sl)}>
              Модуль {sl.slot}: {typeLabel(sl.detectedType)} — настроить
            </button>
          ))}
        </div>
      )}

      {configTarget && (
        <ModuleConfigModal portId={configTarget.id} moduleType={configTarget.type} onClose={() => setConfigTarget(null)} />
      )}
    </div>
  );
}

function typeLabel(t: ModuleType | null) {
  return t === 'rs485' ? 'RS-485 (UART)' : t === 'relay' ? 'Реле (GPIO)' : '—';
}

function Tooltip({ port }: { port: PortState }) {
  const meta = PORT_META[port.id];
  return (
    <div className="card" style={styles.tooltip} role="status">
      <b>{meta?.title ?? port.id}</b>
      {meta && <div style={{ color: 'var(--muted)', marginTop: 2 }}>{meta.description}</div>}
      {meta && <div style={{ color: 'var(--muted)', marginTop: 2 }}>Подключается: {meta.connectTo}</div>}
      {port.slots ? (
        <div style={{ marginTop: 6 }}>
          {port.slots.map((sl) => (
            <div key={sl.slot} style={{ color: sl.connected ? 'var(--accent)' : 'var(--danger)' }}>
              Модуль {sl.slot}: {sl.connected ? typeLabel(sl.detectedType) : 'не подключён'}
              <span style={{ color: 'var(--muted)' }}>
                {' '}
                · АЦП{sl.slot - 1}: {sl.adcOk ? `${sl.adcPercent.toFixed(0)}%` : 'нет данных'}
              </span>
            </div>
          ))}
        </div>
      ) : (
        <div style={{ marginTop: 4, color: port.connected ? 'var(--accent)' : 'var(--danger)' }}>
          {port.connected ? 'Подключено' : 'Не подключено'}
        </div>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  page: { position: 'relative', minHeight: '100%', display: 'flex', flexDirection: 'column', padding: 24 },
  header: { position: 'absolute', top: 24, left: 24, right: 24 },
  title: { fontSize: 18, margin: '0 0 4px' },
  hint: { color: 'var(--muted)', fontSize: 13, margin: 0 },
  stage: { flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 0 },
  diagram: { width: 'min(900px, 100%)' },
  tooltipSlot: { position: 'absolute', left: 0, right: 0, bottom: 24, display: 'flex', justifyContent: 'center', pointerEvents: 'none', minHeight: 96 },
  menu: { position: 'fixed', zIndex: 50, padding: 6, minWidth: 220, background: 'var(--surface-2)' },
  tooltip: { maxWidth: 360, padding: '10px 14px', fontSize: 12, background: 'var(--surface-2)' }
};
