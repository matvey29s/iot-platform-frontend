import type { Edge, Node } from 'reactflow';
import type { PortState, RegisterTableRow, ScenarioNodeData } from '../api/types';
import { BUTTON_META, LED_META } from '../data/portMeta';

export interface VariableOption {
  name: string;
  /** where the variable comes from, shown next to the name */
  source: string;
}

/** Connected modules of one type, named RS485-0 / Relay-0 ... by the backend. */
export function modulesOfType(ports: PortState[], type: 'rs485' | 'relay'): PortState[] {
  return ports.filter((p) => p.kind === 'module' && p.connected && p.detectedType === type && p.name);
}

/** Name of the RS-485 module an "RS-485: Parse" node reads from = the nearest "Receive" node upstream. */
function upstreamModule(nodeId: string, nodes: Node<ScenarioNodeData>[], edges: Edge[]): string | null {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const seen = new Set<string>([nodeId]);
  const queue = [nodeId];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const e of edges) {
      if (e.target !== cur || seen.has(e.source)) continue;
      seen.add(e.source);
      const n = byId.get(e.source);
      if (n?.data.type === 'rs485_receive') {
        const m = String(n.data.config.module ?? '');
        return m || null;
      }
      queue.push(e.source);
    }
  }
  return null;
}

/** Every variable a condition can use, with the module it belongs to. */
export function buildVariables(ports: PortState[], nodes: Node<ScenarioNodeData>[], edges: Edge[]): VariableOption[] {
  const out: VariableOption[] = [];
  BUTTON_META.slice(1).forEach((b, i) => out.push({ name: `BTN-${i + 1}`, source: `${b.title} (GPIO${b.gpio})` }));
  LED_META.slice(1).forEach((l, i) => out.push({ name: `LED-${i + 1}`, source: `${l.title} (GPIO${l.gpio})` }));
  for (const m of modulesOfType(ports, 'relay')) out.push({ name: m.name!, source: `${m.name} · реле, отсек ${m.slot}` });

  const rs485 = modulesOfType(ports, 'rs485');
  for (const n of nodes) {
    if (n.data.type !== 'rs485_parse') continue;
    const rows = (n.data.config.registerTable as RegisterTableRow[] | undefined) ?? [];
    if (!rows.length) continue;
    const up = upstreamModule(n.id, nodes, edges);
    const mods = up ? [up] : rs485.map((m) => m.name!);
    for (const mod of mods) {
      rows.forEach((r, i) => {
        const what = r.description || r.name || `байт ${r.byteIndex}`;
        out.push({ name: `${mod}.${i + 1}`, source: `${mod} · регистр ${i + 1} (${what})` });
        if (r.name) out.push({ name: `${mod}.${r.name.toUpperCase()}`, source: `${mod} · ${what}` });
      });
    }
  }
  // unique by name
  const seen = new Set<string>();
  return out.filter((v) => (seen.has(v.name.toUpperCase()) ? false : (seen.add(v.name.toUpperCase()), true)));
}
