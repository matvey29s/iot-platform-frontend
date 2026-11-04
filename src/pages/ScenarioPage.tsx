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
import { NODE_DEFS, defaultConfigFor, outputHandles } from '../scenario/nodeDefs';
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
const seedIds = (ids: string[]) => {
  for (const id of ids) {
    const m = /^node_(\d+)$/.exec(id);
    if (m) idCounter = Math.max(idCounter, Number(m[1]) + 1);
  }
};

/** Graphs saved by older versions: connectors had no ids, if/else had true/false, send had a single text. */
function migrate(g: StoredGraph): StoredGraph {
  const nodes = (g.nodes ?? []).map((n) => {
    if (n.data.type === 'rs485_send' && !Array.isArray(n.data.config.rows)) {
      const c = { ...n.data.config };
      const text = String(c.data ?? '');
      c.rows = c.mode === 'HEX' || !text ? [] : [{ dataType: 'text', value: text, order: 'BE' }];
      c.mode = 'table';
      return { ...n, data: { ...n.data, config: c } };
    }
    if (n.data.type === 'if_else' && !Array.isArray(n.data.config.conditions)) {
      const c = n.data.config;
      return { ...n, data: { ...n.data, config: { ...c, conditions: [{ variable: c.variable ?? 'BTN-1', operator: c.operator ?? '==', value: String(c.value ?? '1') }] } } };
    }
    return n;
  });
  const typeOf = new Map(nodes.map((n) => [n.id, n.data.type]));
  const edges = (g.edges ?? []).map((e) => {
    let h = e.sourceHandle ?? 'out';
    if (typeOf.get(e.source) === 'if_else') h = h === 'true' ? 'c1' : h === 'false' ? 'out' : h;
    return { ...e, sourceHandle: h, targetHandle: e.targetHandle ?? 'in' };
  });
  return { nodes, edges };
}

interface Clip {
  nodes: Node<ScenarioNodeData>[];
  edges: Edge[];
}

type StoredGraph = Pick<ScenarioGraph, 'nodes' | 'edges'>;

function toStoredGraph(nodes: Node<ScenarioNodeData>[], edges: Edge[]): StoredGraph {
  return {
    nodes: nodes.map((n) => {
      const { __active: _a, ...config } = n.data.config as Record<string, unknown>;
      return { id: n.id, type: n.type ?? 'plcNode', position: n.position, data: { ...n.data, config } };
    }),
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
  const [status, setStatus] = useState<ScenarioRunStatus>({ running: false, activeNodeId: null, activeNodeIds: [], lastError: null });
  const [lastSavedAt, setLastSavedAt] = useState<Date | null>(null);
  const [ports, setPorts] = useState<PortState[]>([]);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [rf, setRf] = useState<ReactFlowInstance | null>(null);
  const loadedRef = useRef(false);
  const clipRef = useRef<Clip | null>(null);
  const pasteCount = useRef(0);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);

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
          const parsed: StoredGraph = migrate(JSON.parse(raw));
          seedIds(parsed.nodes.map((n) => n.id));
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
          const g = migrate(existing);
          seedIds(g.nodes.map((n) => n.id));
          setNodes(g.nodes as Node<ScenarioNodeData>[]);
          setEdges((g.edges as Edge[]).map(withDeleteHandler));
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
        data: { ...n.data, config: { ...n.data.config, __active: (status.activeNodeIds ?? (status.activeNodeId ? [status.activeNodeId] : [])).includes(n.id) } }
      }))
    );
  }, [status.activeNodeId, status.activeNodeIds, setNodes]);

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
    (c: Connection) =>
      setEdges((es) => {
        // one connection per output: a new one replaces the old one
        const rest = es.filter((e) => !(e.source === c.source && e.sourceHandle === c.sourceHandle));
        return addEdge(withDeleteHandler({ ...c, id: `e_${c.source}_${c.sourceHandle ?? ''}_${c.target}` } as Edge), rest);
      }),
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
    // screenToFlowPosition wants plain client (screen) coordinates; the node is dropped by its top-left corner under the cursor
    const position = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY });
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
    // connectors that no longer exist (fewer conditions / tasks) lose their connections
    const valid = new Set(outputHandles(editingNode.data.type, config).map((h) => h.id));
    setEdges((es) => es.filter((e) => e.source !== editingNode.id || valid.has(e.sourceHandle ?? 'out')));
    setEditingNode(null);
  }

  // ---- copy / duplicate / delete / paste (Ctrl+C, Ctrl+V); Shift+click or a selection box collects blocks ----
  const selectedNodes = () => nodes.filter((n) => n.selected);

  function copySelection(list = selectedNodes()) {
    if (!list.length) return;
    const ids = new Set(list.map((n) => n.id));
    clipRef.current = {
      nodes: list.map((n) => ({ ...n, data: { ...n.data, config: JSON.parse(JSON.stringify(n.data.config)) } })),
      edges: edges.filter((e) => ids.has(e.source) && ids.has(e.target))
    };
    pasteCount.current = 0;
  }

  function paste() {
    const clip = clipRef.current;
    if (!clip) return;
    pasteCount.current += 1;
    const d = 40 * pasteCount.current;
    const map = new Map<string, string>();
    const fresh: Node<ScenarioNodeData>[] = clip.nodes.map((n) => {
      const id = nextId();
      map.set(n.id, id);
      const { __active: _a, ...config } = JSON.parse(JSON.stringify(n.data.config)) as Record<string, unknown>;
      return { ...n, id, selected: true, position: { x: n.position.x + d, y: n.position.y + d }, data: { ...n.data, config } };
    });
    const newEdges = clip.edges.map((e) => withDeleteHandler({ ...e, id: `e_${map.get(e.source)}_${e.sourceHandle ?? ''}_${map.get(e.target)}`, source: map.get(e.source)!, target: map.get(e.target)!, selected: false } as Edge));
    setNodes((ns) => [...ns.map((n): Node<ScenarioNodeData> => ({ ...n, selected: false })), ...fresh]);
    setEdges((es) => es.concat(newEdges));
  }

  function duplicate(list = selectedNodes()) {
    copySelection(list);
    paste();
  }

  function removeNodes(list = selectedNodes()) {
    const ids = new Set(list.map((n) => n.id));
    setNodes((ns) => ns.filter((n) => !ids.has(n.id)));
    setEdges((es) => es.filter((e) => !ids.has(e.source) && !ids.has(e.target)));
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      if (editingNode) return;
      if (!(e.ctrlKey || e.metaKey)) return;
      const k = e.key.toLowerCase();
      // layout independent: Ctrl+С / Ctrl+М on a Russian keyboard give the same physical keys
      if (k === 'c' || e.code === 'KeyC') { e.preventDefault(); copySelection(); }
      else if (k === 'v' || e.code === 'KeyV') { e.preventDefault(); paste(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  function openMenu(e: React.MouseEvent, node?: Node<ScenarioNodeData>) {
    e.preventDefault();
    if (node && !node.selected) setNodes((ns) => ns.map((n) => ({ ...n, selected: n.id === node.id || (e.shiftKey && !!n.selected) })));
    setMenu({ x: e.clientX, y: e.clientY });
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
        <div ref={wrapRef} style={{ flex: 1 }} onClick={() => setMenu(null)} onDragOver={onDragOver} onDrop={onDrop}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onInit={setRf}
            onNodeDoubleClick={onNodeDoubleClick}
            onNodeContextMenu={openMenu}
            onPaneClick={() => setMenu(null)}
            onNodeClick={() => setMenu(null)}
            multiSelectionKeyCode="Shift"
            selectionKeyCode="Shift"
            connectionRadius={36}
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
      {menu && (
        <div className="card" role="menu" style={{ position: 'fixed', left: menu.x, top: menu.y, zIndex: 80, padding: 4, minWidth: 170, background: 'var(--surface-2)' }} onClick={() => setMenu(null)} onContextMenu={(e) => e.preventDefault()}>
          {[
            ['Копировать (Ctrl+C)', () => copySelection()],
            ['Вставить (Ctrl+V)', () => paste()],
            ['Дублировать', () => duplicate()],
            ['Удалить', () => removeNodes()]
          ].map(([label, fn]) => (
            <button key={label as string} className="btn" style={{ display: 'block', width: '100%', textAlign: 'left', border: 'none' }} onClick={fn as () => void}>{label as string}</button>
          ))}
        </div>
      )}
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
      {status.running && <span style={{ fontSize: 11, color: 'var(--muted)' }}>Ручное управление на вкладке «Устройство» отключено до остановки. Изменения схемы применятся после перезапуска.</span>}
      {status.running ? (
        <button className="btn" onClick={onStop}>Стоп</button>
      ) : (
        <button className="btn primary" onClick={onRun}>Запустить</button>
      )}
    </div>
  );
}
