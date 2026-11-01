import { useEffect, useRef, useState } from "react";
import type {
  WorldSnapshot,
  WorldTemplate,
  WorldTemplateEditorDto,
  WorldTemplateLibrarySummaryDto,
  WorldTemplateSummaryDto,
} from "@pitavern/shared/world";
import { KnowledgeEditor } from "./KnowledgeEditor.tsx";
import { api, ApiError } from "../api.ts";
import { buttonClass, fieldClass } from "./libraryStyles.ts";

interface WorldTemplatesDialogProps {
  onClose: () => void;
  /** 模板库写操作后刷新侧栏的新聊天模板选择器。 */
  onChanged: () => void;
}

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function cloneTemplate(value: WorldTemplate): WorldTemplate {
  return structuredClone(value);
}

/** 保存前去掉首尾空白；空描述不落库，保持服务端内容哈希稳定。 */
function normalizedTemplate(value: WorldTemplate): WorldTemplate {
  const next = cloneTemplate(value);
  const clean = (entry: { id: string; name: string; description?: string }) => {
    entry.id = entry.id.trim();
    entry.name = entry.name.trim();
    if (entry.description !== undefined) {
      const text = entry.description.trim();
      if (text) entry.description = text;
      else delete entry.description;
    }
  };
  next.locations.forEach(clean);
  next.actors.forEach(clean);
  next.items.forEach((entry) => {
    clean(entry);
    entry.price = Number.isFinite(entry.price) ? entry.price : 0;
  });
  next.initial.actorId = next.initial.actorId.trim();
  next.initial.locationId = next.initial.locationId.trim();
  next.initial.money = Number.isFinite(next.initial.money) ? next.initial.money : 0;
  next.initial.inventory.forEach((entry) => {
    entry.ownerId = entry.ownerId.trim();
    entry.itemId = entry.itemId.trim();
    entry.quantity = Number.isFinite(entry.quantity) ? entry.quantity : 0;
  });
  return next;
}

function nextId(prefix: string, rows: Array<{ id: string }>): string {
  const used = new Set(rows.map((entry) => entry.id));
  let index = rows.length + 1;
  while (used.has(prefix + index)) index += 1;
  return prefix + index;
}

function dateText(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN");
}

function SnapshotPreview({ snapshot, template }: { snapshot: WorldSnapshot; template: WorldTemplate }) {
  const actorName = (id: string) => template.actors.find((entry) => entry.id === id)?.name ?? id;
  const locationName = (id: string) => template.locations.find((entry) => entry.id === id)?.name ?? id;
  const itemName = (id: string) => template.items.find((entry) => entry.id === id)?.name ?? id;
  const money = snapshot.money[template.initial.actorId];
  const inventory = snapshot.inventory
    .map((entry) => `${actorName(entry.ownerId)}·${itemName(entry.itemId)}×${entry.quantity}`)
    .join("、") || "无";
  return (
    <section aria-label="初始世界预览" className="space-y-1 rounded-lg border border-tavern-border bg-tavern-bg/60 p-3 text-xs text-tavern-text">
      <h3 className="text-sm font-medium">初始世界预览（服务端）</h3>
      <p>地点 {template.locations.length} · 角色 {template.actors.length} · 物品 {template.items.length}</p>
      <p>初始玩家 {actorName(template.initial.actorId)} · 初始地点 {locationName(snapshot.scene.locationId)} · 初始金额 {money ?? "未记录"}</p>
      <p>初始库存：{inventory}</p>
      <p className="break-words text-tavern-dim">
        模板版本 v{snapshot.templateVersion} · 规则版本 v{snapshot.rulesVersion} · 哈希 {snapshot.templateHash.slice(0, 10)}…
      </p>
      {snapshot.scene.presentActorIds.length > 0 && (
        <p className="break-words text-tavern-dim">初始在场：{snapshot.scene.presentActorIds.map(actorName).join("、")}</p>
      )}
    </section>
  );
}

export default function WorldTemplatesDialog({ onClose, onChanged }: WorldTemplatesDialogProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [list, setList] = useState<WorldTemplateLibrarySummaryDto[]>([]);
  const [builtins, setBuiltins] = useState<WorldTemplateSummaryDto[]>([]);
  const [builtinId, setBuiltinId] = useState("");
  const [newName, setNewName] = useState("");
  const [editor, setEditor] = useState<WorldTemplateEditorDto | null>(null);
  const [template, setTemplate] = useState<WorldTemplate | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");

  const dirty = !!editor && !!template && (
    name !== editor.name
    || description !== (editor.description ?? "")
    || JSON.stringify(template) !== JSON.stringify(editor.draft)
  );

  const applyEditor = (value: WorldTemplateEditorDto) => {
    setEditor(value);
    setTemplate(cloneTemplate(value.draft));
    setName(value.name);
    setDescription(value.description ?? "");
  };

  const refreshList = async (): Promise<void> => {
    setList(await api.worldTemplateLibrary());
  };

  useEffect(() => {
    if (dialog.current && !dialog.current.open) dialog.current.showModal();
    let cancelled = false;
    setLoading(true);
    void Promise.all([api.worldTemplateLibrary(), api.worldTemplates()])
      .then(([library, templates]) => {
        if (cancelled) return;
        setList(library);
        const builtin = templates.filter((entry) => entry.source === "builtin");
        setBuiltins(builtin);
        setBuiltinId((current) => current || builtin[0]?.id || "");
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError("读取世界模板库失败：" + errorText(cause));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
      if (dialog.current?.open) dialog.current.close();
    };
  }, []);

  const requestClose = () => {
    if (busy) return;
    if (dirty && !window.confirm("当前模板有未保存的修改，确定关闭世界模板编辑器？")) return;
    onClose();
  };

  const confirmDiscard = (action: string): boolean =>
    !dirty || window.confirm(`当前模板有未保存的修改，确定放弃并${action}？`);

  const updateTemplate = (mutate: (draft: WorldTemplate) => void) => {
    setTemplate((current) => {
      if (!current) return current;
      const next = cloneTemplate(current);
      mutate(next);
      return next;
    });
  };

  /** 409：保留服务端原始提示，重新载入最新内容并刷新列表。 */
  const handleFailure = async (cause: unknown, id?: string): Promise<void> => {
    const message = errorText(cause);
    if (!(cause instanceof ApiError) || cause.status !== 409 || !id) {
      setError(message);
      return;
    }
    setError(message + "；已重新载入最新内容，本地未保存的修改已丢弃");
    try {
      applyEditor(await api.worldTemplateEditor(id));
      await refreshList();
    } catch (reloadCause) {
      setError(message + "；重新载入失败：" + errorText(reloadCause));
    }
  };

  const createBlank = async () => {
    if (busy || !confirmDiscard("新建空白模板")) return;
    setBusy(true); setError(""); setStatus("");
    try {
      const value = await api.createWorldTemplateBlank(newName.trim() || undefined);
      applyEditor(value);
      setNewName("");
      setStatus(`已创建空白模板「${value.name}」，编辑后请保存草稿`);
      await refreshList();
      onChanged();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  };

  const copyBuiltin = async () => {
    if (busy || !builtinId || !confirmDiscard("复制内置模板")) return;
    const sourceName = builtins.find((entry) => entry.id === builtinId)?.name ?? builtinId;
    setBusy(true); setError(""); setStatus("");
    try {
      const value = await api.copyBuiltinWorldTemplate(builtinId, newName.trim() || undefined);
      applyEditor(value);
      setNewName("");
      setStatus(`已从内置模板「${sourceName}」创建副本「${value.name}」，当前为草稿`);
      await refreshList();
      onChanged();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  };

  const selectTemplate = async (id: string) => {
    if (busy || editor?.id === id) return;
    if (dirty && !window.confirm("当前模板有未保存的修改，确定放弃并切换模板？")) return;
    setBusy(true); setError(""); setStatus("");
    try {
      applyEditor(await api.worldTemplateEditor(id));
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  };

  const refresh = async () => {
    if (busy) return;
    setBusy(true); setError("");
    try {
      await refreshList();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (busy || !editor || !template) return;
    if (!name.trim()) { setError("模板名称不能为空"); return; }
    const id = editor.id;
    setBusy(true); setError(""); setStatus("");
    try {
      const value = await api.saveWorldTemplateDraft(id, {
        revision: editor.draftRevision,
        name: name.trim(),
        description: description.trim() || undefined,
        template: normalizedTemplate(template),
      });
      applyEditor(value);
      setStatus(`草稿已保存（修订 ${value.draftRevision}）`);
      await refreshList();
      onChanged();
    } catch (cause) {
      await handleFailure(cause, id);
    } finally {
      setBusy(false);
    }
  };

  const publish = async () => {
    if (busy || !editor) return;
    if (dirty) { setError("请先保存草稿，再发布。"); return; }
    const id = editor.id;
    const previousVersions = editor.versions.length;
    const metadataChanged = !!editor.published && (
      name !== (editor.published.name ?? "") || (description || "") !== (editor.published.description ?? "")
    );
    setBusy(true); setError(""); setStatus("");
    try {
      const value = await api.publishWorldTemplate(id, editor.draftRevision);
      const created = value.versions.length > previousVersions;
      applyEditor(value);
      setStatus(created
        ? `已发布版本 v${value.publishedVersion ?? value.versions[0]?.templateVersion}`
        : metadataChanged
          ? "已更新发布名称/描述（模板内容未变，未生成新版本）"
          : "草稿与当前发布版本一致，没有生成新版本");
      await refreshList();
      onChanged();
    } catch (cause) {
      await handleFailure(cause, id);
    } finally {
      setBusy(false);
    }
  };

  const reload = async () => {
    if (busy || !editor) return;
    if (dirty && !window.confirm("重新载入会丢弃未保存的修改，确定继续？")) return;
    const id = editor.id;
    setBusy(true); setError(""); setStatus("");
    try {
      applyEditor(await api.worldTemplateEditor(id));
      await refreshList();
      setStatus("已重新载入最新内容");
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (busy || !editor) return;
    const target = editor;
    if (!window.confirm(`确定删除模板「${target.name}」？已有聊天继续使用各自内嵌的模板版本，不受影响。`)) return;
    setBusy(true); setError(""); setStatus("");
    try {
      await api.deleteWorldTemplate(target.id);
      setEditor(null);
      setTemplate(null);
      setName("");
      setDescription("");
      await refreshList();
      setStatus(`已删除模板「${target.name}」；已有聊天继续使用内嵌版本`);
      onChanged();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  };

  const exportDraft = () => {
    if (!editor) return;
    const anchor = document.createElement("a");
    anchor.href = api.worldTemplateExportUrl(editor.id);
    anchor.download = `${editor.name || editor.id}.world-template.json`;
    anchor.rel = "noopener";
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setStatus(dirty ? "已开始导出最近保存的草稿；未保存的修改不会导出" : "已开始导出模板 JSON");
  };

  const importFile = async (file: File | undefined) => {
    if (!file || busy || !confirmDiscard("导入模板")) return;
    setBusy(true); setError(""); setStatus("");
    try {
      let payload: unknown;
      try {
        payload = JSON.parse(await file.text());
      } catch {
        throw new Error("导入失败：文件内容不是有效 JSON");
      }
      const value = await api.importWorldTemplate(payload);
      applyEditor(value);
      setStatus(`已导入模板「${value.name}」，当前为草稿`);
      await refreshList();
      onChanged();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  };

  const addLocation = () => updateTemplate((draft) => {
    draft.locations.push({ id: nextId("location-", draft.locations), name: "新地点" });
  });
  const addActor = () => updateTemplate((draft) => {
    draft.actors.push({ id: nextId("actor-", draft.actors), name: "新角色" });
  });
  const addItem = () => updateTemplate((draft) => {
    draft.items.push({ id: nextId("item-", draft.items), name: "新物品", price: 0 });
  });
  const addInventory = () => updateTemplate((draft) => {
    const ownerId = draft.actors.find((entry) => entry.id === draft.initial.actorId)?.id ?? draft.actors[0]?.id ?? "";
    draft.initial.inventory.push({ ownerId, itemId: draft.items[0]?.id ?? "", quantity: 1 });
  });

  const loadingHint = loading && <p className="text-xs text-tavern-dim">正在读取模板库…</p>;

  const renderEditor = () => {
    if (!editor || !template) {
      return (
        <div className="rounded-lg border border-dashed border-tavern-border p-4 text-sm text-tavern-dim">
          从左侧列表选择模板进入编辑，或新建空白模板、从内置模板复制、导入模板 JSON。
        </div>
      );
    }
    const publishedHash = editor.publishedHash;
    return (
      <div className="min-w-0 space-y-4">
        <div className="flex flex-wrap items-start gap-2 rounded-lg border border-tavern-border p-3">
          <div className="min-w-0 flex-1">
            <h3 className="font-medium">编辑：{editor.name}</h3>
            <p className="mt-0.5 break-words text-xs text-tavern-dim">
              模板 ID <code className="break-all">{editor.id}</code> · 草稿修订 {editor.draftRevision}
            </p>
          </div>
          <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs ${publishedHash ? "bg-emerald-400/15 text-emerald-300" : "bg-amber-400/15 text-amber-300"}`}>
            {publishedHash ? `已发布 v${editor.publishedVersion ?? "?"}` : "未发布"}
          </span>
          <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs ${dirty ? "bg-amber-400/15 text-amber-300" : "bg-tavern-raised text-tavern-dim"}`}>
            {dirty ? "有未保存修改" : "未保存修改：无"}
          </span>
        </div>

        <div className="flex flex-wrap gap-2">
          <button type="button" disabled={busy || !dirty} onClick={() => void save()} className="rounded-lg bg-tavern-accent px-3 py-2 text-sm text-tavern-bg disabled:opacity-40">
            {busy ? "处理中…" : "保存草稿"}
          </button>
          <button type="button" disabled={busy || dirty} onClick={() => void publish()} className={buttonClass} title={dirty ? "请先保存草稿再发布" : undefined}>
            发布模板
          </button>
          <button type="button" disabled={busy} onClick={exportDraft} className={buttonClass}>导出草稿 JSON</button>
          <button type="button" disabled={busy} onClick={() => void reload()} className={buttonClass}>重新载入</button>
          <button type="button" disabled={busy} onClick={() => void remove()} className={buttonClass + " border-red-400/50 text-red-300"}>删除模板</button>
        </div>
        <p className="text-xs leading-5 text-tavern-dim">
          保存只写入草稿并递增修订号；发布生成不可变版本供新聊天选择。已有聊天始终使用自身 JSONL 内嵌的模板版本，不受这里的发布或删除影响。
        </p>
        {dirty && <p className="text-xs text-amber-300">初始世界预览和版本列表来自最近一次保存的草稿；保存或重新载入后才会更新。</p>}

        <div className="grid gap-3 sm:grid-cols-2">
          <label className="min-w-0 text-xs text-tavern-dim">模板名称
            <input aria-label="模板名称" className={fieldClass} value={name} maxLength={100} disabled={busy} onChange={(event) => setName(event.target.value)} />
          </label>
          <label className="min-w-0 text-xs text-tavern-dim">模板描述
            <input aria-label="模板描述" className={fieldClass} value={description} maxLength={500} disabled={busy} onChange={(event) => setDescription(event.target.value)} />
          </label>
        </div>

        <section aria-label="地点定义" className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-medium">地点（{template.locations.length}）</h3>
            <button type="button" disabled={busy} onClick={addLocation} className={buttonClass}>添加地点</button>
          </div>
          {template.locations.map((entry, index) => (
            <div key={index} className="grid min-w-0 gap-2 rounded-lg border border-tavern-border p-2 sm:grid-cols-3">
              <label className="min-w-0 text-xs text-tavern-dim">ID
                <input aria-label={`地点 ${index + 1} ID`} className={fieldClass} value={entry.id} disabled={busy}
                  onChange={(event) => updateTemplate((draft) => { draft.locations[index] = { ...draft.locations[index], id: event.target.value }; })} />
              </label>
              <label className="min-w-0 text-xs text-tavern-dim">名称
                <input aria-label={`地点 ${index + 1} 名称`} className={fieldClass} value={entry.name} disabled={busy}
                  onChange={(event) => updateTemplate((draft) => { draft.locations[index] = { ...draft.locations[index], name: event.target.value }; })} />
              </label>
              <div className="flex min-w-0 items-end gap-2">
                <label className="min-w-0 flex-1 text-xs text-tavern-dim">描述
                  <input aria-label={`地点 ${index + 1} 描述`} className={fieldClass} value={entry.description ?? ""} disabled={busy}
                    onChange={(event) => updateTemplate((draft) => { draft.locations[index] = { ...draft.locations[index], description: event.target.value }; })} />
                </label>
                <button type="button" aria-label={`删除地点 ${index + 1}`} disabled={busy || template.locations.length <= 1}
                  onClick={() => updateTemplate((draft) => { draft.locations.splice(index, 1); })}
                  className="shrink-0 rounded border border-tavern-border px-2 py-2 text-xs text-red-300 disabled:opacity-40">删除</button>
              </div>
            </div>
          ))}
        </section>

        <section aria-label="角色定义" className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-medium">角色（{template.actors.length}）</h3>
            <button type="button" disabled={busy} onClick={addActor} className={buttonClass}>添加角色</button>
          </div>
          {template.actors.map((entry, index) => (
            <div key={index} className="grid min-w-0 gap-2 rounded-lg border border-tavern-border p-2 sm:grid-cols-3">
              <label className="min-w-0 text-xs text-tavern-dim">ID
                <input aria-label={`角色 ${index + 1} ID`} className={fieldClass} value={entry.id} disabled={busy}
                  onChange={(event) => updateTemplate((draft) => { draft.actors[index] = { ...draft.actors[index], id: event.target.value }; })} />
              </label>
              <label className="min-w-0 text-xs text-tavern-dim">名称
                <input aria-label={`角色 ${index + 1} 名称`} className={fieldClass} value={entry.name} disabled={busy}
                  onChange={(event) => updateTemplate((draft) => { draft.actors[index] = { ...draft.actors[index], name: event.target.value }; })} />
              </label>
              <div className="flex min-w-0 items-end gap-2">
                <label className="min-w-0 flex-1 text-xs text-tavern-dim">描述
                  <input aria-label={`角色 ${index + 1} 描述`} className={fieldClass} value={entry.description ?? ""} disabled={busy}
                    onChange={(event) => updateTemplate((draft) => { draft.actors[index] = { ...draft.actors[index], description: event.target.value }; })} />
                </label>
                <button type="button" aria-label={`删除角色 ${index + 1}`} disabled={busy || template.actors.length <= 1}
                  onClick={() => updateTemplate((draft) => { draft.actors.splice(index, 1); })}
                  className="shrink-0 rounded border border-tavern-border px-2 py-2 text-xs text-red-300 disabled:opacity-40">删除</button>
              </div>
            </div>
          ))}
        </section>

        <section aria-label="物品定义" className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-medium">物品（{template.items.length}）</h3>
            <button type="button" disabled={busy} onClick={addItem} className={buttonClass}>添加物品</button>
          </div>
          {template.items.length === 0 && <p className="text-xs text-tavern-dim">还没有固定价格物品；库存需要至少一个物品。</p>}
          {template.items.map((entry, index) => (
            <div key={index} className="grid min-w-0 gap-2 rounded-lg border border-tavern-border p-2 sm:grid-cols-4">
              <label className="min-w-0 text-xs text-tavern-dim">ID
                <input aria-label={`物品 ${index + 1} ID`} className={fieldClass} value={entry.id} disabled={busy}
                  onChange={(event) => updateTemplate((draft) => { draft.items[index] = { ...draft.items[index], id: event.target.value }; })} />
              </label>
              <label className="min-w-0 text-xs text-tavern-dim">名称
                <input aria-label={`物品 ${index + 1} 名称`} className={fieldClass} value={entry.name} disabled={busy}
                  onChange={(event) => updateTemplate((draft) => { draft.items[index] = { ...draft.items[index], name: event.target.value }; })} />
              </label>
              <div className="flex min-w-0 items-end gap-2">
                <label className="min-w-0 flex-1 text-xs text-tavern-dim">描述
                  <input aria-label={`物品 ${index + 1} 描述`} className={fieldClass} value={entry.description ?? ""} disabled={busy}
                    onChange={(event) => updateTemplate((draft) => { draft.items[index] = { ...draft.items[index], description: event.target.value }; })} />
                </label>
                <button type="button" aria-label={`删除物品 ${index + 1}`} disabled={busy}
                  onClick={() => updateTemplate((draft) => { draft.items.splice(index, 1); })}
                  className="shrink-0 rounded border border-tavern-border px-2 py-2 text-xs text-red-300 disabled:opacity-40">删除</button>
              </div>
              <label className="min-w-0 text-xs text-tavern-dim">固定价格
                <input type="number" min={0} step={1} aria-label={`物品 ${index + 1} 固定价格`} className={fieldClass} value={entry.price} disabled={busy}
                  onChange={(event) => updateTemplate((draft) => { draft.items[index] = { ...draft.items[index], price: Number(event.target.value) }; })} />
              </label>
            </div>
          ))}
        </section>

        <section aria-label="初始状态" className="space-y-2">
          <h3 className="text-sm font-medium">初始状态</h3>
          <div className="grid min-w-0 gap-2 rounded-lg border border-tavern-border p-2 sm:grid-cols-3">
            <label className="min-w-0 text-xs text-tavern-dim">初始玩家角色
              <select aria-label="初始角色" className={fieldClass} value={template.initial.actorId} disabled={busy}
                onChange={(event) => updateTemplate((draft) => { draft.initial.actorId = event.target.value; })}>
                {!template.actors.some((entry) => entry.id === template.initial.actorId) && (
                  <option value={template.initial.actorId}>（未声明的角色：{template.initial.actorId}）</option>
                )}
                {template.actors.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}（{entry.id}）</option>)}
              </select>
            </label>
            <label className="min-w-0 text-xs text-tavern-dim">初始地点
              <select aria-label="初始地点" className={fieldClass} value={template.initial.locationId} disabled={busy}
                onChange={(event) => updateTemplate((draft) => { draft.initial.locationId = event.target.value; })}>
                {!template.locations.some((entry) => entry.id === template.initial.locationId) && (
                  <option value={template.initial.locationId}>（未声明的地点：{template.initial.locationId}）</option>
                )}
                {template.locations.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}（{entry.id}）</option>)}
              </select>
            </label>
            <label className="min-w-0 text-xs text-tavern-dim">初始金额
              <input type="number" min={0} step={1} aria-label="初始金额" className={fieldClass} value={template.initial.money} disabled={busy}
                onChange={(event) => updateTemplate((draft) => { draft.initial.money = Number(event.target.value); })} />
            </label>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2">
            <h4 className="text-xs font-medium text-tavern-dim">初始库存（{template.initial.inventory.length}）</h4>
            <button type="button" disabled={busy || template.actors.length === 0 || template.items.length === 0} onClick={addInventory}
              className={buttonClass} title={template.items.length === 0 ? "请先添加物品" : undefined}>添加库存</button>
          </div>
          {template.initial.inventory.map((entry, index) => (
            <div key={index} className="grid min-w-0 gap-2 rounded-lg border border-tavern-border p-2 sm:grid-cols-4">
              <label className="min-w-0 text-xs text-tavern-dim">归属
                <select aria-label={`库存 ${index + 1} 归属`} className={fieldClass} value={entry.ownerId} disabled={busy}
                  onChange={(event) => updateTemplate((draft) => { draft.initial.inventory[index] = { ...draft.initial.inventory[index], ownerId: event.target.value }; })}>
                  {!template.actors.some((actor) => actor.id === entry.ownerId) && <option value={entry.ownerId}>（未声明：{entry.ownerId}）</option>}
                  {template.actors.map((actor) => <option key={actor.id} value={actor.id}>{actor.name}（{actor.id}）</option>)}
                </select>
              </label>
              <label className="min-w-0 text-xs text-tavern-dim">物品
                <select aria-label={`库存 ${index + 1} 物品`} className={fieldClass} value={entry.itemId} disabled={busy}
                  onChange={(event) => updateTemplate((draft) => { draft.initial.inventory[index] = { ...draft.initial.inventory[index], itemId: event.target.value }; })}>
                  {!template.items.some((item) => item.id === entry.itemId) && <option value={entry.itemId}>（未声明：{entry.itemId}）</option>}
                  {template.items.map((item) => <option key={item.id} value={item.id}>{item.name}（{item.id}）</option>)}
                </select>
              </label>
              <label className="min-w-0 text-xs text-tavern-dim">数量
                <input type="number" min={1} step={1} aria-label={`库存 ${index + 1} 数量`} className={fieldClass} value={entry.quantity} disabled={busy}
                  onChange={(event) => updateTemplate((draft) => { draft.initial.inventory[index] = { ...draft.initial.inventory[index], quantity: Number(event.target.value) }; })} />
              </label>
              <div className="flex items-end">
                <button type="button" aria-label={`删除库存 ${index + 1}`} disabled={busy}
                  onClick={() => updateTemplate((draft) => { draft.initial.inventory.splice(index, 1); })}
                  className="rounded border border-tavern-border px-2 py-2 text-xs text-red-300 disabled:opacity-40">删除库存</button>
              </div>
            </div>
          ))}
        </section>

        <KnowledgeEditor template={template} change={updateTemplate} busy={busy} />

        {editor.initialSnapshot
          ? <SnapshotPreview snapshot={editor.initialSnapshot} template={template} />
          : <p className="rounded-lg border border-amber-400/40 bg-amber-400/10 p-2 text-xs text-amber-300">服务端没有返回初始世界预览，请保存草稿后重新载入。</p>}

        <section aria-label="模板版本" className="space-y-2 rounded-lg border border-tavern-border p-3">
          <h3 className="text-sm font-medium">发布版本（{editor.versions.length}）</h3>
          <p className="break-words text-xs text-tavern-dim">
            当前发布：{publishedHash ? <code className="break-all">{publishedHash}</code> : "尚未发布"}
          </p>
          {editor.versions.length === 0
            ? <p className="text-xs text-tavern-dim">发布草稿后生成不可变版本记录，新聊天选择器才会出现此模板。</p>
            : (
              <ul aria-label="模板版本列表" className="space-y-1">
                {editor.versions.map((version) => (
                  <li key={version.contentHash} className="rounded border border-tavern-border bg-tavern-bg/60 p-2 text-xs">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">版本 v{version.templateVersion}</span>
                      <span className="text-tavern-dim">规则 v{version.rulesVersion}</span>
                      <span className="text-tavern-dim">{dateText(version.createdAt)}</span>
                      {version.contentHash === publishedHash && <span className="rounded-full bg-emerald-400/15 px-2 py-0.5 text-emerald-300">当前发布</span>}
                    </div>
                    <code className="mt-1 block break-all text-tavern-dim">{version.contentHash}</code>
                  </li>
                ))}
              </ul>
            )}
        </section>
      </div>
    );
  };

  return (
    <dialog ref={dialog} aria-labelledby="world-templates-title" onCancel={(event) => { event.preventDefault(); requestClose(); }}
      className="m-auto max-h-[92dvh] w-[min(1100px,96vw)] overflow-y-auto rounded-xl border border-tavern-border bg-tavern-panel p-0 text-tavern-text backdrop:bg-black/60">
      <div className="sticky top-0 z-10 flex flex-wrap items-center gap-2 border-b border-tavern-border bg-tavern-panel p-4">
        <h2 id="world-templates-title" className="mr-auto font-medium">世界模板{dirty ? " · 未保存" : ""}</h2>
        <button type="button" disabled={busy} onClick={requestClose} className={buttonClass}>关闭世界模板</button>
      </div>
      <div className="grid min-w-0 gap-4 p-4 text-sm lg:grid-cols-[280px_minmax(0,1fr)]">
        <aside className="min-w-0 space-y-3">
          <div className="space-y-2 rounded-lg border border-tavern-border p-3">
            <label className="block text-xs text-tavern-dim">新模板名
              <input aria-label="新模板名" className={fieldClass} value={newName} maxLength={100} disabled={busy}
                placeholder="留空时自动命名" onChange={(event) => setNewName(event.target.value)} />
            </label>
            <div className="flex flex-wrap gap-2">
              <button type="button" disabled={busy} onClick={() => void createBlank()} className={buttonClass}>新建空白</button>
              <button type="button" disabled={busy} onClick={() => void refresh()} className={buttonClass}>刷新列表</button>
            </div>
            <label className="block text-xs text-tavern-dim">内置模板
              <select aria-label="内置模板" className={fieldClass} value={builtinId} disabled={busy || builtins.length === 0}
                onChange={(event) => setBuiltinId(event.target.value)}>
                {builtins.length === 0 && <option value="">没有内置模板</option>}
                {builtins.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
              </select>
            </label>
            <button type="button" disabled={busy || !builtinId} onClick={() => void copyBuiltin()} className={buttonClass + " w-full"}>复制内置模板</button>
            <div className="flex flex-wrap gap-2 border-t border-tavern-border pt-2">
              <button type="button" disabled={busy} onClick={() => fileInput.current?.click()} className={buttonClass}>导入 JSON</button>
              <input ref={fileInput} type="file" accept=".json,application/json" hidden aria-label="导入模板 JSON 文件"
                onChange={(event) => void importFile(event.target.files?.[0])} />
              <span className="text-[11px] leading-5 text-tavern-dim">导入生成草稿；相同模板 ID 会分配新 ID，不覆盖已有模板。</span>
            </div>
          </div>

          <div>
            <h3 className="mb-1 text-xs font-medium text-tavern-dim">模板库（{list.length}）</h3>
            {list.length === 0 && !loading && <p className="rounded border border-dashed border-tavern-border p-2 text-xs text-tavern-dim">模板库为空。</p>}
            <ul aria-label="模板库列表" className="max-h-72 space-y-1.5 overflow-y-auto pr-1">
              {list.map((item) => (
                <li key={item.id}>
                  <button type="button" aria-label={"编辑模板 " + item.name} aria-pressed={editor?.id === item.id}
                    disabled={busy} onClick={() => void selectTemplate(item.id)}
                    className={"w-full rounded-lg border p-2 text-left disabled:opacity-60 " + (editor?.id === item.id ? "border-tavern-accent bg-tavern-raised" : "border-tavern-border hover:border-tavern-accent-dim")}>
                    <span className="block truncate text-sm text-tavern-text">{item.name}</span>
                    <span className="block truncate text-xs text-tavern-dim">{item.description || "无描述"}</span>
                    <span className="mt-1 flex flex-wrap gap-1 text-[11px] text-tavern-dim">
                      <span className={item.publishedHash ? "text-emerald-300" : "text-amber-300"}>{item.publishedHash ? `已发布 v${item.publishedVersion ?? "?"}` : "未发布"}</span>
                      <span>· {item.draftDirty ? "草稿有修改" : "草稿与发布一致"} · {item.versionCount} 个版本</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
          {loadingHint}
        </aside>

        <section className="min-w-0 space-y-3">
          {error && <p role="alert" className="break-words rounded-lg border border-red-400/40 bg-red-400/10 p-2.5 text-sm text-red-300">{error}</p>}
          {status && <p role="status" className="break-words rounded-lg border border-tavern-accent/40 bg-tavern-accent/10 p-2.5 text-sm text-tavern-accent">{status}</p>}
          {renderEditor()}
        </section>
      </div>
    </dialog>
  );
}
