import {AccountGate, CloudAccount} from "./CloudAccount";
import {account} from "./cloud";
import { TunnelSettings } from "./TunnelSettings";
import React, { useState, useEffect, useRef, useCallback } from "react";
import { createRoot } from "react-dom/client";
import {
  ReactFlow,
  ReactFlowProvider,
  Handle,
  Position,
  Controls,
  Background,
  useReactFlow,
  type NodeProps,
  type Node,
  type Edge as FlowEdge,
} from "@xyflow/react";
import {
  BookOpen,
  Plus,
  Search,
  Settings,
  ChevronRight,
  ChevronDown,
  MoreHorizontal,
  Check,
  Circle,
  Clock,
  Minus,
  Sun,
  Moon,
  Undo2,
  Redo2,
  Download,
  Upload,
  Trash2,
  X,
  Copy,
  Link,
  PanelLeftClose,
  Focus,
  ChevronsLeft,
  GraduationCap,
  ExternalLink,
  Pencil,
  RotateCcw,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import { exportExploration } from "./export";
import {
  api,
  subscribe,
  setToken,
  uid,
  newNode,
  type Concept,
  type Graph,
  type MapSummary,
  type Operation,
  type Status,
  type Edge,
} from "./api";
import "@xyflow/react/dist/style.css";
import "./style.css";
const statusNames: Record<Status, string> = {
  not_understood: "未理解",
  learning: "学习中",
  mastered: "已掌握",
  skipped: "跳过",
};
const StatusIcon = ({
  status,
  size = 14,
}: {
  status: Status;
  size?: number;
}) =>
  status === "mastered" ? (
    <Check size={size} />
  ) : status === "learning" ? (
    <Clock size={size} />
  ) : status === "skipped" ? (
    <Minus size={size} />
  ) : (
    <Circle size={size} />
  );
function IconButton({
  title,
  children,
  onClick,
  disabled = false,
}: {
  title: string;
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className="icon-button"
      title={title}
      aria-label={title}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
}
type MenuAction = { label: string; run: () => void | Promise<unknown>; disabled?: boolean; danger?: boolean };
type MenuState = { x: number; y: number; actions: MenuAction[] };
function ContextMenu({ menu, close }: { menu: MenuState; close: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current!;
    const box = el.getBoundingClientRect();
    el.style.left = Math.max(8, Math.min(menu.x, window.innerWidth - box.width - 8)) + "px";
    el.style.top = Math.max(8, Math.min(menu.y, window.innerHeight - box.height - 8)) + "px";
    el.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    const outside = (e: PointerEvent) => { if (!el.contains(e.target as globalThis.Node)) close(); };
    const dismiss = () => close();
    window.addEventListener("pointerdown", outside);
    window.addEventListener("resize", dismiss);
    return () => { window.removeEventListener("pointerdown", outside); window.removeEventListener("resize", dismiss); };
  }, [menu]);
  return <div ref={ref} className="context-menu" role="menu" aria-label="快捷操作"
    style={{ left: menu.x, top: menu.y }} onContextMenu={e => e.preventDefault()}
    onKeyDown={e => {
      if (e.key === "Escape" || e.key === "Tab") { close(); return; }
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
      e.preventDefault();
      const buttons = Array.from(ref.current!.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));
      const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const next = e.key === "Home" ? 0 : e.key === "End" ? buttons.length - 1 : (at + (e.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next]?.focus();
    }}>
    {menu.actions.map(action => <button key={action.label} role="menuitem" disabled={action.disabled}
      className={action.danger ? "danger" : ""} onClick={() => { close(); void action.run(); }}>{action.label}</button>)}
  </div>;
}
type PanelData = {
  title: string;
  subtitle: string;
  rows: Concept[];
  selected: string;
  root: boolean;
  expanded: string | undefined;
  context: (event: React.MouseEvent, node: Concept) => void;
  select: (id: string) => void;
  expand: (id: string) => void;
  hasChildren: (id: string) => boolean;
  depth: number;
  relations: Record<string, Edge["kind"]>;
  changeStatus: (node: Concept, status: Status) => void;
  askAI: (node: Concept) => void;
};
function ListPanel({ data }: NodeProps<Node<PanelData>>) {
  const [menu, setMenu] = useState("");
  return (
    <div
      data-testid={"panel-" + data.depth}
      className={"graph-panel " + (data.root ? "root-panel" : "")}
    >
      <Handle type="target" position={Position.Left} style={{ top: 78 }} />
      <div className="panel-caption">
        <span>{data.title}</span>
        <span>{data.root ? "目标" : data.rows.length + " 项"}</span>
      </div>
      {data.rows.map((n) => (
        <div
          key={n.id}
          data-node-id={n.id}
          className={
            "concept-row " + (data.selected === n.id ? "selected" : "")
          }
          onClick={() => data.select(n.id)}
          onContextMenu={(e) => data.context(e, n)}
        >
          <div className="row-status">
            <button
              className={"status-icon nodrag " + n.status}
              title={statusNames[n.status]}
              aria-label={"状态 " + n.title}
              onClick={(e) => {
                e.stopPropagation();
                setMenu(menu === n.id ? "" : n.id);
              }}
            >
              <StatusIcon status={n.status} />
            </button>
            {menu === n.id && (
              <div
                className="status-menu nodrag"
                onClick={(e) => e.stopPropagation()}
              >
                {Object.entries(statusNames).map(([status, label]) => (
                  <button
                    key={status}
                    onClick={() => {
                      data.changeStatus(n, status as Status);
                      setMenu("");
                    }}
                  >
                    <StatusIcon status={status as Status} />
                    {label}
                  </button>
                ))}
                {n.status === "not_understood" && (
                  <button
                    onClick={() => {
                      data.askAI(n);
                      setMenu("");
                    }}
                  >
                    <Copy size={13} />
                    复制 AI 提问
                  </button>
                )}
              </div>
            )}
          </div>
          <div className="row-copy">
            <strong>{n.title}</strong>
            {data.relations[n.id] && (
              <span
                className={"relation-mark " + data.relations[n.id]}
                title={
                  data.relations[n.id] === "required"
                    ? "必要前置"
                    : data.relations[n.id] === "recommended"
                      ? "建议前置"
                      : "相关知识"
                }
              >
                {data.relations[n.id] === "required"
                  ? "·"
                  : data.relations[n.id] === "recommended"
                    ? "◦"
                    : "↔"}
              </span>
            )}
            <p>{n.summary || "添加摘要，记录你的理解"}</p>
          </div>
          <button
            className="row-expand nodrag"
            title={data.expanded === n.id ? "收起前置知识" : "展开前置知识"}
            aria-label={(data.expanded === n.id ? "收起 " : "展开 ") + n.title}
            aria-expanded={data.expanded === n.id}
            onClick={(e) => {
              e.stopPropagation();
              data.expand(n.id);
            }}
            disabled={!data.hasChildren(n.id)}
          >
            {data.expanded === n.id ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
          </button>
          <Handle
            type="source"
            position={Position.Right}
            id={n.id}
            style={{ top: "50%", right: -3 }}
          />
        </div>
      ))}
      {!data.rows.length && (
        <div className="panel-empty">没有可见的前置知识</div>
      )}
      <div className="panel-footer">
        {data.root
          ? "从目标开始，逐层探索"
          : "前置知识 · 第 " + data.depth + " 层"}
      </div>
    </div>
  );
}
const nodeTypes = { list: ListPanel };
function App() {
  const [syncStatus, setSyncStatus] = useState('正在连接云端');
  useEffect(() => {
    const update = (e: Event) => setSyncStatus((e as CustomEvent<string>).detail);
    window.addEventListener('atlas-sync-status',update);
    return () => window.removeEventListener('atlas-sync-status',update);
  }, []);
  const [maps, setMaps] = useState<MapSummary[]>([]),
    [graph, setGraph] = useState<Graph | null>(null),
    [selected, setSelected] = useState(""),
    [path, setPath] = useState<string[]>([]),
    [draft, setDraft] = useState<Concept | null>(null),
    [dirty, setDirty] = useState(false),
    [message, setMessage] = useState(""),
    [error, setError] = useState(""),
    [query, setQuery] = useState(""),
    [mapQuery, setMapQuery] = useState(""),
    [hideMastered, setHideMastered] = useState(false),
    [depth, setDepth] = useState(6),
    [dark, setDark] = useState(false),
    [settings, setSettings] = useState(false),
    [connection, setConnection] = useState<Record<string, unknown> | null>(
      null,
    ),
    [token, setTokenInput] = useState(""),
    [reveal, setReveal] = useState(false),
    [recommendations, setRecommendations] = useState<Concept[]>([]),
    [tab, setTab] = useState("detail"),
    [depModal, setDepModal] = useState(false),
    [depTarget, setDepTarget] = useState(""),
    [depTitle, setDepTitle] = useState(""),
    [depKind, setDepKind] = useState<Edge["kind"]>("required"),
    [depReason, setDepReason] = useState(""),
    [statusMenu, setStatusMenu] = useState(false),
    [editing, setEditing] = useState(false),
    [saving, setSaving] = useState(false),
    [inspectorClosed, setInspectorClosed] = useState(false),
    [mapDialog, setMapDialog] = useState<
      "create" | "rename" | "delete-map" | "delete-node" | null
    >(null),
    [dialogTitle, setDialogTitle] = useState(""),
    [dialogTarget, setDialogTarget] = useState(""),
    [conflict, setConflict] = useState(false);
  const [contextMenu, setContextMenu] = useState<MenuState | null>(null);
  const savingRef = useRef<Promise<boolean> | null>(null);
  const graphRef = useRef(graph),
    dirtyRef = useRef(dirty),
    draftRef = useRef(draft),
    fileRef = useRef<HTMLInputElement>(null),
    flow = useReactFlow();
  graphRef.current = graph;
  dirtyRef.current = dirty;
  draftRef.current = draft;
  const fail = (e: unknown) =>
    setError(e instanceof Error ? e.message : String(e));
  const refreshMaps = useCallback(async () => {
    setMaps(await api<MapSummary[]>("list_maps"));
  }, []);
  const accept = (g: Graph, preserve = false) => {
    graphRef.current = g;
    setGraph(g);
    if (!preserve) {
      const s = g.nodes.some((n) => n.id === selected) ? selected : g.root_id;
      setSelected(s);
      setDraft(g.nodes.find((n) => n.id === s) || null);
      setDirty(false);
      setConflict(false);
    }
  };
  const save = useCallback(async (): Promise<boolean> => {
    if (savingRef.current) {
      await savingRef.current;
      if (dirtyRef.current) return save();
      return true;
    }
    const g = graphRef.current,
      d = draftRef.current;
    if (!g || !d || !dirtyRef.current) return true;
    setSaving(true);
    const job = (async () => {
      try {
        const updated = await api<Graph>("apply_graph_patch", {
          map_id: g.id,
          expected_version: g.version,
          operations: [{ op: "upsert_node", node: d }],
        });
        graphRef.current = updated;
        setGraph(updated);
        if (draftRef.current === d) {
          setDirty(false);
          dirtyRef.current = false;
        }
        setMessage("所有更改已保存");
        refreshMaps();
        return true;
      } catch (e) {
        fail(e);
        setConflict(true);
        return false;
      } finally {
        setSaving(false);
        savingRef.current = null;
      }
    })();
    savingRef.current = job;
    return job;
  }, [refreshMaps]);
  const load = async (id: string) => {
    if (!(await save())) return false;
    try {
      const g = await api<Graph>("get_map", { map_id: id });
      graphRef.current = g;
      setGraph(g);
      setSelected(g.root_id);
      setDraft(g.nodes.find((n) => n.id === g.root_id) || null);
      setPath([]);
      setDirty(false);
      setConflict(false);
      setQuery("");
      setError("");
      return true;
    } catch (e) {
      fail(e);
      return false;
    }
  };
  useEffect(() => {
    api<MapSummary[]>("list_maps")
      .then(async (list) => {
        setMaps(list);
        if (list.length) {
          const g = await api<Graph>("get_map", { map_id: list[0].id });
          setGraph(g);
          setSelected(g.root_id);
          setDraft(g.nodes.find((n) => n.id === g.root_id) || null);
        }
      })
      .catch(fail);
    let stop: (() => void) | undefined;
    let disposed = false;
    subscribe(async (change) => {
      try {
        const list = await api<MapSummary[]>("list_maps");
        setMaps(list);
        const g = graphRef.current;
        if (!g) {
          if (list.length) {
            const first = await api<Graph>("get_map", {map_id:list[0].id});
            graphRef.current=first;setGraph(first);setSelected(first.root_id);
            setDraft(first.nodes.find(n=>n.id===first.root_id)||null);
          }
          return;
        }
        if (!list.some((m) => m.id === g.id)) {
          graphRef.current = null;
          setGraph(null);
          setDraft(null);
          setSelected("");
          setPath([]);
          setDirty(false);
          return;
        }
        if (g.id !== change.map_id && change.kind !== "resync") return;
        if (change.kind === "resync" && list.find(m=>m.id===g.id)?.version === g.version) return;
        if (change.version <= g.version && change.kind !== "resync") return;
        if (savingRef.current) return;
        if (dirtyRef.current) {
          setConflict(true);
          return;
        }
        const fresh = await api<Graph>("get_map", { map_id: g.id });
        graphRef.current = fresh;
        setGraph(fresh);
        const active =
          fresh.nodes.find((n) => n.id === draftRef.current?.id) ||
          fresh.nodes.find((n) => n.id === fresh.root_id) ||
          null;
        setDraft(active);
        setSelected(active?.id || "");
        setPath((old) => {
          const valid: string[] = [];
          for (const id of old) {
            if (!fresh.nodes.some((n) => n.id === id && !n.collapsed)) break;
            if (valid.length === 0 && id !== fresh.root_id) break;
            if (
              valid.length > 0 &&
              !fresh.edges.some(
                (e) => e.source === valid[valid.length - 1] && e.target === id,
              )
            )
              break;
            valid.push(id);
          }
          return valid;
        });
      } catch (e) {
        fail(e);
      }
    }).then((s) => { if (disposed) s(); else stop = s; });
    return () => { disposed = true; stop?.(); };
  }, [refreshMaps]);
  useEffect(() => {
    if (!dirty || conflict) return;
    const timer = setTimeout(() => void save(), 650);
    return () => clearTimeout(timer);
  }, [draft, dirty, conflict, save]);
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? "dark" : "light";
  }, [dark]);
  useEffect(() => {
    if (tab === "learning" && graph)
      api<Concept[]>("recommend", { map_id: graph.id })
        .then(setRecommendations)
        .catch(fail);
  }, [tab, graph?.id, graph?.version]);
  useEffect(() => {
    if (!settings) return;
    const timer = setInterval(() => {
      api<Record<string, unknown>>("connection_info")
        .then(setConnection)
        .catch(() => {});
    }, 3000);
    return () => clearInterval(timer);
  }, [settings]);
  const patch = async (operations: Operation[]) => {
    if (!(await save())) return;
    const g = graphRef.current;
    if (!g) return;
    try {
      const updated = await api<Graph>("apply_graph_patch", {
        map_id: g.id,
        expected_version: g.version,
        operations,
      });
      accept(updated);
      await refreshMaps();
      setError("");
      return updated;
    } catch (e) {
      fail(e);
    }
  };
  const history = async (method: "undo" | "redo") => {
    if (!(await save()) || !graphRef.current) return;
    try {
      accept(await api<Graph>(method, { map_id: graphRef.current.id }));
      refreshMaps();
    } catch (e) {
      fail(e);
    }
  };
  useEffect(() => {
    const fn = (e: KeyboardEvent) => {
      if (
        (e.metaKey || e.ctrlKey) &&
        e.key.toLowerCase() === "z" &&
        !(
          e.target instanceof HTMLInputElement ||
          e.target instanceof HTMLTextAreaElement
        )
      ) {
        e.preventDefault();
        void history(e.shiftKey ? "redo" : "undo");
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        document.getElementById("global-search")?.focus();
      }
    };
    window.addEventListener("keydown", fn);
    return () => window.removeEventListener("keydown", fn);
  });
  const select = async (id: string) => {
    if (id === selected) return;
    if (!(await save())) return;
    setSelected(id);
    setDraft(graphRef.current?.nodes.find((n) => n.id === id) || null);
    setEditing(false);
  };
  const expand = async (id: string, at: number) => {
    if (!(await save())) return;
    await select(id);
    const g = graphRef.current;
    const n = g?.nodes.find((n) => n.id === id);
    if (!n || !g?.edges.some(e => e.source === id) || at >= depth) return;
    const collapsing = path[at] === id;
    if (n.collapsed !== collapsing) {
      const updated = await patch([{ op: "upsert_node", node: { ...n, collapsed: collapsing } }]);
      if (!updated) return;
    }
    setPath(p => collapsing ? p.slice(0, at) : [...p.slice(0, at), id].slice(0, depth));
  };
  const showMenu = (e: React.MouseEvent | MouseEvent, actions: MenuAction[]) => {
    e.preventDefault(); e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY, actions });
  };
  const mapMenu = (e: React.MouseEvent, m: MapSummary) => {
    const withMap = async (action: () => void | Promise<unknown>) => {
      if (graphRef.current?.id !== m.id && !(await load(m.id))) return;
      await action();
    };
    showMenu(e, [
      { label: "打开地图", run: () => load(m.id) },
      { label: "重命名地图", run: () => withMap(() => { setDialogTitle(m.title); setMapDialog("rename"); }) },
      { label: "导出 JSON", run: () => withMap(() => exportFile("json")) },
      { label: "删除地图", danger: true, run: () => withMap(() => setMapDialog("delete-map")) },
    ]);
  };
  const nodeMenu = (e: React.MouseEvent, n: Concept, at: number) => showMenu(e, [
    { label: "查看详情", run: async () => { if (!(await save())) return; await select(n.id); setInspectorClosed(false); } },
    { label: path[at] === n.id ? "收起前置知识" : "展开前置知识", disabled: !graph?.edges.some(edge => edge.source === n.id) || at >= depth || path.slice(0, at).includes(n.id), run: () => expand(n.id, at) },
    { label: "复制 AI 提问", run: () => copyAI(n) },
    ...Object.entries(statusNames).map(([status, label]) => ({ label: "标记为" + label, run: () => rowStatus(n, status as Status) })),
    { label: "删除节点", danger: true, disabled: n.id === graph?.root_id, run: async () => { if (!(await save())) return; await select(n.id); setMapDialog("delete-node"); } },
  ]);
  const rowStatus = (node: Concept, status: Status) => {
    if (node.id === draftRef.current?.id) {
      setDraft({ ...draftRef.current, status });
      setDirty(true);
    } else void patch([{ op: "upsert_node", node: { ...node, status } }]);
  };
  const prerequisites = (id: string) =>
    graph?.edges
      .filter((e) => e.source === id)
      .map((e) => graph.nodes.find((n) => n.id === e.target)!)
      .filter((n) => n && (!hideMastered || n.status !== "mastered")) || [];
  const panels: Node<PanelData>[] = [];
  const lines: FlowEdge[] = [];
  if (graph) {
    const root = graph.nodes.find((n) => n.id === graph.root_id);
    if (root)
      panels.push({
        id: "panel-0",
        type: "list",
        position: { x: 36, y: 100 },
        width: 278,
        height: 152,
        initialWidth: 278,
        initialHeight: 152,
        style: { width: 278, height: 152 },
        data: {
          title: "学习目标",
          subtitle: "",
          rows: [root],
          selected,
          root: true,
          expanded: path[0],
          context: (e, n) => nodeMenu(e, n, 0),
          select: (id) => expand(id, 0),
          expand: (id) => expand(id, 0),
          hasChildren: (id) => prerequisites(id).length > 0,
          depth: 0,
          relations: {},
          changeStatus: rowStatus,
          askAI: (n) => void copyAI(n),
        },
      });
    for (let i = 0; i < Math.min(path.length, depth); i++) {
      const source = graph.nodes.find((n) => n.id === path[i]);
      if (!source) break;
      const rows = prerequisites(source.id);
      panels.push({
        id: "panel-" + (i + 1),
        type: "list",
        position: { x: 36 + (i + 1) * 318, y: 100 },
        width: 278,
        height: 75 + (rows.length ? rows.length * 77 : 72),
        initialWidth: 278,
        initialHeight: 75 + (rows.length ? rows.length * 77 : 72),
        style: {
          width: 278,
          height: 75 + (rows.length ? rows.length * 77 : 72),
        },
        data: {
          title: source.title + " 的前置知识",
          subtitle: "",
          rows,
          selected,
          root: false,
          expanded: path[i + 1],
          context: (e, n) => nodeMenu(e, n, i + 1),
          select: (id) => {
            if (!path.slice(0, i + 1).includes(id)) expand(id, i + 1);
            else void select(id);
          },
          expand: (id) => {
            if (path.slice(0, i + 1).includes(id)) {
              setMessage("已到达路径中的共享节点");
              void select(id);
              return;
            }
            expand(id, i + 1);
          },
          hasChildren: (id) => prerequisites(id).length > 0 && i + 1 < depth,
          depth: i + 1,
          relations: Object.fromEntries(
            graph.edges
              .filter((e) => e.source === source.id)
              .map((e) => [e.target, e.kind]),
          ),
          changeStatus: rowStatus,
          askAI: (n) => void copyAI(n),
        },
      });
      lines.push({
        id: "line-" + i,
        source: "panel-" + i,
        target: "panel-" + (i + 1),
        sourceHandle: path[i],
        type: "smoothstep",
        style: {
          stroke: "var(--line-strong)",
          strokeWidth: 1.2,
          strokeDasharray:
            graph.edges.find(
              (e) => e.source === path[i - 1] && e.target === path[i],
            )?.kind === "related"
              ? "3 4"
              : graph.edges.find(
                    (e) => e.source === path[i - 1] && e.target === path[i],
                  )?.kind === "recommended"
                ? "6 3"
                : undefined,
        },
        pathOptions: { borderRadius: 18 },
      } as FlowEdge);
    }
  }
  const locate = (id: string) => {
    if (!graph) return;
    const queue: [[string, string[]]] | [string, string[]][] = [
      [graph.root_id, []],
    ];
    const seen = new Set<string>();
    while (queue.length) {
      const [current, parents] = queue.shift()!;
      if (current === id) {
        setPath(parents.slice(0, depth));
        void select(id);
        setQuery("");
        setTimeout(() => flow.fitView({ duration: 350, padding: 0.18 }), 80);
        return;
      }
      if (seen.has(current)) continue;
      seen.add(current);
      for (const e of graph.edges.filter((e) => e.source === current))
        queue.push([e.target, [...parents, current]]);
    }
    void select(id);
    setMessage("此节点暂未连接到学习目标");
  };
  const createMap = () => {
    setDialogTitle("");
    setDialogTarget("");
    setMapDialog("create");
  };
  const confirmDialog = async () => {
    if (!(await save())) return;
    try {
      if (mapDialog === "create") {
        const g = await api<Graph>("create_map", {
          title: dialogTitle.trim(),
          target: dialogTarget.trim() || dialogTitle.trim(),
        });
        accept(g);
        setSelected(g.root_id);
        setDraft(g.nodes.find((n) => n.id === g.root_id) || null);
        setPath([]);
        await refreshMaps();
      } else if (mapDialog === "rename") {
        await patch([{ op: "rename_map", title: dialogTitle.trim() }]);
      } else if (mapDialog === "delete-map" && graph) {
        await api("delete_map", {
          map_id: graph.id,
          expected_version: graph.version,
        });
        graphRef.current = null;
        setGraph(null);
        setDraft(null);
        setPath([]);
        await refreshMaps();
      } else if (mapDialog === "delete-node" && draft) {
        const id = draft.id;
        const g = await patch([{ op: "delete_node", node_id: id }]);
        if (g) {
          setSelected(g.root_id);
          setDraft(g.nodes.find((n) => n.id === g.root_id) || null);
          setPath((p) => p.filter((x) => x !== id));
        }
      }
      setMapDialog(null);
    } catch (e) {
      fail(e);
    }
  };
  const download = async (text: string, name: string, mime = "text/plain") => {
    if ("__TAURI_INTERNALS__" in window) {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("save_export", {
        name,
        data: Array.from(new TextEncoder().encode(text)),
      });
      return;
    }
    const url = URL.createObjectURL(new Blob([text], { type: mime }));
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const exportFile = async (format: string) => {
    if (!(await save()) || !graphRef.current) return;
    const graph = graphRef.current;
    try {
      if (format === "png" || format === "svg") {
        const bytes = await exportExploration(panels, path, dark, format);
        const name = graph.title + "." + format;
        if ("__TAURI_INTERNALS__" in window) {
          const { invoke } = await import("@tauri-apps/api/core");
          await invoke("save_export", { name, data: Array.from(bytes) });
        } else {
          const blob = new Blob([bytes as BlobPart], {
            type: format === "png" ? "image/png" : "image/svg+xml",
          });
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url;
          a.download = name;
          a.click();
          setTimeout(() => URL.revokeObjectURL(url), 2000);
        }
      } else {
        const result = await api<{ text: string }>("export_outline", {
          map_id: graph.id,
          format,
        });
        download(
          result.text,
          graph.title +
            "." +
            (format === "markdown"
              ? "md"
              : format === "mermaid"
                ? "mmd"
                : "json"),
          format === "json" ? "application/json" : "text/plain",
        );
      }
    } catch (e) {
      fail(e);
    }
  };
  const clipboard = async (text: string) => {
    try {
      if ("__TAURI_INTERNALS__" in window) {
        const { invoke } = await import("@tauri-apps/api/core");
        await invoke("copy_text", { text });
      } else await navigator.clipboard.writeText(text);
      setMessage("已复制到剪贴板");
    } catch {
      download(text, "atlas-context.txt");
    }
  };
  const copyAI = (node: Concept) =>
    clipboard(
      `请帮助我理解知识节点「${node.title}」。\n地图 ID: ${graph?.id}\n节点 ID: ${node.id}\n摘要: ${node.summary}\n解释: ${node.explanation}\n我的笔记: ${node.notes}\n请通过 Knowledge Atlas MCP 读取当前地图，解释前置知识，必要时使用 apply_graph_patch 更新地图。`,
    );
  const addDependency = async () => {
    if (!draft) return;
    const node = depTarget
      ? graph?.nodes.find((n) => n.id === depTarget)
      : newNode(depTitle.trim());
    if (!node) return;
    const ops: Operation[] = [];
    if (!depTarget) ops.push({ op: "upsert_node", node });
    ops.push({
      op: "upsert_edge",
      edge: {
        id: uid(),
        source: draft.id,
        target: node.id,
        kind: depKind,
        reason: depReason,
      },
    });
    if (await patch(ops)) {
      setDepModal(false);
      setDepTitle("");
      setDepTarget("");
      setDepReason("");
    }
  };
  const openSettings = async () => {
    setSettings(true);
    try {
      setConnection(await api<Record<string, unknown>>("connection_info"));
    } catch (e) {
      setConnection(null);
      fail(e);
    }
  };
  return (
    <div className={"app-shell " + (inspectorClosed ? "inspector-closed" : "")}>
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark">
            <BookOpen size={17} />
          </div>
          Knowledge Atlas
        </div>
        <div className="global-search">
          <Search size={15} />
          <input
            id="global-search"
            placeholder="搜索知识点、摘要、笔记…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <kbd>⌘ K</kbd>
          {query && (
            <div className="search-results">
              {graph?.nodes
                .filter((n) =>
                  (n.title + n.summary + n.notes)
                    .toLowerCase()
                    .includes(query.toLowerCase()),
                )
                .map((n) => (
                  <button key={n.id} onClick={() => locate(n.id)}>
                    <BookOpen size={14} />
                    <span>
                      {n.title}
                      <small>{n.summary}</small>
                    </span>
                    <ChevronRight size={14} />
                  </button>
                ))}
              {!graph?.nodes.some((n) =>
                (n.title + n.summary + n.notes)
                  .toLowerCase()
                  .includes(query.toLowerCase()),
              ) && <p>没有找到知识点</p>}
            </div>
          )}
        </div>
        <div className="top-actions">
          <span className="save-state">
            <span className={"tiny-dot " + (conflict ? "warning" : "")} />
            {saving
              ? "正在保存"
              : dirty
                ? "有未保存更改"
                : graph
                  ? (account() ? "云端已保存" : "本地已保存")
                  : (account() ? "云端账号已连接" : "连接本地数据库")}
          </span>
          <IconButton
            title={dark ? "浅色主题" : "深色主题"}
            onClick={() => setDark(!dark)}
          >
            {dark ? <Sun size={17} /> : <Moon size={17} />}
          </IconButton>
          <IconButton
            title={inspectorClosed ? "显示详情面板" : "收起详情面板"}
            onClick={() => setInspectorClosed(!inspectorClosed)}
          >
            <PanelLeftClose size={17} />
          </IconButton>
          <IconButton title="MCP 设置" onClick={() => void openSettings()}>
            <Settings size={17} />
          </IconButton>
        </div>
      </header>
      <aside className="sidebar">
        <div className="section-heading" onContextMenu={e => showMenu(e, [
          { label: "新建地图", run: createMap },
          { label: "导入 JSON", run: () => fileRef.current?.click() },
        ])}>
          知识地图
          <IconButton title="新建地图" onClick={() => void createMap()}>
            <Plus size={16} />
          </IconButton>
        </div>
        <div className="map-search">
          <Search size={13} />
          <input
            placeholder="筛选地图"
            value={mapQuery}
            onChange={(e) => setMapQuery(e.target.value)}
          />
        </div>
        <nav>
          {maps
            .filter((m) =>
              m.title.toLowerCase().includes(mapQuery.toLowerCase()),
            )
            .map((m) => (
              <button
                key={m.id}
                className={"map-item " + (graph?.id === m.id ? "active" : "")}
                onClick={() => { setContextMenu(null); void load(m.id); }}
                onContextMenu={e => mapMenu(e, m)}
              >
                <BookOpen size={16} />
                <span>{m.title}</span>
                <small>{m.node_count}</small>
              </button>
            ))}
        </nav>
        <button
          className="sidebar-link"
          onClick={async () => {
            try {
              const g = await api<Graph>("restore_deleted_map");
              accept(g);
              setPath([]);
              refreshMaps();
            } catch (e) {
              fail(e);
            }
          }}
        >
          <RotateCcw size={14} />
          恢复最近删除地图
        </button>
        <div className="sidebar-bottom">
          <div className="local-icon">
            <BookOpen size={18} />
          </div>
          <div>
            <strong>{account() ? account()!.username + " 的云端地图" : "你的知识，留在本地"}</strong>
            <small>{account() ? syncStatus : "SQLite · 自动保存"}</small>
          </div>
          <span className="tiny-dot" />
        </div>
      </aside>
      <main className="workspace">
        <div className="workspace-heading">
          <div>
            <div className="eyebrow">KNOWLEDGE MAP</div>
            <h1>{graph?.title || "知识，从一个问题开始"}</h1>
            <p>从目标出发，逐层理解它的前置知识。</p>
          </div>
          <div className="heading-actions">
            <IconButton
              title="撤销"
              onClick={() => void history("undo")}
              disabled={!graph}
            >
              <Undo2 size={17} />
            </IconButton>
            <IconButton
              title="重做"
              onClick={() => void history("redo")}
              disabled={!graph}
            >
              <Redo2 size={17} />
            </IconButton>
            <div className="dropdown">
              <button className="button subtle">
                <Download size={14} />
                导出
                <ChevronDown size={12} />
              </button>
              <div className="dropdown-menu">
                {["json", "markdown", "mermaid", "svg", "png"].map((f) => (
                  <button key={f} onClick={() => void exportFile(f)}>
                    {f.toUpperCase()}
                  </button>
                ))}
              </div>
            </div>
            <div className="dropdown">
              <IconButton title="地图操作" onClick={() => {}}>
                <MoreHorizontal size={18} />
              </IconButton>
              <div className="dropdown-menu">
                <button
                  onClick={() => {
                    if (graph) {
                      setDialogTitle(graph.title);
                      setMapDialog("rename");
                    }
                  }}
                >
                  重命名地图
                </button>
                <button onClick={() => fileRef.current?.click()}>
                  导入 JSON
                </button>
                <button
                  className="danger"
                  onClick={() => setMapDialog("delete-map")}
                >
                  删除地图
                </button>
              </div>
            </div>
          </div>
        </div>
        <div className="exploration-toolbar">
          <div className="breadcrumbs">
            <button onClick={() => setPath([])} title="收起全部">
              <ChevronsLeft size={14} />
            </button>
            <span>目标</span>
            {path.map((id, i) => (
              <React.Fragment key={i}>
                <ChevronRight size={12} />
                <button onClick={() => setPath((p) => p.slice(0, i + 1))}>
                  {graph?.nodes.find((n) => n.id === id)?.title}
                </button>
              </React.Fragment>
            ))}
          </div>
          <div className="view-options">
            <label>
              <input
                type="checkbox"
                checked={hideMastered}
                onChange={(e) => setHideMastered(e.target.checked)}
              />
              隐藏已掌握
            </label>
            <label>
              深度
              <select
                aria-label="探索深度"
                value={depth}
                onChange={(e) => {
                  setDepth(+e.target.value);
                  setPath((p) => p.slice(0, +e.target.value));
                }}
              >
                {[2, 3, 4, 5, 6, 8, 10, 12].map((n) => (
                  <option key={n}>{n}</option>
                ))}
              </select>
            </label>
            <IconButton
              title="适应画布"
              onClick={() => flow.fitView({ duration: 300, padding: 0.15 })}
            >
              <Focus size={15} />
            </IconButton>
          </div>
        </div>
        <div className="canvas" data-testid="exploration-canvas">
          {graph ? (
            <ReactFlow
              nodes={panels}
              edges={lines}
              nodeTypes={nodeTypes}
              nodesDraggable={false}
              onPaneContextMenu={e => showMenu(e, [
                { label: "适应画布", run: () => flow.fitView({ duration: 250, padding: 0.18 }) },
                { label: "收起全部", run: () => setPath([]) },
                { label: "撤销", run: () => history("undo") },
                { label: "重做", run: () => history("redo") },
              ])}
              nodesConnectable={false}
              elementsSelectable={false}
              minZoom={0.25}
              maxZoom={1.5}
              defaultViewport={{ x: 0, y: 35, zoom: 0.85 }}
              fitView={false}
              proOptions={{ hideAttribution: true }}
            >
              <Background gap={24} size={1} color="var(--dot)" />
              <Controls showInteractive={false} />
            </ReactFlow>
          ) : (
            <div className="empty-state">
              <BookOpen size={36} />
              <h2>建立属于你的知识地图</h2>
              <p>选择一个想理解的概念，把复杂知识拆成清晰的下一步。</p>
              <button
                className="button primary"
                onClick={() => void createMap()}
              >
                <Plus size={15} />
                新建知识地图
              </button>
              <button
                className="button"
                onClick={() => fileRef.current?.click()}
              >
                <Upload size={15} />
                导入 JSON
              </button>
            </div>
          )}
          <div className="canvas-legend">
            {Object.entries(statusNames).map(([status, label]) => (
              <span key={status}>
                <span className={"status-icon " + status}>
                  <StatusIcon status={status as Status} size={12} />
                </span>
                {label}
              </span>
            ))}
            <span className="legend-divider" />
            点击行展开 / 收起 · 右键快捷操作
          </div>
        </div>
      </main>
      <aside className="inspector">
        <div className="inspector-tabs">
          <button
            className={tab === "detail" ? "active" : ""}
            onClick={() => setTab("detail")}
          >
            节点详情
          </button>
          <button
            className={tab === "dependencies" ? "active" : ""}
            onClick={() => setTab("dependencies")}
          >
            依赖关系
          </button>
          <button
            className={tab === "learning" ? "active" : ""}
            onClick={() => {
              setTab("learning");
              if (graph)
                api<Concept[]>("recommend", { map_id: graph.id })
                  .then(setRecommendations)
                  .catch(fail);
            }}
          >
            学习路径
          </button>
        </div>
        {draft && graph ? (
          <>
            <div className="inspector-title">
              <div className="node-symbol">
                <BookOpen size={21} />
              </div>
              <div className="node-title-group">
                <span className="eyebrow">
                  {draft.id === graph.root_id ? "学习目标" : "知识节点"}
                </span>
                <input
                  aria-label="节点标题"
                  value={draft.title}
                  onChange={(e) => {
                    setDraft({ ...draft, title: e.target.value });
                    setDirty(true);
                  }}
                />
              </div>
              <div className="status-picker">
                <button
                  title={"状态：" + statusNames[draft.status]}
                  aria-label="设置学习状态"
                  className={"status-button " + draft.status}
                  onClick={() => setStatusMenu(!statusMenu)}
                >
                  <StatusIcon status={draft.status} size={16} />
                </button>
                {statusMenu && (
                  <div className="status-menu">
                    {Object.entries(statusNames).map(([s, label]) => (
                      <button
                        key={s}
                        onClick={() => {
                          setDraft({ ...draft, status: s as Status });
                          setDirty(true);
                          setStatusMenu(false);
                        }}
                      >
                        <StatusIcon status={s as Status} />
                        {label}
                        {draft.status === s && <Check size={13} />}
                      </button>
                    ))}
                    {draft.status === "not_understood" && (
                      <button
                        onClick={() => {
                          void copyAI(draft);
                          setStatusMenu(false);
                        }}
                      >
                        <Copy size={13} />
                        复制 AI 提问
                      </button>
                    )}
                  </div>
                )}
              </div>
            </div>
            <div className="inspector-content">
              {tab === "detail" ? (
                <>
                  <label className="field-label">摘要</label>
                  <textarea
                    className="summary-input"
                    aria-label="节点摘要"
                    value={draft.summary}
                    placeholder="用一句话描述这个概念…"
                    onChange={(e) => {
                      setDraft({ ...draft, summary: e.target.value });
                      setDirty(true);
                    }}
                  />
                  <div className="detail-section">
                    <div className="section-heading">
                      详细解释
                      <IconButton
                        title={editing ? "预览 Markdown" : "编辑 Markdown"}
                        onClick={() => setEditing(!editing)}
                      >
                        {editing ? (
                          <BookOpen size={14} />
                        ) : (
                          <Pencil size={14} />
                        )}
                      </IconButton>
                    </div>
                    {editing ? (
                      <textarea
                        className="markdown-input"
                        aria-label="Markdown 解释"
                        value={draft.explanation}
                        placeholder="支持 Markdown，写下定义、例子和推导…"
                        onChange={(e) => {
                          setDraft({ ...draft, explanation: e.target.value });
                          setDirty(true);
                        }}
                      />
                    ) : (
                      <div
                        className="markdown"
                        onDoubleClick={() => setEditing(true)}
                      >
                        {draft.explanation ? (
                          <ReactMarkdown>{draft.explanation}</ReactMarkdown>
                        ) : (
                          <button
                            className="empty-copy"
                            onClick={() => setEditing(true)}
                          >
                            添加解释，让理解更清晰。
                            <br />
                            <span>支持 Markdown · 点击开始编辑</span>
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                  <div className="detail-section">
                    <label className="field-label" htmlFor="notes">
                      我的笔记
                    </label>
                    <textarea
                      id="notes"
                      className="notes-input"
                      value={draft.notes}
                      placeholder="记下疑问、想法与自己的理解…"
                      onChange={(e) => {
                        setDraft({ ...draft, notes: e.target.value });
                        setDirty(true);
                      }}
                    />
                  </div>
                  <div className="detail-section compact">
                    <span className="field-label">节点 ID</span>
                    <button
                      className="id-copy"
                      onClick={() => void clipboard(draft.id)}
                    >
                      {draft.id}
                      <Copy size={12} />
                    </button>
                  </div>
                  <button
                    className="button wide"
                    onClick={() =>
                      void clipboard(
                        `请帮助我理解知识节点「${draft.title}」。\n地图 ID: ${graph.id}\n节点 ID: ${draft.id}\n摘要: ${draft.summary}\n解释: ${draft.explanation}\n我的笔记: ${draft.notes}\n请通过 Knowledge Atlas MCP 读取当前地图，解释前置知识，必要时使用 apply_graph_patch 更新地图。`,
                      )
                    }
                  >
                    <Copy size={14} />
                    复制 AI 提问上下文
                  </button>
                </>
              ) : tab === "dependencies" ? (
                <>
                  <div className="section-heading">
                    前置知识
                    <IconButton
                      title="添加依赖"
                      onClick={() => setDepModal(true)}
                    >
                      <Plus size={16} />
                    </IconButton>
                  </div>
                  <p className="muted intro-copy">
                    理解这个概念之前，需要了解哪些知识？同一节点可被多处引用。
                  </p>
                  {graph.edges
                    .filter((e) => e.source === draft.id)
                    .map((e) => (
                      <div className="dependency" key={e.id}>
                        <div className="dependency-main">
                          <Link size={14} />
                          <button onClick={() => locate(e.target)}>
                            {graph.nodes.find((n) => n.id === e.target)?.title}
                          </button>
                          <IconButton
                            title="删除依赖"
                            onClick={() =>
                              void patch([{ op: "delete_edge", edge_id: e.id }])
                            }
                          >
                            <X size={13} />
                          </IconButton>
                        </div>
                        <select
                          aria-label="依赖类型"
                          value={e.kind}
                          onChange={(event) =>
                            void patch([
                              {
                                op: "upsert_edge",
                                edge: { ...e, kind: event.target.value },
                              },
                            ])
                          }
                        >
                          <option value="required">必要前置</option>
                          <option value="recommended">建议前置</option>
                          <option value="related">相关知识</option>
                        </select>
                        <input
                          aria-label="依赖原因"
                          placeholder="添加依赖原因"
                          defaultValue={e.reason}
                          onBlur={(event) => {
                            if (event.target.value !== e.reason)
                              void patch([
                                {
                                  op: "upsert_edge",
                                  edge: { ...e, reason: event.target.value },
                                },
                              ]);
                          }}
                        />
                      </div>
                    ))}
                  <button
                    className="button wide"
                    onClick={() => setDepModal(true)}
                  >
                    <Plus size={14} />
                    添加前置知识
                  </button>
                  <div className="detail-section">
                    <div className="field-label">被这些节点引用</div>
                    {graph.edges
                      .filter((e) => e.target === draft.id)
                      .map((e) => (
                        <button
                          className="reference-row"
                          key={e.id}
                          onClick={() => locate(e.source)}
                        >
                          <Link size={13} />
                          {graph.nodes.find((n) => n.id === e.source)?.title}
                          <ChevronRight size={13} />
                        </button>
                      ))}
                  </div>
                </>
              ) : (
                <>
                  <div className="learning-header">
                    <GraduationCap size={24} />
                    <h3>下一步，学什么？</h3>
                    <p>
                      根据当前图谱和掌握状态，优先学习前置知识已准备好的节点。
                    </p>
                  </div>
                  {recommendations.map((n, i) => (
                    <button
                      className="recommendation"
                      key={n.id}
                      onClick={() => locate(n.id)}
                    >
                      <span>{String(i + 1).padStart(2, "0")}</span>
                      <div>
                        <strong>{n.title}</strong>
                        <small>{n.summary || statusNames[n.status]}</small>
                      </div>
                      <ChevronRight size={14} />
                    </button>
                  ))}
                  {!recommendations.length && (
                    <p className="muted">
                      暂时没有学习建议。更新节点状态后再来看看。
                    </p>
                  )}
                </>
              )}
            </div>
            <div className="inspector-bottom">
              <button
                className="button subtle"
                onClick={async () => {
                  const at = path.indexOf(draft.id);
                  if (at >= 0) {
                    setPath((p) => p.slice(0, at));
                    await patch([
                      {
                        op: "upsert_node",
                        node: { ...draft, collapsed: true },
                      },
                    ]);
                  } else {
                    locate(draft.id);
                    setPath((p) => [...p, draft.id].slice(0, depth));
                    if (draft.collapsed)
                      await patch([
                        {
                          op: "upsert_node",
                          node: { ...draft, collapsed: false },
                        },
                      ]);
                  }
                }}
              >
                <PanelLeftClose size={14} />
                {path.includes(draft.id) ? "收起分支" : "展开前置"}
              </button>
              <IconButton
                title="删除节点（可撤销）"
                disabled={draft.id === graph.root_id}
                onClick={() => setMapDialog("delete-node")}
              >
                <Trash2 size={15} />
              </IconButton>
            </div>
          </>
        ) : (
          <div className="inspector-empty">
            <BookOpen size={28} />
            <p>选择知识点，开始探索</p>
          </div>
        )}
      </aside>
      {contextMenu && <ContextMenu menu={contextMenu} close={() => setContextMenu(null)} />}
      {(error || message || conflict) && (
        <div className={"toast " + (error ? "error" : "")}>
          {conflict ? (
            <>
              <span>地图已有新版本。草稿已保留，请先处理冲突。</span>
              <button
                onClick={async () => {
                  if (!graph) return;
                  try {
                    const fresh = await api<Graph>("get_map", {
                      map_id: graph.id,
                    });
                    setGraph(fresh);
                    setConflict(false);
                    setError("");
                    setMessage("已获取新版本，正在保存你的草稿");
                    setDirty(true);
                  } catch (e) {
                    fail(e);
                  }
                }}
              >
                保留草稿并重试
              </button>
              <button
                onClick={async () => {
                  if (!graph) return;
                  const g = await api<Graph>("get_map", { map_id: graph.id });
                  accept(g);
                  setError("");
                }}
              >
                放弃草稿
              </button>
            </>
          ) : (
            <span>{error || message}</span>
          )}
          <button
            aria-label="关闭提示"
            onClick={() => {
              setMessage("");
              setError("");
            }}
          >
            <X size={14} />
          </button>
        </div>
      )}
      {settings && (
        <div className="modal-backdrop">
          <div className="modal">
            <div className="modal-heading">
              <div>
                <span className="eyebrow">{account() ? "CLOUD ACCOUNT" : "LOCAL FIRST"}</span>
                <h2>AI 连接设置</h2>
              </div>
              <IconButton title="关闭设置" onClick={() => setSettings(false)}>
                <X size={18} />
              </IconButton>
            </div>
            <CloudAccount />
            {!account() && <TunnelSettings />}
            {!account() && <>
            <details className="local-mcp-settings">
            <summary>本地 MCP 客户端配置</summary>
            <p className="muted">
              让支持 MCP 的 AI 客户端直接读取和更新本地知识图谱。
            </p>
            <div className="connection-status">
              <span
                className={
                  "tiny-dot " + (!connection?.running ? "warning" : "")
                }
              />
              {connection?.running
                ? "本地 MCP 服务运行中"
                : "尚未确认 MCP 服务状态"}
              <small>
                {connection?.url
                  ? String(connection.url)
                  : "请连接本地 Rust 服务"}
              </small>
              {!!connection?.last_seen && (
                <small>
                  最近 MCP 活动：
                  {typeof connection.last_seen === "number"
                    ? new Date(connection.last_seen * 1000).toLocaleString()
                    : String(connection.last_seen)}
                </small>
              )}
            </div>
            {connection ? (
              <>
                <label className="field-label">服务地址</label>
                <div className="code-box">{String(connection.url || "")}</div>
                <label className="field-label">访问令牌</label>
                <div className="token-row">
                  <code>
                    {reveal
                      ? String(connection.token || "")
                      : "••••••••••••••••••••••••"}
                  </code>
                  <button
                    className="button subtle"
                    onClick={() => setReveal(!reveal)}
                  >
                    {reveal ? "隐藏" : "显示"}
                  </button>
                </div>
                <button
                  className="button wide"
                  onClick={() =>
                    void clipboard(
                      typeof connection.client_config === "string"
                        ? connection.client_config
                        : JSON.stringify(connection.client_config, null, 2),
                    )
                  }
                >
                  <Copy size={14} />
                  复制 MCP 客户端配置
                </button>
                <p className="muted small">
                  令牌只用于本机认证。请仅与信任的本地客户端分享配置。
                </p>
              </>
            ) : (
              <>
                <label className="field-label">浏览器开发连接令牌</label>
                <input
                  className="text-input"
                  type="password"
                  placeholder="输入本地服务的 bearer token"
                  value={token}
                  onChange={(e) => setTokenInput(e.target.value)}
                />
                <button
                  className="button primary"
                  onClick={() => {
                    setToken(token);
                    location.reload();
                  }}
                >
                  连接本地服务
                </button>
              </>
            )}
            </details></>}
          </div>
        </div>
      )}
      {depModal && (
        <div className="modal-backdrop">
          <div className="modal">
            <div className="modal-heading">
              <h2>添加前置知识</h2>
              <IconButton title="关闭" onClick={() => setDepModal(false)}>
                <X size={18} />
              </IconButton>
            </div>
            <label className="field-label">引用已有节点</label>
            <select
              className="text-input"
              value={depTarget}
              onChange={(e) => setDepTarget(e.target.value)}
            >
              <option value="">创建新知识节点…</option>
              {graph?.nodes
                .filter((n) => n.id !== draft?.id)
                .map((n) => (
                  <option value={n.id} key={n.id}>
                    {n.title}
                  </option>
                ))}
            </select>
            {!depTarget && (
              <>
                <label className="field-label">新节点名称</label>
                <input
                  className="text-input"
                  autoFocus
                  value={depTitle}
                  onChange={(e) => setDepTitle(e.target.value)}
                  placeholder="例如：反馈控制"
                />
              </>
            )}
            <label className="field-label">关系类型</label>
            <select
              className="text-input"
              value={depKind}
              onChange={(e) => setDepKind(e.target.value as Edge["kind"])}
            >
              <option value="required">必要前置</option>
              <option value="recommended">建议前置</option>
              <option value="related">相关知识</option>
            </select>
            <label className="field-label">为什么需要它？</label>
            <textarea
              className="text-input"
              value={depReason}
              onChange={(e) => setDepReason(e.target.value)}
              placeholder="解释这条知识连接的意义"
            />
            <button
              className="button primary wide"
              disabled={!depTarget && !depTitle.trim()}
              onClick={() => void addDependency()}
            >
              <Plus size={15} />
              添加依赖
            </button>
          </div>
        </div>
      )}
      {mapDialog && (
        <div className="modal-backdrop">
          <form
            className="modal"
            onSubmit={(e) => {
              e.preventDefault();
              void confirmDialog();
            }}
          >
            <div className="modal-heading">
              <h2>
                {mapDialog === "create"
                  ? "新建知识地图"
                  : mapDialog === "rename"
                    ? "重命名地图"
                    : mapDialog === "delete-map"
                      ? "删除知识地图"
                      : "删除知识节点"}
              </h2>
              <IconButton title="取消" onClick={() => setMapDialog(null)}>
                <X size={18} />
              </IconButton>
            </div>
            {mapDialog === "create" || mapDialog === "rename" ? (
              <>
                <label className="field-label">地图名称</label>
                <input
                  className="text-input"
                  autoFocus
                  value={dialogTitle}
                  onChange={(e) => setDialogTitle(e.target.value)}
                  placeholder="例如：理解 PID 控制"
                />
                {mapDialog === "create" && (
                  <>
                    <label className="field-label">目标知识</label>
                    <input
                      className="text-input"
                      value={dialogTarget}
                      onChange={(e) => setDialogTarget(e.target.value)}
                      placeholder="你想理解的概念（默认使用地图名称）"
                    />
                  </>
                )}
              </>
            ) : (
              <p className="muted">
                {mapDialog === "delete-map"
                  ? "地图将从列表移除。可通过左侧「恢复最近删除地图」找回。"
                  : "此节点及关联的依赖将被删除。可使用撤销恢复。"}
              </p>
            )}
            <div className="dialog-actions">
              <button
                type="button"
                className="button"
                onClick={() => setMapDialog(null)}
              >
                取消
              </button>
              <button
                type="submit"
                className={
                  "button " +
                  (mapDialog.startsWith("delete") ? "danger" : "primary")
                }
                disabled={
                  (mapDialog === "create" || mapDialog === "rename") &&
                  !dialogTitle.trim()
                }
              >
                {mapDialog.startsWith("delete") ? "确认删除" : "保存"}
              </button>
            </div>
          </form>
        </div>
      )}
      <input
        ref={fileRef}
        type="file"
        accept=".json,application/json"
        hidden
        onChange={async (e) => {
          const f = e.target.files?.[0];
          if (!f || !(await save())) return;
          try {
            const g = await api<Graph>("import_graph", {
              graph: JSON.parse(await f.text()),
            });
            accept(g);
            setPath([]);
            refreshMaps();
            setMessage("地图已导入");
          } catch (err) {
            fail(err);
          }
          e.target.value = "";
        }}
      />
    </div>
  );
}
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ReactFlowProvider>
      <AccountGate><App /></AccountGate>
    </ReactFlowProvider>
  </React.StrictMode>,
);
