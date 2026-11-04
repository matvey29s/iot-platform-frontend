import { useEffect } from 'react';
import { Handle, Position, useUpdateNodeInternals, type NodeProps } from 'reactflow';
import { NODE_DEFS, outputHandles } from './nodeDefs';
import { NodeIcon } from './NodeIcons';
import type { ScenarioNodeData } from '../api/types';

const HEAD = 54; // px from the top of the block to the first connector
const STEP = 26; // px between output connectors

export default function CustomNode({ data, selected, id }: NodeProps<ScenarioNodeData>) {
  const updateInternals = useUpdateNodeInternals();
  const def = NODE_DEFS[data.type];
  const active = data.config.__active === true;
  const outs = outputHandles(data.type, data.config);
  const summary = summarize(data);
  useEffect(() => updateInternals(id), [id, outs.length, updateInternals]); // connectors appear/disappear with the settings
  // the body grows with the number of outputs
  const minHeight = Math.max(70, HEAD + outs.length * STEP);

  return (
    <div
      title={def.tooltip}
      style={{
        background: '#171d2b',
        border: `1.5px solid ${selected ? '#ffffff' : active ? '#2ecf7a' : def.color}`,
        borderRadius: 8,
        padding: '8px 44px 8px 28px',
        minWidth: 170,
        minHeight,
        boxShadow: active ? '0 0 0 3px rgba(46,207,122,0.35)' : 'none',
        fontSize: 12,
        color: '#eef2fb',
        position: 'relative'
      }}
    >
      {def.hasInput && (
        <Handle type="target" id="in" position={Position.Left} className="plc-handle" style={{ background: def.color, top: HEAD - 10 }}>
          <span className="plc-handle-label" style={{ left: 18 }}>in</span>
        </Handle>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ width: 34, height: 34, borderRadius: 9, background: `${def.color}22`, border: `1px solid ${def.color}66`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
          <NodeIcon type={data.type} size={24} color={def.color} />
        </span>
        <strong>{def.label}</strong>
      </div>
      {summary && <div style={{ color: '#9fb2de', marginTop: 4, fontSize: 11, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 190 }}>{summary}</div>}

      {outs.map((h, i) => (
        <Handle key={h.id} type="source" id={h.id} position={Position.Right} className="plc-handle" style={{ background: def.color, top: HEAD - 10 + i * STEP }}>
          <span className="plc-handle-label" style={{ right: 18, textAlign: 'right' }}>{h.label}</span>
        </Handle>
      ))}
    </div>
  );
}

/** Only what identifies the block; the hint text of older versions is gone. */
function summarize(data: ScenarioNodeData): string {
  const c = data.config;
  const mod = (c.module as string) || '';
  switch (data.type) {
    case 'rs485_receive':
    case 'rs485_send':
      return mod;
    case 'rs485_parse': {
      const rows = (Array.isArray(c.registerTable) ? c.registerTable : []) as Array<{ name?: string }>;
      return rows.map((r) => r.name).filter(Boolean).join(', ');
    }
    case 'relay_set':
      return `${mod || 'Relay'} - ${c.state ?? ''}`;
    case 'led_set':
      return `LED-${c.led ?? 1} - ${c.state ?? ''}`;
    case 'button_event':
      return `BTN-${c.button ?? 1}`;
    case 'delay':
      return `${c.ms ?? 0} мс`;
    case 'parallel_gateway':
      return `приоритет ${c.priority ?? 0}`;
    default:
      return '';
  }
}
