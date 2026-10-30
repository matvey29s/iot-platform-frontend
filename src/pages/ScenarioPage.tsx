import { useCallback, useEffect, useRef, useState } from 'react';
import ReactFlow, {
  Background,
  Controls,
  MiniMap,
  ReactFlowProvider,
  addEdge,
  useEdgesState,
  useNodesState,
  type Connection,
  type Edge,
  type Node,
  type ReactFlowInstance
} from 'reactflow';
import 'reactflow/dist/style.css';

import * as api from '../api';
import type { PortState, ScenarioGraph, ScenarioNodeData, ScenarioNodeType, ScenarioRunStatus } from '../api/types';
import { NODE_DEFS, defaultConfigFor } from '../scenario/nodeDefs';
import CustomNode from '../scenario/CustomNode';
import DeletableEdge from '../scenario/DeletableEdge';
import NodePalette from '../scenario/NodePalette';
import NodeConfigModal from '../scenario/NodeConfigModal';

const nodeTypes = { plcNode: CustomNode };
const edgeTypes = { default: DeletableEdge };
const SCENARIO_ID = 'default';

// Persisted in the browser's own storage, independent of the mock
// "backend". This is intentionally never cleared/removed by this app --
// per requirement, losing an in-progress scenario is critical. Only the
// person's own browser "clear site data" can remove it.
const STORAGE_KEY = 'plc_scenario_default_v1';

let idCounter = 1;
const nextId = () => `node_${idCounter++}`;

type StoredGraph = Pick<ScenarioGraph, 'nodes' | 'edges'>;

function toStoredGraph(nodes: Node<ScenarioNodeData>[], edges: Edge[]): StoredGraph {
  return {
    nodes: nodes.map((n) => ({ id: n.id, type: n.type ?? 'plcNode', position: n.position, data: n.data })),
    edges: edges.map((e) => ({ id: e.id, source: e.source, target: e.target, sourceHandle: e.sourceHandle, targetHandle: e.targetHandle }))
  };
}

export default function ScenarioPage() {
  return (
    <ReactFlowProvider>
      <ScenarioEditor />
    </ReactFlowProvider>
  );
}

function ScenarioEditor() {
  const [nodes, setNodes, onNodesChange] = useNodesState<ScenarioNodeData>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge[]>([]);
  const [editingNode, setEditingNode] = useState<Node<ScenarioNodeData> | null>(null);
  const [status, setStatus] = useState<ScenarioRunStatus>({ running: false, activeNodeId: null, lastError: null });
  const [lastSavedAt, setLastSavedAt] = useState<Date | null>(null);
  const [ports, setPorts] = useState<PortState[]>([]);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [rf, setRf] = useState<ReactFlowInstance | null>(null);
  const loadedRef = useRef(false);

  const deleteEdgeById = useCallback(
    (id: string) => setEdges((es) => es.filter((e) => e.id !== id)),
    [setEdges]
  );

  const withDeleteHandler = useCallback(
    (e: Edge): Edge => ({ ...e, data: { ...(e.data ?? {}), onDelete: deleteEdgeById } }),
    [deleteEdgeById]
  );

  // ---- initial load: localStorage first (survives reloads), mock API as fallback ----
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        try {
          const parsed: StoredGraph = JSON.parse(raw);
          if (!cancelled) {
            setNodes(parsed.nodes ?? []);
            setEdges((parsed.edges ?? []).map(withDeleteHandler));
          }
        } catch {
          // corrupt entry -- fall through to mock API below rather than losing the slot silently
        }
      } else {
        const list = await api.fetchScenarios();
        const existing = list.find((s) => s.id === SCENARIO_ID);
        if (existing && !cancelled) {
          setNodes(existing.nodes as Node<ScenarioNodeData>[]);
          setEdges((existing.edges as Edge[]).map(withDeleteHandler));
        }
      }
      loadedRef.current = true;
    })();

    api.fetchPorts().then((p) => !cancelled && setPorts(p)).catch(() => {});
    api.fetchScenarioStatus().then((st) => !cancelled && setStatus(st)).catch(() => {});
    const unsub = api.subscribeLive((event) => {
      if (event.type === 'scenario_status') setStatus(event.payload);
      else if (event.type === 'port_state' && event.payload.kind === 'module') {
        const p = event.payload;
        setPorts((prev) => (prev.some((x) => x.id === p.id) ? prev.map((x) => (x.id === p.id ? p : x)) : [...prev, p]));
      }
    });
    return () => {
      cancelled = true;
      unsub();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // reflect the currently-executing node as a highlighted border
  useEffect(() => {
    setNodes((ns) =>
      ns.map((n) => ({
        ...n,
        data: { ...n.data, config: { ...n.data.config, __active: n.id === status.activeNodeId } }
      }))
    );
  }, [status.activeNodeId, setNodes]);

  // ---- continuous autosave (debounced) -- no Save button, nothing to click ----
  useEffect(() => {
    if (!loadedRef.current) return; // don't stomp storage before the initial load above resolves
    const t = setTimeout(() => {
      const payload = toStoredGraph(nodes, edges);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
      api.saveScenario({ id: SCENARIO_ID, name: 'Основной сценарий', ...payload });
      setLastSavedAt(new Date());
    }, 500);
    return () => clearTimeout(t);
  }, [nodes, edges]);

  const onConnect = useCallback(
    (c: Connection) => setEdges((es) => addEdge(withDeleteHandler({ ...c, id: `e_${c.source}_${c.target}_${c.sourceHandle ?? ''}` } as Edge), es)),
    [setEdges, withDeleteHandler]
  );

  function onDragOver(e: React.DragEvent) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    const type = e.dataTransfer.getData('application/plc-node-type') as ScenarioNodeType;
    if (!type || !rf || !wrapRef.current) return;
    const bounds = wrapRef.current.getBoundingClientRect();
    const position = rf.screenToFlowPosition({ x: e.clientX - bounds.left, y: e.clientY - bounds.top });
    const def = NODE_DEFS[type];
    const newNode: Node<ScenarioNodeData> = {
      id: nextId(),
      type: 'plcNode',
      position,
      data: { label: def.label, type, config: defaultConfigFor(type) }
    };
    setNodes((ns) => ns.concat(newNode));
  }

  function onNodeDoubleClick(_: React.MouseEvent, node: Node<ScenarioNodeData>) {
    setEditingNode(node);
  }

  function saveNodeConfig(config: Record<string, unknown>) {
    if (!editingNode) return;
    setNodes((ns) => ns.map((n) => (n.id === editingNode.id ? { ...n, data: { ...n.data, config } } : n)));
    setEditingNode(null);
  }

  async function handleRun() {
    const payload = toStoredGraph(nodes, edges);
    await api.saveScenario({ id: SCENARIO_ID, name: 'Основной сценарий', ...payload });
    const res = await api.startScenario(SCENARIO_ID);
    if (!res.ok) setStatus((s) => ({ ...s, running: false, lastError: res.error ?? 'Не удалось запустить сценарий' }));
  }

  async function handleStop() {
    await api.stopScenario(SCENARIO_ID);
  }

  return (
    <div style={{ display: 'flex', height: '100%' }}>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
        <Toolbar status={status} lastSavedAt={lastSavedAt} onRun={handleRun} onStop={handleStop} />
        <div ref={wrapRef} style={{ flex: 1 }} onDragOver={onDragOver} onDrop={onDrop}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onInit={setRf}
            onNodeDoubleClick={onNodeDoubleClick}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            deleteKeyCode={['Backspace', 'Delete']}
            fitView
            proOptions={{ hideAttribution: true }}
          >
            <Background color="#2a4f9e" gap={18} />
            <Controls />
            <MiniMap pannable zoomable style={{ background: '#0a1f52', border: '1px solid #2a4f9e', borderRadius: 8 }} maskColor="rgba(7,42,102,0.65)" nodeColor="#1C99FF" nodeStrokeWidth={0} />
          </ReactFlow>
        </div>
      </div>
      <NodePalette />
      {editingNode && <NodeConfigModal data={editingNode.data} ports={ports} nodes={nodes} edges={edges} onSave={saveNodeConfig} onClose={() => setEditingNode(null)} />}
    </div>
  );
}

function Toolbar({
  status,
  lastSavedAt,
  onRun,
  onStop
}: {
  status: ScenarioRunStatus;
  lastSavedAt: Date | null;
  onRun: () => void;
  onStop: () => void;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 16px', borderBottom: '1px solid var(--border)', background: 'var(--surface)' }}>
      <strong style={{ fontSize: 14 }}>Сценарий работы</strong>
      <span style={{ fontSize: 11, color: status.running ? 'var(--success)' : 'var(--muted)' }}>
        ● {status.running ? 'выполняется' : 'остановлен'}
      </span>
      <span style={{ fontSize: 11, color: 'var(--muted)' }}>
        {lastSavedAt ? `Сохранено автоматически в ${lastSavedAt.toLocaleTimeString('ru-RU')}` : 'Загрузка…'}
      </span>
      {status.lastError && (
        <span style={{ fontSize: 11, color: 'var(--danger)' }} role="alert" title={status.lastError}>
          ⚠ {status.lastError}
        </span>
      )}
      <div style={{ flex: 1 }} />
      {status.running && <span style={{ fontSize: 11, color: 'var(--muted)' }}>Изменения применятся после перезапуска</span>}
      {status.running ? (
        <button className="btn" onClick={onStop}>Стоп</button>
      ) : (
        <button className="btn primary" onClick={onRun}>Запустить</button>
      )}
    </div>
  );
}
