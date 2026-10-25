import { Handle, Position, type NodeProps } from 'reactflow';
import { NODE_DEFS } from './nodeDefs';
import { NodeIcon } from './NodeIcons';
import type { ScenarioNodeData } from '../api/types';

export default function CustomNode({ data, selected, id }: NodeProps<ScenarioNodeData>) {
  const def = NODE_DEFS[data.type];
  const active = data.config.__active === true;

  return (
    <div
      title={def.tooltip}
      style={{
        background: '#171d2b',
        border: `1.5px solid ${selected ? '#ffffff' : active ? '#2ecf7a' : def.color}`,
        borderRadius: 8,
        padding: '8px 12px',
        minWidth: 160,
        boxShadow: active ? '0 0 0 3px rgba(46,207,122,0.35)' : 'none',
        fontSize: 12,
        color: '#eef2fb'
      }}
    >
      {def.hasInput && <Handle type="target" position={Position.Left} style={{ background: def.color }} />}

      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ width: 34, height: 34, borderRadius: 9, background: `${def.color}22`, border: `1px solid ${def.color}66`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
          <NodeIcon type={data.type} size={24} color={def.color} />
        </span>
        <strong>{def.label}</strong>
      </div>
      <div style={{ color: '#9fb2de', marginTop: 4, fontSize: 11 }}>{summarize(data)}</div>
      <div style={{ color: '#5f719e', marginTop: 4, fontSize: 10 }}>Двойной клик — настроить · id: {id}</div>

      {def.outputs ? (
        def.outputs.map((name, i) => (
          <Handle
            key={name}
            type="source"
            position={Position.Right}
            id={name}
            style={{ top: `${35 + i * 30}%`, background: def.color }}
          >
            <span style={{ position: 'absolute', left: 10, top: -6, fontSize: 9, color: '#9fb2de' }}>{name}</span>
          </Handle>
        ))
      ) : def.hasOutput ? (
        <Handle type="source" position={Position.Right} style={{ background: def.color }} />
      ) : null}
    </div>
  );
}

function summarize(data: ScenarioNodeData): string {
  const c = data.config;
  switch (data.type) {
    case 'if_else':
    case 'while':
      return `${c.variable ?? '?'} ${c.operator ?? ''} ${c.value ?? ''}`;
    case 'rs485_receive':
      return `массив: ${c.arrayName ?? '?'}`;
    case 'rs485_parse':
      return `регистров: ${Array.isArray(c.registerTable) ? c.registerTable.length : 0}`;
    case 'rs485_send':
      return `формат: ${c.format ?? '?'}`;
    case 'relay_set':
      return `канал ${c.channel ?? '?'} → ${c.state ?? '?'}`;
    default:
      return '';
  }
}
