import { useEffect, useState } from 'react';
import * as api from '../api';
import type { IOState, ModuleType, PortState } from '../api/types';
import { BUTTON_META, LED_META, PORT_META } from '../data/portMeta';
import DeviceDiagram from '../components/DeviceDiagram';
import ModuleConfigModal from '../components/ModuleConfigModal';
import Rs485Terminal from '../components/Rs485Terminal';

const TYPE_LABEL: Record<string, string> = { rs485: 'RS-485 (UART)', relay: 'Реле (GPIO)' };

function ago(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} с назад`;
  if (s < 3600) return `${Math.floor(s / 60)} мин назад`;
  if (s < 86400) return `${Math.floor(s / 3600)} ч назад`;
  return `${Math.floor(s / 86400)} дн назад`;
}

export default function DevicePage() {
  const [ports, setPorts] = useState<PortState[]>([]);
  const [io, setIo] = useState<IOState | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const [configTarget, setConfigTarget] = useState<{ id: string; type: ModuleType } | null>(null);
  const [terminal, setTerminal] = useState<number | null>(null);
  const [popover, setPopover] = useState<{ slot: number; x: number; y: number } | null>(null);

  useEffect(() => {
    const load = () => {
      api.fetchPorts().then(setPorts).catch(() => {});
      api.fetchIO().then(setIo).catch(() => {});
    };
    load();
    const poll = setInterval(load, 5000); // safety net in case a live event was missed
    const unsub = api.subscribeLive((event) => {
      if (event.type === 'port_state') {
        setPorts((prev) => (prev.some((p) => p.id === event.payload.id) ? prev.map((p) => (p.id === event.payload.id ? event.payload : p)) : [...prev, event.payload]));
      } else if (event.type === 'port_adc') {
        setPorts((prev) => prev.map((p) => (p.id === event.payload.id ? { ...p, adcPercent: event.payload.adcPercent, adcRaw: event.payload.adcRaw } : p)));
      } else if (event.type === 'io_led') {
        const l = event.payload;
        setIo((cur) => (cur ? { ...cur, leds: cur.leds.map((x) => (x.n === l.n ? l : x)) } : cur));
      } else if (event.type === 'io_button') {
        const b = event.payload;
        setIo((cur) => (cur ? { ...cur, buttons: cur.buttons.map((x) => (x.n === b.n ? b : x)) } : cur));
      }
    });
    return () => {
      clearInterval(poll);
      unsub();
    };
  }, []);

  useEffect(() => {
    if (!hovered || !hovered.startsWith('btn')) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    setNow(Date.now());
    return () => clearInterval(t);
  }, [hovered]);

  const byId = new Map(ports.map((p) => [p.id, p]));

  function openContext(id: string, x: number, y: number) {
    setPopover(null);
    const port = byId.get(id);
    if (!port || port.kind !== 'module' || !port.connected || !port.detectedType) return;
    if (port.detectedType === 'rs485') setTerminal(port.slot ?? 1);
    else setPopover({ slot: port.slot ?? 1, x, y });
  }

  function openSettings(slot: number) {
    const port = byId.get(`module${slot}`);
    if (port?.detectedType) setConfigTarget({ id: `module${slot}`, type: port.detectedType });
  }

  const hint = hovered ? <Tooltip id={hovered} port={byId.get(hovered)} io={io} now={now} /> : null;
  const popPort = popover ? byId.get(`module${popover.slot}`) : undefined;

  return (
    <div style={styles.page} onClick={() => setPopover(null)}>
      <header style={styles.header}>
        <h1 style={styles.title}>Устройство</h1>
        <p style={styles.hint}>
          Наведите курсор на элемент для описания. ПКМ по модулю: RS-485 — терминал, реле — состояние каналов.
        </p>
      </header>

      <div style={styles.stage}>
        <div style={styles.diagram}>
          <DeviceDiagram ports={ports} io={io} onHover={setHovered} onContextMenu={openContext} />
        </div>
      </div>

      <div style={styles.tooltipSlot}>{hint}</div>

      {popover && popPort && (
        <div className="card" style={{ ...styles.popover, left: Math.min(popover.x, window.innerWidth - 280), top: Math.min(popover.y, window.innerHeight - 260) }} role="dialog" onClick={(e) => e.stopPropagation()}>
          <b>Модуль {popover.slot} — реле</b>
          <div style={{ color: 'var(--muted)', fontSize: 12, margin: '2px 0 8px' }}>
            АЦП: {popPort.adcOk ? `${(popPort.adcPercent ?? 0).toFixed(1)}%` : 'нет данных'}
          </div>
          {[0, 1, 2, 3].map((i) => {
            const on = !!popPort.relays?.[i];
            return (
              <div key={i} style={{ display: 'flex', justifyContent: 'space-between', gap: 24, padding: '3px 0', fontSize: 13 }}>
                <span>Канал {i + 1}</span>
                <span style={{ color: on ? 'var(--success)' : 'var(--muted)', fontWeight: 600 }}>● {on ? 'включено' : 'выключено'}</span>
              </div>
            );
          })}
          <button className="btn" style={{ marginTop: 10, width: '100%' }} onClick={() => { setPopover(null); openSettings(popover.slot); }}>
            Настройки модуля
          </button>
        </div>
      )}

      {terminal !== null && <Rs485Terminal slot={terminal} onClose={() => setTerminal(null)} onSettings={() => openSettings(terminal)} />}

      {configTarget && <ModuleConfigModal portId={configTarget.id} moduleType={configTarget.type} onClose={() => setConfigTarget(null)} />}
    </div>
  );
}

function Tooltip({ id, port, io, now }: { id: string; port?: PortState; io: IOState | null; now: number }) {
  // buttons
  const bi = BUTTON_META.findIndex((b) => b.id === id);
  if (bi >= 0) {
    const meta = BUTTON_META[bi];
    const btn = io?.buttons.find((b) => b.n === bi); // btn2 -> programmable button 1
    return (
      <div className="card" style={styles.tooltip} role="status">
        <b>{meta.title}</b>
        {meta.gpio === null ? (
          <div style={{ color: 'var(--muted)', marginTop: 2 }}>{meta.note}</div>
        ) : (
          <>
            <div style={{ color: 'var(--muted)', marginTop: 2 }}>Программируемая кнопка, GPIO{meta.gpio}. Используется в сценарии.</div>
            <div style={{ marginTop: 4 }}>
              {btn?.pressed ? <span style={{ color: 'var(--accent)' }}>Сейчас нажата</span> : 'Не нажата'}
            </div>
            <div style={{ marginTop: 2 }}>
              Последнее нажатие:{' '}
              {btn && btn.lastPressedAt > 0 ? (
                <b>{new Date(btn.lastPressedAt).toLocaleString('ru-RU')} ({ago(now - btn.lastPressedAt)})</b>
              ) : (
                <b>ещё не нажимали</b>
              )}
            </div>
          </>
        )}
      </div>
    );
  }
  // LEDs
  const li = LED_META.findIndex((l) => l.id === id);
  if (li >= 0) {
    const meta = LED_META[li];
    const led = io?.leds.find((l) => l.n === li);
    return (
      <div className="card" style={styles.tooltip} role="status">
        <b>{meta.title}</b>
        {meta.gpio === null ? (
          <div style={{ color: 'var(--muted)', marginTop: 2 }}>{meta.note}</div>
        ) : (
          <>
            <div style={{ color: 'var(--muted)', marginTop: 2 }}>Программируемый светодиод, GPIO{meta.gpio}. Управляется сценарием.</div>
            <div style={{ marginTop: 4, color: led?.on ? 'var(--accent)' : 'var(--muted)' }}>{led?.on ? 'Горит' : 'Выключен'}</div>
          </>
        )}
      </div>
    );
  }
  // ports and modules
  const meta = PORT_META[id];
  return (
    <div className="card" style={styles.tooltip} role="status">
      <b>{meta?.title ?? id}</b>
      {meta && <div style={{ color: 'var(--muted)', marginTop: 2 }}>{meta.description}</div>}
      {port?.kind === 'module' ? (
        <div style={{ marginTop: 6 }}>
          <div style={{ color: port.connected ? 'var(--accent)' : 'var(--danger)' }}>
            {port.connected ? `Подключён: ${TYPE_LABEL[port.detectedType ?? ''] ?? port.detectedType}` : 'Не подключён'}
            <span style={{ color: 'var(--muted)' }}> · АЦП: {port.adcOk ? `${(port.adcPercent ?? 0).toFixed(1)}%` : 'нет данных'}</span>
          </div>
          {port.detectedType === 'relay' && (
            <div style={{ marginTop: 4, display: 'flex', gap: 14, flexWrap: 'wrap' }}>
              {[0, 1, 2, 3].map((i) => (
                <span key={i} style={{ color: port.relays?.[i] ? 'var(--success)' : 'var(--muted)' }}>
                  К{i + 1}: {port.relays?.[i] ? 'вкл' : 'выкл'}
                </span>
              ))}
            </div>
          )}
        </div>
      ) : (
        id !== 'mpu' && (
          <div style={{ marginTop: 4, color: port?.connected ? 'var(--accent)' : 'var(--danger)' }}>
            {port?.connected ? 'Подключено' : 'Не подключено'}
          </div>
        )
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  page: { position: 'relative', minHeight: '100%', display: 'flex', flexDirection: 'column', padding: 24 },
  header: { position: 'absolute', top: 24, left: 24, right: 24 },
  title: { fontSize: 18, margin: '0 0 4px' },
  hint: { color: 'var(--muted)', fontSize: 13, margin: 0 },
  stage: { flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 0, padding: '56px 0 112px' },
  // the picture is ~square: keep it, the header and the hover card inside the window height
  diagram: { width: 'min(600px, 100%, calc((100vh - 190px) * 1.04))' },
  tooltipSlot: { position: 'absolute', left: 0, right: 0, bottom: 24, display: 'flex', justifyContent: 'center', pointerEvents: 'none', minHeight: 96 },
  tooltip: { maxWidth: 420, padding: '10px 14px', fontSize: 12, background: 'var(--surface-2)' },
  popover: { position: 'fixed', zIndex: 50, padding: '12px 14px', minWidth: 240, background: 'var(--surface-2)', boxShadow: '0 10px 30px rgba(0,0,0,0.45)' }
};
