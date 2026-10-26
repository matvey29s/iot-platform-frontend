import type {
  AuthResult,
  IOState,
  RS485Entry,
  RS485SendRequest,
  ScenarioRunStatus,
  LiveEvent,
  ModuleConfig,
  PortState,
  RegisterTableRow,
  ScenarioGraph,
  SystemInfo,
  SystemSample
} from './types';

// Real controller API (Go backend). Same function signatures as mockApi.ts.
// URLs are relative ("api/..") so it works from any host, port or sub-folder.

async function http<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`api/${path}`, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as T;
}

const NO_LINK = 'Нет связи с контроллером';

// ---- Auth ------------------------------------------------------------------

export async function login(username: string, password: string): Promise<AuthResult> {
  try {
    return await http<AuthResult>('POST', 'auth/login', { username, password });
  } catch {
    return { ok: false, error: NO_LINK };
  }
}

// ---- Device ----------------------------------------------------------------

export function fetchPorts(): Promise<PortState[]> {
  return http<PortState[]>('GET', 'ports');
}

export function fetchModuleConfig(portId: string): Promise<ModuleConfig | null> {
  return http<ModuleConfig | null>('GET', `modules/${encodeURIComponent(portId)}/config`);
}

export async function saveModuleConfig(portId: string, config: ModuleConfig): Promise<{ ok: boolean; error?: string }> {
  try {
    return await http('PUT', `modules/${encodeURIComponent(portId)}/config`, config);
  } catch {
    return { ok: false, error: NO_LINK };
  }
}

export function fetchRegisterTable(deviceId: string): Promise<RegisterTableRow[]> {
  return http<RegisterTableRow[]>('GET', `modules/${encodeURIComponent(deviceId)}/registers`).catch(() => []);
}

export async function saveRegisterTable(deviceId: string, rows: RegisterTableRow[]): Promise<{ ok: boolean }> {
  try {
    return await http('PUT', `modules/${encodeURIComponent(deviceId)}/registers`, rows);
  } catch {
    return { ok: false };
  }
}

export function fetchIO(): Promise<IOState> {
  return http<IOState>('GET', 'io');
}

export function fetchRs485Log(slot: number): Promise<RS485Entry[]> {
  return http<RS485Entry[]>('GET', `rs485/${slot}/log`).catch(() => []);
}

export async function sendRs485(slot: number, req: RS485SendRequest): Promise<{ ok: boolean; error?: string }> {
  try {
    return await http('POST', `rs485/${slot}/send`, req);
  } catch {
    return { ok: false, error: NO_LINK };
  }
}

// ---- Scenario --------------------------------------------------------------

export function fetchScenarios(): Promise<ScenarioGraph[]> {
  return http<ScenarioGraph[]>('GET', 'scenarios').catch(() => []);
}

export async function saveScenario(graph: ScenarioGraph): Promise<{ ok: boolean; error?: string }> {
  try {
    return await http('PUT', `scenarios/${encodeURIComponent(graph.id)}`, graph);
  } catch {
    // the browser copy (localStorage) is the source of truth for now; never throw into autosave
    return { ok: false, error: NO_LINK };
  }
}

export function fetchScenarioStatus(): Promise<ScenarioRunStatus> {
  return http<ScenarioRunStatus>('GET', 'scenarios/status');
}

export async function startScenario(id: string): Promise<{ ok: boolean; error?: string }> {
  try {
    return await http('POST', `scenarios/${encodeURIComponent(id)}/start`);
  } catch {
    return { ok: false, error: NO_LINK };
  }
}

export async function stopScenario(id: string): Promise<{ ok: boolean }> {
  try {
    return await http('POST', `scenarios/${encodeURIComponent(id)}/stop`);
  } catch {
    return { ok: false };
  }
}

// ---- Monitoring ------------------------------------------------------------

export function fetchSystemInfo(): Promise<SystemInfo> {
  return http<SystemInfo>('GET', 'system'); // rejects (503) while the daemon is down
}

export function fetchSystemHistory(minutes = 15, _stepSec = 3): Promise<SystemSample[]> {
  return http<SystemSample[]>('GET', `system/history?minutes=${minutes}`).catch(() => []);
}

// ---- Live channel: one shared Server-Sent-Events stream --------------------

type Listener = (event: LiveEvent) => void;
const listeners = new Set<Listener>();
let source: EventSource | null = null;

function ensureSource() {
  if (source) return;
  source = new EventSource('api/events'); // the browser reconnects by itself
  source.onmessage = (m) => {
    try {
      const ev = JSON.parse(m.data) as LiveEvent;
      for (const l of listeners) l(ev);
    } catch {
      /* ignore malformed frame */
    }
  };
}

export function subscribeLive(listener: Listener): () => void {
  listeners.add(listener);
  ensureSource();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && source) {
      source.close();
      source = null;
    }
  };
}
