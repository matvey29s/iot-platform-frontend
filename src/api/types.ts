// ---------------------------------------------------------------------------
// These types are the CONTRACT between frontend and the future Go backend.
// Mock implementations in api/mockApi.ts satisfy exactly this contract, so
// swapping mock -> real later means only touching api/*.ts, no component
// changes.
// ---------------------------------------------------------------------------

export interface AuthResult {
  ok: boolean;
  token?: string;
  mustChangePassword?: boolean;
  error?: string;
}

// ---- Device tab ------------------------------------------------------------

export type PortKind = 'fixed' | 'link' | 'module';

/** One expansion slot behind the "modules" port. Slot 1 = ADC channel 0, slot 2 = ADC channel 1. */
export interface SlotState {
  slot: number; // 1 | 2
  connected: boolean;
  /** Resolved by the daemon from the ADC level (~20% RS-485, ~50% relay). */
  detectedType: ModuleType | null;
  adcPercent: number;
  adcRaw: number;
  adcOk: boolean;
}

export interface PortState {
  id: string;
  kind: PortKind;
  connected: boolean;
  /** Only for the "modules" port: the two expansion slots. */
  slots?: SlotState[];
}

export type ModuleType = 'rs485' | 'relay';

export interface Rs485Config {
  baudRate: number;
  parity: 'none' | 'even' | 'odd';
  dataBits: 7 | 8;
  stopBits: 1 | 2;
  devicePath: string; // e.g. /dev/ttyRS485-1
  protocol: 'modbus_rtu' | 'modbus_ascii';
}

export interface RelayConfig {
  channels: number;
  safeState: 'keep' | 'all_off' | 'all_on';
}

export type ModuleConfig = Rs485Config | RelayConfig;

// ---- Scenario tab -----------------------------------------------------------

export type ScenarioNodeType =
  | 'if_else'
  | 'while'
  | 'rs485_receive'
  | 'rs485_parse'
  | 'rs485_send'
  | 'relay_set';

export interface RegisterTableRow {
  byteIndex: number;
  name: string;
  dataType: 'uint8' | 'int8' | 'uint16' | 'int16' | 'uint32' | 'int32' | 'float32' | 'bool';
  description: string;
}

export interface ScenarioNodeData {
  label: string;
  type: ScenarioNodeType;
  config: Record<string, unknown>;
}

export interface ScenarioGraph {
  id: string;
  name: string;
  nodes: Array<{ id: string; type: string; position: { x: number; y: number }; data: ScenarioNodeData }>;
  edges: Array<{ id: string; source: string; target: string; sourceHandle?: string | null; targetHandle?: string | null }>;
}

export interface ScenarioRunStatus {
  running: boolean;
  activeNodeId: string | null;
  lastError: string | null;
}

// ---- Monitoring tab -----------------------------------------------------------

export interface SystemInfo {
  /** Epoch milliseconds when this sample was taken on the controller. */
  sampledAt: number;
  linuxVersion: string;
  cpuModel: string;
  cpuUsagePercent: number;
  ramTotalMb: number;
  ramUsedMb: number;
  uptimeSeconds: number;
  diskTotalMb: number;
  diskUsedMb: number;
}

/** One point of the CPU/RAM history used by the monitoring charts. */
export interface SystemSample {
  sampledAt: number;
  cpuUsagePercent: number;
  ramUsedMb: number;
  ramTotalMb: number;
}

// ---- Live channel (stands in for the future WebSocket) ----------------------

export type LiveEvent =
  | { type: 'port_state'; payload: PortState }
  | { type: 'register_value'; payload: { device: string; index: number; value: number } }
  | { type: 'scenario_status'; payload: ScenarioRunStatus }
  | { type: 'system_info'; payload: SystemInfo };
