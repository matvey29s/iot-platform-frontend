import { useEffect, useState } from 'react';
import * as api from '../api/mockApi';
import type { ModuleType, PortState } from '../api/types';
import { PORT_META } from '../data/portMeta';
import DeviceDiagram from '../components/DeviceDiagram';
import ModuleConfigModal from '../components/ModuleConfigModal';

export default function DevicePage() {
  const [ports, setPorts] = useState<PortState[]>([]);
  const [hovered, setHovered] = useState<string | null>(null);
  const [configTarget, setConfigTarget] = useState<{ id: string; type: ModuleType } | null>(null);

  useEffect(() => {
    api.fetchPorts().then(setPorts);
    return api.subscribeLive((event) => {
      if (event.type === 'port_state') {
        setPorts((prev) => prev.map((p) => (p.id === event.payload.id ? event.payload : p)));
      }
    });
  }, []);

  const byId = new Map(ports.map((p) => [p.id, p]));

  function openConfig(id: string) {
    const port = byId.get(id);
    if (id === 'modules' && port?.connected && port.detectedType) {
      setConfigTarget({ id, type: port.detectedType });
    }
  }

  const hoveredPort = hovered ? byId.get(hovered) : undefined;

  return (
    <div style={styles.page}>
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

      {configTarget && (
        <ModuleConfigModal portId={configTarget.id} moduleType={configTarget.type} onClose={() => setConfigTarget(null)} />
      )}
    </div>
  );
}

function Tooltip({ port }: { port: PortState }) {
  const meta = PORT_META[port.id];
  return (
    <div className="card" style={styles.tooltip} role="status">
      <b>{meta?.title ?? port.id}</b>
      {meta && <div style={{ color: 'var(--muted)', marginTop: 2 }}>{meta.description}</div>}
      {meta && <div style={{ color: 'var(--muted)', marginTop: 2 }}>Подключается: {meta.connectTo}</div>}
      <div style={{ marginTop: 4, color: port.connected ? 'var(--accent)' : 'var(--danger)' }}>
        {port.connected ? 'Подключено' : 'Не подключено'}
        {port.detectedType && ` (${port.detectedType})`}
      </div>
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
  tooltip: { maxWidth: 360, padding: '10px 14px', fontSize: 12, background: 'var(--surface-2)' }
};
