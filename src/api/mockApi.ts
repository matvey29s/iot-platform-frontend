import type {
  AuthResult,
  LiveEvent,
  ModuleConfig,
  PortState,
  RegisterTableRow,
  Rs485Config,
  RelayConfig,
  ScenarioGraph,
  ScenarioRunStatus,
  SystemInfo,
  SystemSample
} from './types';

// ---------------------------------------------------------------------------
// STUB NOTICE: everything in this file simulates network latency (setTimeout)
// and keeps state in memory only (lost on page reload). When the real Go
// backend is ready, replace the bodies of these functions with
// `fetch('/api/...')` calls and replace `liveChannel` with a real
// `new WebSocket('/ws')` client -- the function signatures and the LiveEvent
// shape are the contract components already code against, so no component
// code should need to change.
// ---------------------------------------------------------------------------

const delay = (ms = 250) => new Promise((res) => setTimeout(res, ms));

// ---- in-memory "database" ---------------------------------------------------

// Matches the ports actually drawn in src/assets/Web_GUI.svg -- see that
// file's <g id="..."> tags. "modules" is the only port with ADC-based type
// detection; the rest are plain connected/present indicators.
const PORT_IDS = {
  fixed: ['power', 'usb', 'audioIn', 'audioOut', 'sdcard', 'lcd'],
  link: ['ethernet1', 'ethernet2'],
  modules: ['modules']
};

const db = {
  ports: new Map<string, PortState>(),
  moduleConfigs: new Map<string, ModuleConfig>(),
  scenarios: new Map<string, ScenarioGraph>(),
  registerTables: new Map<string, RegisterTableRow[]>(),
  scenarioStatus: { running: false, activeNodeId: null, lastError: null } as ScenarioRunStatus,
  system: {
    sampledAt: Date.now(),
    linuxVersion: '5.10.168-ti-am335x',
    cpuModel: 'Sitara AM3352 (ARM Cortex-A8 @ 800MHz)',
    cpuUsagePercent: 12,
    ramTotalMb: 512,
    ramUsedMb: 178,
    uptimeSeconds: 3600 * 5 + 120,
    diskTotalMb: 4096,
    diskUsedMb: 900
  } as SystemInfo
};

function seed() {
  // power is always "ok"; ethernet1 defaults connected since the page is
  // being served over it (mirrors the earlier Go backend's demo defaults)
  db.ports.set('power', { id: 'power', kind: 'fixed', connected: true });
  db.ports.set('ethernet1', { id: 'ethernet1', kind: 'link', connected: true });
  db.ports.set('ethernet2', { id: 'ethernet2', kind: 'link', connected: false });
  db.ports.set('usb', { id: 'usb', kind: 'fixed', connected: false });
  db.ports.set('audioIn', { id: 'audioIn', kind: 'fixed', connected: false });
  db.ports.set('audioOut', { id: 'audioOut', kind: 'fixed', connected: false });
  db.ports.set('sdcard', { id: 'sdcard', kind: 'fixed', connected: true });
  db.ports.set('lcd', { id: 'lcd', kind: 'fixed', connected: true });

  // "modules" bay: demo default = RS-485 already plugged in
  db.ports.set('modules', {
    id: 'modules',
    kind: 'module',
    connected: true,
    slots: [
      { slot: 1, connected: true, detectedType: 'rs485', adcPercent: 20, adcRaw: 819, adcOk: true },
      { slot: 2, connected: true, detectedType: 'relay', adcPercent: 50, adcRaw: 2048, adcOk: true }
    ]
  });
  db.moduleConfigs.set('module1', {
    baudRate: 9600,
    parity: 'none',
    dataBits: 8,
    stopBits: 1,
    devicePath: '/dev/ttyRS485-1',
    protocol: 'modbus_rtu'
  } as Rs485Config);

  db.moduleConfigs.set('module2', { channels: 8, safeState: 'all_off' } as RelayConfig);

  db.registerTables.set('module1', [
    { byteIndex: 0, name: 'temperature', dataType: 'int16', description: 'Температура, x0.1°C' },
    { byteIndex: 2, name: 'humidity', dataType: 'uint16', description: 'Влажность, x0.1%' },
    { byteIndex: 4, name: 'status_flags', dataType: 'uint8', description: 'Битовые флаги состояния' }
  ]);
}
seed();

// ---- Auth --------------------------------------------------------------------

export async function login(username: string, password: string): Promise<AuthResult> {
  await delay(300);
  if (username === 'admin' && password === 'admin') {
    return { ok: true, token: 'mock-token-' + Date.now(), mustChangePassword: true };
  }
  return { ok: false, error: 'Неверный логин или пароль' };
}

// ---- Device tab ----------------------------------------------------------------

export async function fetchPorts(): Promise<PortState[]> {
  await delay();
  return Array.from(db.ports.values());
}

export async function fetchModuleConfig(portId: string): Promise<ModuleConfig | null> {
  await delay(200);
  return db.moduleConfigs.get(portId) ?? null;
}

export async function saveModuleConfig(
  portId: string,
  config: ModuleConfig
): Promise<{ ok: boolean; error?: string }> {
  await delay(300);
  const port = db.ports.get(portId);
  const slot = db.ports.get('modules')?.slots?.find((x) => `module${x.slot}` === portId);
  if (!port && !slot?.connected) {
    return { ok: false, error: 'Модуль не обнаружен в данном слоте' };
  }
  db.moduleConfigs.set(portId, config);
  return { ok: true };
}

// demo-only: simulate plugging/unplugging a module, mirrors the Go backend's
// /api/_simulate/ endpoint from the earlier full-stack build
export async function simulateHotplug(_portId: string, _type: 'rs485' | 'relay' | null): Promise<void> {
  /* unused: real detection now comes from the daemon */
}

// demo-only: toggle a plain fixed/link port (ethernet2, usb, audioIn, ...)
export async function toggleLinkPort(portId: string): Promise<void> {
  await delay(100);
  const port = db.ports.get(portId);
  if (!port || port.kind === 'module') return;
  port.connected = !port.connected;
  db.ports.set(portId, port);
  emit({ type: 'port_state', payload: { ...port } });
}

// ---- Register table (RS-485 parse config) --------------------------------------

export async function fetchRegisterTable(deviceId: string): Promise<RegisterTableRow[]> {
  await delay(200);
  return db.registerTables.get(deviceId) ?? [];
}

export async function saveRegisterTable(deviceId: string, rows: RegisterTableRow[]): Promise<{ ok: boolean }> {
  await delay(250);
  db.registerTables.set(deviceId, rows);
  return { ok: true };
}

// ---- Scenario tab ----------------------------------------------------------------

export async function fetchScenarios(): Promise<ScenarioGraph[]> {
  await delay(200);
  return Array.from(db.scenarios.values());
}

export async function saveScenario(graph: ScenarioGraph): Promise<{ ok: boolean; error?: string }> {
  await delay(300);
  db.scenarios.set(graph.id, graph);
  return { ok: true };
}

export async function startScenario(id: string): Promise<{ ok: boolean; error?: string }> {
  await delay(200);
  if (!db.scenarios.has(id)) return { ok: false, error: 'Сценарий не найден' };
  db.scenarioStatus = { running: true, activeNodeId: null, lastError: null };
  emit({ type: 'scenario_status', payload: { ...db.scenarioStatus } });
  return { ok: true };
}

export async function stopScenario(id: string): Promise<{ ok: boolean }> {
  await delay(200);
  db.scenarioStatus = { running: false, activeNodeId: null, lastError: null };
  emit({ type: 'scenario_status', payload: { ...db.scenarioStatus } });
  return { ok: true };
}

// ---- Monitoring tab ----------------------------------------------------------------

export async function fetchSystemInfo(): Promise<SystemInfo> {
  await delay(200);
  return { ...db.system, sampledAt: Date.now() };
}

/** Backfill for the charts: last `minutes` of samples, one every `stepSec` seconds. */
export async function fetchSystemHistory(minutes = 15, stepSec = 3): Promise<SystemSample[]> {
  await delay(200);
  const now = Date.now();
  const n = Math.floor((minutes * 60) / stepSec);
  const out: SystemSample[] = [];
  for (let i = n; i > 0; i--) {
    const k = n - i;
    out.push({
      sampledAt: now - i * stepSec * 1000,
      cpuUsagePercent: clamp(14 + Math.sin(k / 9) * 7 + Math.sin(k / 3.1) * 3 + (Math.random() - 0.5) * 3, 2, 98),
      ramUsedMb: clamp(170 + k * 0.06 + Math.sin(k / 14) * 8 + (Math.random() - 0.5) * 3, 80, db.system.ramTotalMb - 20),
      ramTotalMb: db.system.ramTotalMb
    });
  }
  return out;
}

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}

// ---- Live channel: stands in for a future `new WebSocket('/ws')` ----------------

type Listener = (event: LiveEvent) => void;
const listeners = new Set<Listener>();

function emit(event: LiveEvent) {
  for (const l of listeners) l(event);
}

export function subscribeLive(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// Background simulation: fake register values ticking, and fake system-info
// refresh, so Scenario/Monitoring screens have something live to render even
// with no backend attached yet.
let simTick = 0;
function tickSim() {
  simTick += 1;

  if (db.ports.get('modules')?.connected) {
    emit({
      type: 'register_value',
      payload: { device: 'RS485-1', index: 0, value: 200 + Math.round(Math.sin(simTick / 5) * 30) }
    });
    emit({
      type: 'register_value',
      payload: { device: 'RS485-1', index: 1, value: 450 + Math.round(Math.cos(simTick / 7) * 20) }
    });
  }

  if (db.scenarioStatus.running) {
    emit({ type: 'scenario_status', payload: { ...db.scenarioStatus } });
  }
}

function tickSystem() {
  db.system.cpuUsagePercent = Math.max(3, Math.min(95, db.system.cpuUsagePercent + (Math.random() * 10 - 5)));
  db.system.ramUsedMb = Math.max(100, Math.min(db.system.ramTotalMb - 20, db.system.ramUsedMb + (Math.random() * 20 - 10)));
  db.system.uptimeSeconds += 3;
  db.system.sampledAt = Date.now();
  emit({ type: 'system_info', payload: { ...db.system } });
}

let simStarted = false;
/** Only for `npm run dev:mock` (no controller). The real build never runs this. */
export function startSimulation() {
  if (simStarted) return;
  simStarted = true;
  setInterval(tickSim, 1000);
  setInterval(tickSystem, 3000);
}

export { PORT_IDS };
