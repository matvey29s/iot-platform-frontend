import { useEffect, useState } from 'react';
import * as api from '../api';
import type { EthInfo, IOState, ModuleType, PortState } from '../api/types';
import { BUTTON_META, LED_META, PORT_META } from '../data/portMeta';
import ConfirmRelayDialog, { relayConfirmSkipped } from '../components/ConfirmRelayDialog';
import DeviceDiagram from '../components/DeviceDiagram';
import ModuleConfigModal from '../components/ModuleConfigModal';
import Rs485Terminal from '../components/Rs485Terminal';

const TYPE_LABEL: Record<string, string> = { rs485: 'модуль RS-485 (UART)', relay: 'релейный модуль (GPIO)' };

function fmtBytes(n: number) {
  if (n < 1024) return `${n} Б`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} КБ`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} МБ`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} ГБ`;
}
function fmtRate(n: number) {
  return `${fmtBytes(n)}/с`;
}

function ago(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} с назад`;
  if (s < 3600) return `${Math.floor(s / 60)} мин назад`;
  if (s < 86400) return `${Math.floor(s / 3600)} ч назад`;
  return `${Math.floor(s / 86400)} дн назад`;
}

export default function DevicePage() {
  const [ports, setPorts] = useState<PortState[]>([]);
  const [ready, setReady] = useState(false);
  const [eth, setEth] = useState<EthInfo | null>(null);
  const [ethPopover, setEthPopover] = useState<{ x: number; y: number } | null>(null);
  const [confirmRelay, setConfirmRelay] = useState<{ portId: string; name: string; turnOn: boolean } | null>(null);
  const [relayError, setRelayError] = useState<string | null>(null);
  const [io, setIo] = useState<IOState | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const [configTarget, setConfigTarget] = useState<{ id: string; type: ModuleType } | null>(null);
  const [terminal, setTerminal] = useState<number | null>(null);
  const [popover, setPopover] = useState<{ slot: number; x: number; y: number } | null>(null);

  useEffect(() => {
    const load = () => {
      api.fetchPorts().then((p) => { setPorts(p); setReady(true); }).catch(() => setReady(true));
      api.fetchIO().then(setIo).catch(() => {});
    };
    load();
    const poll = setInterval(load, 5000); // safety net in case a live event was missed
    const unsub = api.subscribeLive((event) => {
      if (event.type === 'port_state') {
        setPorts((prev) => (prev.some((p) => p.id === event.payload.id) ? prev.map((p) => (p.id === event.payload.id ? event.payload : p)) : [...prev, event.payload]));
      } else if (event.type === 'port_adc') {
        setPorts((prev) => prev.map((p) => (p.id === event.payload.id ? { ...p, adcPercent: event.payload.adcPercent, adcRaw: event.payload.adcRaw } : p)));
      } else if (event.type === 'ethernet') {
        setEth(event.payload);
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
    setEthPopover(null);
    setRelayError(null);
    if (id === 'ethernet1') {
      api.fetchEthernet().then(setEth).catch(() => setEth(null));
      setEthPopover({ x, y });
      return;
    }
    const port = byId.get(id);
    if (!port || port.kind !== 'module' || !port.connected || !port.detectedType) return;
    if (port.detectedType === 'rs485') setTerminal(port.slot ?? 1);
    else setPopover({ slot: port.slot ?? 1, x, y });
  }

  function openSettings(slot: number) {
    const port = byId.get(`module${slot}`);
    if (port?.detectedType === 'rs485') setConfigTarget({ id: `module${slot}`, type: port.detectedType });
  }

  async function switchRelay(portId: string, turnOn: boolean) {
    setConfirmRelay(null);
    setRelayError(null);
    const res = await api.setRelay(portId, turnOn);
    if (!res.ok) setRelayError(res.error ?? 'Не удалось переключить реле');
  }

  function askRelay(portId: string, name: string, turnOn: boolean) {
    if (relayConfirmSkipped()) void switchRelay(portId, turnOn);
    else setConfirmRelay({ portId, name, turnOn });
  }

  const hint = hovered ? <Tooltip id={hovered} port={byId.get(hovered)} io={io} now={now} /> : null;
  const popPort = popover ? byId.get(`module${popover.slot}`) : undefined;

  return (
    <div style={styles.page} onClick={() => { setPopover(null); setEthPopover(null); }}>
      <header style={styles.header}>
        <h1 style={styles.title}>Устройство</h1>
        <p style={styles.hint}>
          Наведите курсор на элемент для описания. ПКМ: по модулю RS-485 — терминал, по реле — состояние и управление, по Ethernet — данные интерфейса.
        </p>
      </header>

      <div style={styles.stage}>
        <div style={styles.diagram}>
          <DeviceDiagram ports={ports} ready={ready} io={io} onHover={setHovered} onContextMenu={openContext} />
        </div>
      </div>

      <div style={styles.tooltipSlot}>{hint}</div>

      {popover && popPort && (
        <div className="card" style={{ ...styles.popover, left: Math.min(popover.x, window.innerWidth - 280), top: Math.min(popover.y, window.innerHeight - 220) }} role="dialog" onClick={(e) => e.stopPropagation()}>
          <b>{popPort.name ?? 'Реле'}</b>
          <div style={{ color: 'var(--muted)', fontSize: 12, margin: '2px 0 10px' }}>
            АЦП: {popPort.adcOk ? `${(popPort.adcPercent ?? 0).toFixed(1)}%` : 'нет данных'}
          </div>
          {(() => {
            const on = !!popPort.relays?.[0];
            return (
              <>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 24, padding: '3px 0 10px', fontSize: 13 }}>
                  <span>Состояние</span>
                  <span style={{ color: on ? 'var(--success)' : 'var(--muted)', fontWeight: 600 }}>● {on ? 'включено' : 'выключено'}</span>
                </div>
                <button className={`btn ${on ? '' : 'primary'}`} style={{ width: '100%' }} onClick={() => askRelay(popPort.id, popPort.name ?? 'Relay', !on)}>
                  {on ? 'Выключить реле' : 'Включить реле'}
                </button>
              </>
            );
          })()}
          {relayError && <div style={{ color: 'var(--danger)', fontSize: 12, marginTop: 8 }}>{relayError}</div>}
        </div>
      )}

      {ethPopover && (
        <div className="card" style={{ ...styles.popover, minWidth: 300, left: Math.min(ethPopover.x, window.innerWidth - 340), top: Math.min(ethPopover.y, window.innerHeight - 420) }} role="dialog" onClick={(e) => e.stopPropagation()}>
          <EthernetPanel eth={eth} />
        </div>
      )}

      {terminal !== null && <Rs485Terminal slot={terminal} name={byId.get(`module${terminal}`)?.name} onClose={() => setTerminal(null)} onSettings={() => openSettings(terminal)} />}

      {confirmRelay && (
        <ConfirmRelayDialog name={confirmRelay.name} turnOn={confirmRelay.turnOn} onCancel={() => setConfirmRelay(null)} onConfirm={() => void switchRelay(confirmRelay.portId, confirmRelay.turnOn)} />
      )}

      {configTarget && <ModuleConfigModal portId={configTarget.id} title={byId.get(configTarget.id)?.name} moduleType={configTarget.type} onClose={() => setConfigTarget(null)} />}
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
            {port.connected ? `Подключён: ${port.name ?? ''} — ${TYPE_LABEL[port.detectedType ?? ''] ?? port.detectedType}` : 'Не подключён'}
            <span style={{ color: 'var(--muted)' }}> · АЦП: {port.adcOk ? `${(port.adcPercent ?? 0).toFixed(1)}%` : 'нет данных'}</span>
          </div>
          {port.detectedType === 'relay' && (
            <div style={{ marginTop: 4, color: port.relays?.[0] ? 'var(--success)' : 'var(--muted)' }}>
              Реле: {port.relays?.[0] ? 'включено' : 'выключено'}
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

function EthernetPanel({ eth }: { eth: EthInfo | null }) {
  if (!eth) return <div style={{ fontSize: 13, color: 'var(--muted)' }}>Нет данных от daemon.</div>;
  const rows: Array<[string, string]> = [
    ['Интерфейс', eth.iface],
    ['Линк', !eth.exists ? 'интерфейс не найден' : eth.up ? 'есть' : 'нет'],
    ['Скорость', eth.up && eth.speed > 0 ? `${eth.speed} Мбит/с, ${eth.duplex || '—'} duplex` : '—'],
    ['IP-адрес', eth.ip ? `${eth.ip}${eth.mask ? ` / ${eth.mask}` : ''}` : '—'],
    ['MAC', eth.mac || '—'],
    ['MTU', eth.mtu ? String(eth.mtu) : '—'],
    ['Принято', `${fmtBytes(eth.rxBytes)} · ${eth.rxPackets} пак. · ${fmtRate(eth.rxRate)}`],
    ['Отправлено', `${fmtBytes(eth.txBytes)} · ${eth.txPackets} пак. · ${fmtRate(eth.txRate)}`],
    ['Ошибки rx / tx', `${eth.rxErrors} / ${eth.txErrors}`],
    ['Отброшено rx / tx', `${eth.rxDropped} / ${eth.txDropped}`]
  ];
  return (
    <div>
      <b>Ethernet 1</b>
      <div style={{ color: 'var(--muted)', fontSize: 12, margin: '2px 0 8px' }}>
        Данные получены от daemon · {new Date(eth.ts).toLocaleTimeString('ru-RU')}
      </div>
      <table style={{ fontSize: 12, borderCollapse: 'collapse', width: '100%' }}>
        <tbody>
          {rows.map(([k, v]) => (
            <tr key={k}>
              <td style={{ color: 'var(--muted)', padding: '2px 14px 2px 0', whiteSpace: 'nowrap' }}>{k}</td>
              <td style={{ padding: '2px 0', color: k === 'Линк' && eth.up ? 'var(--success)' : undefined }}>{v}</td>
            </tr>
          ))}
        </tbody>
      </table>
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
