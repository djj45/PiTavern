import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BranchIndexDto, BranchMetaPatchDto, BranchPathStepDto, BranchSwitchResultDto, BranchTreeNodeDto, ChatMessageDto } from "@pitavern/shared";
import { api } from "../api.ts";

type Filter = "all" | "favorite" | "recent";

interface BranchDialogProps {
  chatId: string;
  revision: string;
  busy: boolean;
  canRegenerate: boolean;
  onSwitchPath: (path: BranchPathStepDto[], revision?: string) => Promise<BranchSwitchResultDto | null>;
  onRegenerate: (instruction: string) => void;
  onClose: () => void;
}

function isUnused(node: BranchTreeNodeDto): boolean {
  return !node.isActive && !node.favorite && node.children.length === 0 && node.linearTurns === 0;
}

function countNodes(nodes: BranchTreeNodeDto[]): number {
  return nodes.reduce((sum, node) => sum + 1 + countNodes(node.children), 0);
}

function filterTree(nodes: BranchTreeNodeDto[], predicate: (node: BranchTreeNodeDto) => boolean): BranchTreeNodeDto[] {
  return nodes.flatMap((node) => {
    const children = filterTree(node.children, predicate);
    if (!predicate(node) && !children.length) return [];
    return [{ ...node, children }];
  });
}

function collectIds(nodes: BranchTreeNodeDto[], map: Map<string, BranchTreeNodeDto>): Map<string, BranchTreeNodeDto> {
  for (const node of nodes) { map.set(node.id, node); collectIds(node.children, map); }
  return map;
}

function ancestorsOf(node: BranchTreeNodeDto, map: Map<string, BranchTreeNodeDto>): string[] {
  const ids: string[] = [];
  let current: BranchTreeNodeDto | undefined = node;
  while (current?.parentId) {
    const parent = map.get(current.parentId);
    if (!parent) break;
    ids.unshift(parent.id);
    current = parent;
  }
  return ids;
}

interface BranchRowProps {
  node: BranchTreeNodeDto;
  depth: number;
  selectedId?: string;
  expanded: Set<string>;
  forceOpen: boolean;
  onToggle: (id: string) => void;
  onSelect: (node: BranchTreeNodeDto) => void;
}

function BranchRow({ node, depth, selectedId, expanded, forceOpen, onToggle, onSelect }: BranchRowProps) {
  const open = forceOpen || expanded.has(node.id);
  const [showUnused, setShowUnused] = useState(false);
  const [page, setPage] = useState(1);
  const normal = node.children.filter((child) => !isUnused(child));
  const unused = node.children.filter(isUnused);
  const limit = forceOpen ? normal.length : page * 12;
  const shown = normal.slice(0, limit);
  const selected = selectedId === node.id;
  return <div>
    <div data-branch-id={node.id} style={{ paddingLeft: depth * 14 }}
      className={"group flex min-w-0 items-start gap-1 rounded-md pr-1 " + (selected ? "bg-tavern-accent/15" : "hover:bg-tavern-raised/70")}>
      {node.children.length ? (
        <button type="button" onClick={() => onToggle(node.id)} aria-label={(open ? "收起分支：" : "展开分支：") + node.title}
          className="mt-1 flex h-5 w-5 shrink-0 items-center justify-center rounded text-xs text-tavern-dim hover:text-tavern-text">
          {open ? "▾" : "▸"}
        </button>
      ) : <span className="mt-1 w-5 shrink-0 text-center text-[10px] text-tavern-dim/50">·</span>}
      <button type="button" onClick={() => onSelect(node)} aria-pressed={selected}
        className="min-w-0 flex-1 py-1.5 text-left text-xs leading-5">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate">{node.name || node.title}</span>
          {node.isCurrent && <span className="shrink-0 rounded-full bg-tavern-accent px-1.5 py-0.5 text-[10px] font-medium text-tavern-bg">当前</span>}
          {node.isActive && !node.isCurrent && <span className="shrink-0 rounded-full border border-tavern-accent/40 px-1.5 py-0.5 text-[10px] text-tavern-accent">路径中</span>}
          {node.favorite && <span className="shrink-0 text-amber-400" aria-label="已收藏">★</span>}
        </span>
        <span className="flex min-w-0 flex-wrap items-center gap-2 text-[10px] text-tavern-dim">
          <span>第 {node.turn} 轮</span>
          {node.linearTurns > 0 && <span>后续 {node.linearTurns} 轮</span>}
          {node.childCount > 0 && <span>{node.childCount} 个下级分支</span>}
          {node.descendantCount > 0 && <span>共 {node.descendantCount + 1} 个节点</span>}
        </span>
      </button>
    </div>
    {open && (normal.length > 0 || unused.length > 0) && (
      <div>
        {shown.map((child) => <BranchRow key={child.id} node={child} depth={depth + 1} selectedId={selectedId}
          expanded={expanded} forceOpen={forceOpen} onToggle={onToggle} onSelect={onSelect} />)}
        {!forceOpen && normal.length > limit && (
          <button type="button" onClick={() => setPage((value) => value + 1)}
            className="ml-8 rounded px-2 py-1 text-[10px] text-tavern-dim hover:text-tavern-text">
            显示更多（剩余 {normal.length - limit}）
          </button>
        )}
        {unused.length > 0 && !showUnused && (
          <button type="button" onClick={() => setShowUnused(true)}
            className="ml-8 rounded px-2 py-1 text-[10px] text-tavern-dim hover:text-tavern-text">
            未继续的候选 × {unused.length}
          </button>
        )}
        {showUnused && unused.map((child) => <BranchRow key={child.id} node={child} depth={depth + 1} selectedId={selectedId}
          expanded={expanded} forceOpen={forceOpen} onToggle={onToggle} onSelect={onSelect} />)}
        {showUnused && <button type="button" onClick={() => setShowUnused(false)}
          className="ml-8 rounded px-2 py-1 text-[10px] text-tavern-dim hover:text-tavern-text">收起未继续候选</button>}
      </div>
    )}
  </div>;
}

export function BranchDialog({ chatId, revision, busy, canRegenerate, onSwitchPath, onRegenerate, onClose }: BranchDialogProps) {
  const [index, setIndex] = useState<BranchIndexDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [selectedId, setSelectedId] = useState<string>();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [recentIds, setRecentIds] = useState<string[]>([]);
  const [mobileView, setMobileView] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [switching, setSwitching] = useState(false);
  const [metaSaving, setMetaSaving] = useState(false);
  const [instruction, setInstruction] = useState("");
  const [previousPath, setPreviousPath] = useState<BranchPathStepDto[]>();
  const [previousLabel, setPreviousLabel] = useState("");
  const [showUnusedRoot, setShowUnusedRoot] = useState(false);
  const [rootPage, setRootPage] = useState(1);
  const [preview, setPreview] = useState<{ messages: ChatMessageDto[]; total: number; nextOffset: number | null; nodeId: string }>();
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState("");
  const previewRef = useRef<HTMLDivElement>(null);
  const treeRef = useRef<HTMLDivElement>(null);
  const initialized = useRef(false);
  const savedScroll = useRef(0);

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const next = await api.branchIndex(chatId);
      setIndex(next);
      const nodes = collectIds(next.nodes, new Map());
      if (!initialized.current) {
        initialized.current = true;
        const saved = readUi();
        const active = next.activePath.filter((id) => nodes.has(id));
        setExpanded(new Set([...active, ...(saved.expanded ?? [])]));
        setFilter(saved.filter ?? "all");
        const preferred = saved.selectedId && nodes.has(saved.selectedId) ? saved.selectedId : next.currentNodeId ?? next.nodes[0]?.id;
        setSelectedId(preferred);
        savedScroll.current = saved.scrollTop ?? 0;
        const recent = readRecent();
        setRecentIds(recent);
      } else if (!selectedId || !nodes.has(selectedId)) {
        setSelectedId(next.currentNodeId ?? next.nodes[0]?.id);
      }
      requestAnimationFrame(() => { if (treeRef.current) treeRef.current.scrollTop = savedScroll.current; });
    } catch (cause) {
      setError((cause as Error).message);
    } finally { setLoading(false); }
  }, [chatId, selectedId]);

  useEffect(() => { void load(); }, [chatId]); // 打开时加载一次；切换后使用服务端返回的新目录。

  useEffect(() => {
    const handler = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  useEffect(() => {
    if (!index) return;
    const active = index.activePath;
    if (active.length) setExpanded((previous) => new Set([...previous, ...active]));
  }, [index?.revision]);

  const saveUi = useCallback((nextExpanded: Set<string>, nextFilter: Filter, nextSelected?: string) => {
    const value = { expanded: [...nextExpanded], filter: nextFilter, selectedId: nextSelected, scrollTop: treeRef.current?.scrollTop ?? savedScroll.current };
    try { localStorage.setItem("pitavern.branch.ui." + chatId, JSON.stringify(value)); } catch { /* ignore */ }
  }, [chatId]);
  const readUi = useCallback(() => {
    try {
      const value = JSON.parse(localStorage.getItem("pitavern.branch.ui." + chatId) ?? "{}") as { expanded?: string[]; filter?: Filter; selectedId?: string; scrollTop?: number };
      return { expanded: Array.isArray(value.expanded) ? value.expanded : [], filter: value.filter === "favorite" || value.filter === "recent" ? value.filter : "all" as Filter, selectedId: value.selectedId, scrollTop: typeof value.scrollTop === "number" ? value.scrollTop : 0 };
    } catch { return { expanded: [], filter: "all" as Filter, selectedId: undefined, scrollTop: 0 }; }
  }, [chatId]);
  const readRecent = useCallback((): string[] => {
    try { const value = JSON.parse(localStorage.getItem("pitavern.branch.recent." + chatId) ?? "[]"); return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").slice(0, 20) : []; }
    catch { return []; }
  }, [chatId]);

  const nodeMap = useMemo(() => collectIds(index?.nodes ?? [], new Map()), [index]);
  const selected = selectedId ? nodeMap.get(selectedId) : undefined;
  const current = index?.currentNodeId ? nodeMap.get(index.currentNodeId) : undefined;

  useEffect(() => {
    setNameDraft(selected?.name ?? "");
    setRenaming(false);
  }, [selectedId]);

  useEffect(() => {
    if (!selectedId) return;
    requestAnimationFrame(() => document.querySelector('[data-branch-id="' + selectedId + '"]')?.scrollIntoView({ block: "nearest" }));
  }, [selectedId]);

  useEffect(() => {
    if (!selectedId) { setPreview(undefined); return; }
    let active = true;
    setPreview({ messages: [], total: 0, nextOffset: 0, nodeId: selectedId });
    setPreviewLoading(true); setPreviewError("");
    void api.branchPreview(chatId, selectedId, 0, 20).then((data) => {
      if (!active) return;
      setPreview({ messages: data.messages, total: data.total, nextOffset: data.nextOffset, nodeId: data.nodeId });
      requestAnimationFrame(() => { if (previewRef.current) previewRef.current.scrollTop = 0; });
    }).catch((cause: Error) => { if (active) setPreviewError(cause.message); })
      .finally(() => { if (active) setPreviewLoading(false); });
    return () => { active = false; };
  }, [chatId, selectedId]);

  const previewLoadingRef = useRef(false);
  const loadMorePreview = async () => {
    if (!selectedId || !preview || preview.nextOffset === null || previewLoadingRef.current) return;
    const nodeId = selectedId, offset = preview.nextOffset;
    previewLoadingRef.current = true; setPreviewLoading(true); setPreviewError("");
    try {
      const data = await api.branchPreview(chatId, nodeId, offset, 20);
      setPreview((previous) => previous && previous.nodeId === nodeId
        ? { messages: [...previous.messages, ...data.messages], total: data.total, nextOffset: data.nextOffset, nodeId }
        : previous);
    } catch (cause) { setPreviewError((cause as Error).message); }
    finally { previewLoadingRef.current = false; setPreviewLoading(false); }
  };

  const remember = (id?: string) => {
    if (!id) return;
    const next = [id, ...recentIds.filter((item) => item !== id)].slice(0, 20);
    setRecentIds(next);
    try { localStorage.setItem("pitavern.branch.recent." + chatId, JSON.stringify(next)); } catch { /* ignore */ }
  };

  const choose = (node: BranchTreeNodeDto) => {
    setSelectedId(node.id);
    setMobileView(true);
    remember(node.id);
    const parents = ancestorsOf(node, nodeMap);
    if (parents.length) {
      setExpanded((previous) => { const next = new Set(previous); for (const id of parents) next.add(id); saveUi(next, filter, node.id); return next; });
    } else saveUi(expanded, filter, node.id);
  };

  const switchTo = async (path: BranchPathStepDto[], label: string) => {
    if (busy || switching) return;
    const before = current;
    setSwitching(true); setError("");
    try {
      const result = await onSwitchPath(path, index?.revision ?? revision);
      if (!result) { setError("切换失败，请查看顶部提示"); return; }
      setIndex(result.index);
      setSelectedId(result.index.currentNodeId ?? selectedId);
      if (before) { setPreviousPath(before.path); setPreviousLabel(before.name || before.title); }
      setMobileView(true);
      remember(result.index.currentNodeId);
      setExpanded((previous) => new Set([...previous, ...result.index.activePath]));
    } finally { setSwitching(false); }
  };

  const updateMeta = async (patch: BranchMetaPatchDto) => {
    if (!index || !selected || metaSaving) return;
    setMetaSaving(true); setError("");
    try {
      const result = await api.updateBranchMeta(chatId, index.revision, selected.id, patch);
      setIndex(result.index);
      return result.index;
    } catch (cause) {
      setError((cause as Error).message);
      return undefined;
    } finally { setMetaSaving(false); }
  };

  const saveName = async () => {
    const result = await updateMeta({ name: nameDraft.trim() || null });
    if (result) setRenaming(false);
  };

  const toggleFavorite = async () => {
    if (!selected) return;
    await updateMeta({ favorite: !selected.favorite });
  };

  const filters: { value: Filter; label: string }[] = [
    { value: "all", label: "全部" },
    { value: "favorite", label: "收藏路线" },
    { value: "recent", label: "最近访问" },
  ];

  const normalizedQuery = query.trim().toLowerCase();
  const matches = (node: BranchTreeNodeDto) => !normalizedQuery || [node.name, node.title, node.userPreview, node.assistantPreview, node.preview, node.pathText]
    .some((value) => (value ?? "").toLowerCase().includes(normalizedQuery));
  const predicate = (node: BranchTreeNodeDto) => matches(node) && (filter === "all" || (filter === "favorite" ? node.favorite : recentIds.includes(node.id)));
  const filtered = index && (normalizedQuery || filter !== "all") ? filterTree(index.nodes, predicate) : index?.nodes ?? [];
  const filteredCount = countNodes(filtered);
  const forceOpen = Boolean(normalizedQuery) || filter !== "all";

  const toggle = (id: string) => {
    const next = new Set(expanded);
    if (next.has(id)) next.delete(id); else next.add(id);
    setExpanded(next);
    saveUi(next, filter, selectedId);
  };

  const selectFilter = (nextFilter: Filter) => {
    setFilter(nextFilter);
    saveUi(expanded, nextFilter, selectedId);
  };

  if (loading) return <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
    <div role="dialog" aria-modal="true" aria-label="分支选择" className="w-full max-w-5xl rounded-xl border border-tavern-border bg-tavern-panel p-8 text-sm text-tavern-dim">正在加载分支目录…</div>
  </div>;

  return <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
    <div role="dialog" aria-modal="true" aria-label="分支选择" aria-busy={busy || switching}
      onClick={(event) => event.stopPropagation()}
      className="flex h-[86vh] w-full max-w-5xl flex-col overflow-hidden rounded-xl border border-tavern-border bg-tavern-panel text-tavern-text shadow-2xl">
      <div className="flex flex-wrap items-center gap-3 border-b border-tavern-border px-5 py-3">
        <div className="min-w-0">
          <h2 className="text-lg font-medium">剧情分支</h2>
          <p className="text-xs text-tavern-dim">当前路线{current ? "：" + (current.name || current.title) : "尚无分叉"} · 共 {index?.total ?? 0} 个节点</p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <button type="button" onClick={() => {
            setQuery(""); selectFilter("all"); setSelectedId(index?.currentNodeId ?? index?.nodes[0]?.id);
            const next = new Set(index?.activePath ?? []); setExpanded(next); saveUi(next, "all", index?.currentNodeId);
          }}
            className="rounded-md border border-tavern-border px-2.5 py-1.5 text-xs text-tavern-dim hover:border-tavern-accent-dim hover:text-tavern-text">定位当前路线</button>
          <button type="button" onClick={() => {
            const next = new Set(index?.activePath ?? []); setExpanded(next); saveUi(next, filter, selectedId);
          }}
            className="rounded-md border border-tavern-border px-2.5 py-1.5 text-xs text-tavern-dim hover:border-tavern-accent-dim hover:text-tavern-text">收起其他分支</button>
          <button type="button" onClick={onClose} aria-label="关闭分支选择" className="rounded-md px-2 py-1 text-tavern-dim hover:text-tavern-text">✕</button>
        </div>
      </div>
      <div className="border-b border-tavern-border px-5 py-2">
        <input aria-label="搜索分支" value={query} onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索名称 / 剧情关键词 / 路径"
          className="w-full rounded-md border border-tavern-border bg-tavern-bg px-3 py-1.5 text-sm text-tavern-text outline-none placeholder:text-tavern-dim focus:border-tavern-accent-dim" />
        <div className="mt-2 flex flex-wrap items-center gap-1.5" role="tablist" aria-label="分支筛选">
          {filters.map((item) => <button key={item.value} type="button" role="tab" aria-selected={filter === item.value}
            onClick={() => selectFilter(item.value)}
            className={"rounded-full px-2.5 py-1 text-xs " + (filter === item.value ? "bg-tavern-accent/20 text-tavern-accent" : "text-tavern-dim hover:text-tavern-text")}>
            {item.label}
          </button>)}
          <span className="ml-auto text-[11px] text-tavern-dim">{filteredCount} 个节点{index?.truncated ? " · 已截断" : ""}</span>
        </div>
      </div>
      <div className="grid min-h-0 flex-1 md:grid-cols-[minmax(280px,380px)_1fr]">
        <div className={(mobileView ? "hidden md:flex" : "flex") + " min-h-0 flex-col border-r border-tavern-border"}>
          <div ref={treeRef} onScroll={(event) => { const value = { expanded: [...expanded], filter, selectedId, scrollTop: event.currentTarget.scrollTop }; try { localStorage.setItem("pitavern.branch.ui." + chatId, JSON.stringify(value)); } catch { /* ignore */ } }}
            className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
            {error && <div className="mb-2 flex items-center gap-2 rounded border border-red-500/40 px-2 py-1.5 text-xs text-red-300">
              <span role="alert" className="min-w-0 flex-1">{error}</span>
              <button type="button" onClick={() => void load()} className="rounded border border-red-500/30 px-2 py-0.5 hover:text-red-200">重试</button>
            </div>}
            {!index?.nodes.length ? <p className="rounded-lg border border-dashed border-tavern-border p-4 text-sm leading-6 text-tavern-dim">还没有分支。重新生成回复后，旧回复会保留为可切换的候选。</p>
              : !filtered.length ? <p className="rounded-lg border border-dashed border-tavern-border p-4 text-sm leading-6 text-tavern-dim">{filter === "recent" ? "还没有最近访问的路线。" : filter === "favorite" ? "还没有收藏路线。打开一条路线后点收藏。" : "没有匹配的分支。"}</p>
                : <>
                  <div className="mb-2 flex items-center justify-between rounded-md bg-tavern-raised/60 px-2 py-1.5 text-xs">
                    <span className="font-medium">故事起点</span>
                    <span className="text-tavern-dim">第 1 轮起</span>
                  </div>
                  {(() => {
                    const normal = filtered.filter((node) => !isUnused(node));
                    const unused = filtered.filter(isUnused);
                    const limit = forceOpen ? normal.length : rootPage * 12;
                    return <>
                      {normal.slice(0, limit).map((node) => <BranchRow key={node.id} node={node} depth={0} selectedId={selectedId}
                        expanded={expanded} forceOpen={forceOpen} onToggle={toggle} onSelect={choose} />)}
                      {!forceOpen && normal.length > limit && <button type="button" onClick={() => setRootPage((value) => value + 1)}
                        className="ml-7 rounded px-2 py-1 text-[10px] text-tavern-dim hover:text-tavern-text">显示更多（剩余 {normal.length - limit}）</button>}
                      {unused.length > 0 && !showUnusedRoot && !forceOpen && <button type="button" onClick={() => setShowUnusedRoot(true)}
                        className="ml-7 rounded px-2 py-1 text-[10px] text-tavern-dim hover:text-tavern-text">未继续的候选 × {unused.length}</button>}
                      {(showUnusedRoot || forceOpen) && unused.map((node) => <BranchRow key={node.id} node={node} depth={0} selectedId={selectedId}
                        expanded={expanded} forceOpen={forceOpen} onToggle={toggle} onSelect={choose} />)}
                      {showUnusedRoot && !forceOpen && <button type="button" onClick={() => setShowUnusedRoot(false)}
                        className="ml-7 rounded px-2 py-1 text-[10px] text-tavern-dim hover:text-tavern-text">收起未继续候选</button>}
                    </>;
                  })()}
                </>}
          </div>
        </div>
        <div className={(mobileView ? "flex" : "hidden md:flex") + " min-h-0 flex-col overflow-y-auto p-5"}>
          {mobileView && <button type="button" onClick={() => setMobileView(false)}
            className="mb-3 self-start rounded-md border border-tavern-border px-3 py-1.5 text-xs text-tavern-dim md:hidden">← 返回目录</button>}
          {selected ? <>
            <div className="flex flex-wrap items-start gap-2">
              <div className="min-w-0 flex-1">
                <h3 className="break-words text-base font-medium">{selected.name || selected.title}</h3>
                {selected.name && <p className="mt-0.5 text-xs text-tavern-dim">{selected.title}</p>}
              </div>
              <button type="button" onClick={() => void toggleFavorite()} disabled={metaSaving}
                className={"rounded-md border px-2 py-1 text-xs " + (selected.favorite ? "border-amber-400/50 text-amber-300" : "border-tavern-border text-tavern-dim hover:text-tavern-text")}>
                {selected.favorite ? "★ 已收藏" : "☆ 收藏"}
              </button>
              <button type="button" onClick={() => setRenaming((value) => !value)} disabled={metaSaving}
                className="rounded-md border border-tavern-border px-2 py-1 text-xs text-tavern-dim hover:text-tavern-text">重命名</button>
            </div>
            {renaming && <div className="mt-2 flex gap-2">
              <input aria-label="路线名称" value={nameDraft} onChange={(event) => setNameDraft(event.target.value)} maxLength={80}
                placeholder={selected.title}
                className="min-w-0 flex-1 rounded-md border border-tavern-border bg-tavern-bg px-2 py-1.5 text-sm text-tavern-text outline-none" />
              <button type="button" onClick={() => void saveName()} disabled={metaSaving}
                className="rounded-md bg-tavern-accent px-3 py-1.5 text-xs font-medium text-tavern-bg disabled:opacity-40">保存名称</button>
            </div>}
            <div className="mt-3 flex flex-wrap gap-1.5 text-[11px] text-tavern-dim">
              <span className="rounded-full border border-tavern-border px-2 py-0.5">第 {selected.turn} 轮</span>
              <span className="rounded-full border border-tavern-border px-2 py-0.5">保存到第 {selected.totalTurns} 轮</span>
              <span className="rounded-full border border-tavern-border px-2 py-0.5">下级分支 {selected.childCount}</span>
              {selected.archived && <span className="rounded-full border border-tavern-border px-2 py-0.5">已归档</span>}
            </div>
            <div className="mt-3 min-w-0 rounded-lg border border-tavern-border bg-tavern-bg/50 p-3">
              <p className="mb-1 text-[11px] text-tavern-dim">路径</p>
              <div className="flex flex-wrap gap-1 text-xs">
                {selected.pathIds.map((id, order) => {
                  const pathNode = nodeMap.get(id);
                  return <span key={id} className="flex items-center gap-1">
                    {order > 0 && <span className="text-tavern-dim">›</span>}
                    <button type="button" onClick={() => pathNode && choose(pathNode)} className="text-left text-tavern-dim hover:text-tavern-accent">{pathNode?.name || pathNode?.title || id}</button>
                  </span>;
                })}
              </div>
            </div>
            <div className="mt-4 shrink-0">
              <div className="mb-2 flex items-center justify-between gap-2 text-[11px] text-tavern-dim">
                <span>剧情预览 · 原文</span>
                {preview && <span>{preview.messages.length} / {preview.total} 条{preview.nextOffset !== null ? " · 下滑加载" : " · 已加载全文"}</span>}
              </div>
              <div ref={previewRef} onScroll={(event) => {
                const element = event.currentTarget;
                if (element.scrollTop + element.clientHeight >= element.scrollHeight - 80) void loadMorePreview();
              }} className="max-h-[42vh] min-h-24 overflow-y-auto rounded-lg border border-tavern-border bg-tavern-bg/40 p-3">
                {preview?.messages.map((message, index) => (
                  <div key={(message.id ?? "message") + ":" + index} className="border-b border-tavern-border/50 py-2 first:pt-0 last:border-0 last:pb-0">
                    <div className="mb-0.5 text-[10px] text-tavern-dim">{message.role === "user" ? "用户" : message.name || "角色"}</div>
                    <p className="whitespace-pre-wrap break-words text-sm leading-6 text-tavern-text">{message.text}</p>
                  </div>
                ))}
                {previewError && <p role="alert" className="text-xs text-red-300">{previewError}</p>}
                {previewLoading && <p role="status" className="py-2 text-center text-xs text-tavern-dim">正在加载原文…</p>}
                {!previewLoading && !previewError && preview && preview.messages.length === 0 && <p className="py-2 text-center text-xs text-tavern-dim">没有可预览的正文。</p>}
                {!previewLoading && preview?.nextOffset !== null && preview?.nextOffset !== undefined && (
                  <button type="button" onClick={() => void loadMorePreview()} className="mt-2 w-full rounded border border-tavern-border px-2 py-1 text-xs text-tavern-dim hover:text-tavern-text">加载更多（下滑）</button>
                )}
                {!previewLoading && preview && preview.nextOffset === null && preview.messages.length > 0 && <p className="pt-2 text-center text-[10px] text-tavern-dim">已加载全文</p>}
              </div>
              {selected.note && <p className="mt-2 whitespace-pre-wrap text-xs text-tavern-dim">备注：{selected.note}</p>}
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              <button type="button" onClick={() => void switchTo(selected.path, selected.name || selected.title)}
                disabled={busy || switching || selected.isCurrent || selected.isActive}
                className="rounded-md bg-tavern-accent px-4 py-2 text-sm font-medium text-tavern-bg disabled:cursor-not-allowed disabled:opacity-40">
                {switching ? "切换中…" : selected.isCurrent ? "当前路线" : selected.isActive ? "当前路径中的分叉" : "继续这条路线"}
              </button>
              {previousPath && <button type="button" onClick={() => void switchTo(previousPath, previousLabel)} disabled={busy || switching}
                className="rounded-md border border-tavern-border px-3 py-2 text-sm text-tavern-dim hover:border-tavern-accent-dim hover:text-tavern-text">返回刚才路线</button>}
            </div>
            <div className="mt-auto shrink-0 pt-5">
              <div className="border-t border-tavern-border pt-3">
                <label htmlFor="branch-regenerate-instruction" className="block text-xs font-medium">换条路线（可选）</label>
                <textarea id="branch-regenerate-instruction" rows={2} value={instruction} onChange={(event) => setInstruction(event.target.value)}
                  placeholder="例如：让主角拒绝邀请，改走夜探路线"
                  className="mt-1.5 w-full resize-y rounded-lg border border-tavern-border bg-tavern-bg px-3 py-2 text-sm text-tavern-text placeholder:text-tavern-dim focus:border-tavern-accent focus:outline-none" />
                <div className="mt-2 flex flex-wrap items-center gap-3">
                  <button type="button" disabled={busy || !canRegenerate} onClick={() => { onRegenerate(instruction.trim()); onClose(); }}
                    className="rounded-lg bg-tavern-accent px-4 py-2 text-sm font-medium text-tavern-bg disabled:cursor-not-allowed disabled:opacity-40">按此方向重新生成</button>
                  <p className="text-[11px] text-tavern-dim">只影响本次生成，不写入聊天记录</p>
                </div>
                {!canRegenerate && <p className="mt-1 text-[11px] text-tavern-dim">最后一条不是可重新生成的回复</p>}
              </div>
            </div>
          </> : <p className="rounded-lg border border-dashed border-tavern-border p-6 text-sm text-tavern-dim">从左侧目录选择一个分支节点查看剧情预览。</p>}
        </div>
      </div>
    </div>
  </div>;
}
