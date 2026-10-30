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

/**
 * Ports drawn in the SVG: power, ethernet1, sdcard (fixed/link) and module1, module2
 * (expansion slots; slot 1 = ADC channel 0, slot 2 = ADC channel 1).
 */
export interface PortState {
  id: string;
  /** Modules only: RS485-0, RS485-1, Relay-0 ... (numbered per type in slot order). */
  name?: string;
  kind: PortKind;
  connected: boolean;
  slot?: number;
  /** Modules only: resolved by the daemon from the ADC level (~16.4% RS-485, ~91.6% relay, +-5%). */
  detectedType?: ModuleType | null;
  adcPercent?: number;
  adcRaw?: number;
  adcOk?: boolean;
  /** Relay modules only: state of the single relay channel. */
  relays?: boolean[];
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
  channels: number; // always 1
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
  | 'relay_set'
  | 'button_event'
  | 'led_set'
  | 'delay';

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

// ---- Buttons, LEDs, RS-485 terminal ------------------------------------------------

export interface LedState {
  n: number; // 1..3 (programmable)
  on: boolean;
}
export interface ButtonState {
  n: number; // 1..3 (programmable)
  pressed: boolean;
  lastPressedAt: number; // epoch ms, 0 = never
}
export interface IOState {
  leds: LedState[];
  buttons: ButtonState[];
}
export interface RS485Entry {
  slot: number;
  dir: 'rx' | 'tx';
  hex: string;
  text: string;
  ts: number;
}
export interface RS485SendRequest {
  mode: 'text' | 'hex';
  data: string;
  eol: 'none' | 'cr' | 'lf' | 'crlf';
}

/** Ethernet interface data reported by the daemon (right-click on "ethernet1"). */
export interface EthInfo {
  iface: string;
  exists: boolean;
  up: boolean;
  operstate: string;
  speed: number; // Mbit/s, -1 = unknown
  duplex: string;
  mac: string;
  ip: string;
  mask: string;
  mtu: number;
  rxBytes: number;
  txBytes: number;
  rxPackets: number;
  txPackets: number;
  rxErrors: number;
  txErrors: number;
  rxDropped: number;
  txDropped: number;
  rxRate: number; // bytes/s
  txRate: number;
  ts: number;
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
  | { type: 'system_info'; payload: SystemInfo }
  | { type: 'port_adc'; payload: { id: string; adcPercent: number; adcRaw: number } }
  | { type: 'io_led'; payload: LedState }
  | { type: 'io_button'; payload: ButtonState }
  | { type: 'rs485_data'; payload: RS485Entry }
  | { type: 'ethernet'; payload: EthInfo };
