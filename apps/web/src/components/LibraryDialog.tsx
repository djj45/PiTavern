import { useEffect, useRef, useState } from "react";
import type { LibraryDocumentDto, LibraryResourceDto } from "@pitavern/shared";
import type { RegexScript } from "@pitavern/shared/regex";
import { api } from "../api.ts";
import { LibraryHistory } from "./LibraryHistory.tsx";
import { readLibraryDraft, writeLibraryDraft, removeLibraryDraft, type LibraryDraft } from "../libraryDrafts.ts";
import { RegexEditor } from "./RegexEditor.tsx";
import { LibraryBackupPanel } from "./LibraryBackupPanel.tsx";
import { fieldClass, buttonClass } from "./libraryStyles.ts";

type World = Record<string, unknown> & { entries: Record<string, Record<string, unknown>> };

function WorldEditor({ value, onChange }: { value: World; onChange: (world: World) => void }) {
  const [selected, setSelected] = useState(() => Object.keys(value.entries)[0] ?? "");
  const [query, setQuery] = useState("");
  const matches = Object.entries(value.entries).filter(([uid, item]) => !query.trim() || [uid, item.comment, item.content, ...(Array.isArray(item.key) ? item.key : [])].join(" ").toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const active = matches.some(([uid]) => uid === selected) ? selected : matches[0]?.[0] ?? "";
  const entry = value.entries[active];
  const update = (patch: Record<string, unknown>) => onChange({ ...value, entries: { ...value.entries, [active]: { ...entry, ...patch } } });
  const number = (key: string, label: string, fallback = 0, nullable = false) => <label key={key}>{label}<input type="number" step={1} aria-label={label} className={fieldClass}
    value={entry[key] == null ? (nullable ? "" : fallback) : Number(entry[key])} onChange={(e) => update({ [key]: e.target.value === "" && nullable ? null : Number(e.target.value) })} /></label>;
  const check = (key: string, label: string, fallback = false) => <label key={key} className="flex items-center gap-2"><input type="checkbox" checked={typeof entry[key] === "boolean" ? entry[key] as boolean : fallback} onChange={(e) => update({ [key]: e.target.checked })} />{label}</label>;
  const inherit = (key: string, label: string) => <label key={key}>{label}<select className={fieldClass} value={entry[key] == null ? "" : String(entry[key])}
    onChange={(e) => update({ [key]: e.target.value === "" ? null : e.target.value === "true" })}><option value="">跟随全局</option><option value="true">开启</option><option value="false">关闭</option></select></label>;
  const add = () => {
    let uid = 0; while (Object.hasOwn(value.entries, String(uid))) uid++;
    onChange({ ...value, entries: { ...value.entries, [uid]: { uid, key: [], keysecondary: [], comment: "新条目", content: "", order: 100, position: 0, disable: false } } });
    setQuery(""); setSelected(String(uid));
  };
  const remove = () => {
    const entries = { ...value.entries }; delete entries[active];
    onChange({ ...value, entries }); setSelected(Object.keys(entries)[0] ?? "");
  };
  const duplicate = () => {
    if (!entry) return;
    let uid = 0; while (Object.hasOwn(value.entries, String(uid))) uid++;
    onChange({ ...value, entries: { ...value.entries, [uid]: { ...structuredClone(entry), uid, comment: String(entry.comment || active) + "（副本）" } } });
    setQuery(""); setSelected(String(uid));
  };
  return <div className="space-y-4">
    <label className="block">搜索条目<input aria-label="搜索世界书条目" className={fieldClass} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="名称、关键词或正文" /></label>
    <p className="text-xs leading-5 text-tavern-dim">编辑外部世界书。启用范围、全局扫描和预算仍在设置中选择；卡内世界书暂不在此编辑。</p>
    <div className="flex flex-wrap items-end gap-2">
      <label className="min-w-0 flex-1">条目（{Object.keys(value.entries).length}）<select aria-label="世界书条目" value={active} onChange={(e) => setSelected(e.target.value)} className={fieldClass}>
        {!matches.length && <option value="">暂无匹配条目</option>}
        {matches.map(([uid, item]) => <option key={uid} value={uid}>{item.disable ? "⏸ " : ""}{String(item.comment || uid)}</option>)}
      </select></label>
      <button type="button" onClick={add} className={buttonClass}>新增条目</button>
      <button type="button" disabled={!entry} onClick={duplicate} className={buttonClass}>复制条目</button>
      <button type="button" disabled={!entry} onClick={remove} className={buttonClass}>删除条目</button>
    </div>
    {entry && <div className="space-y-4">
      <label className="block">名称／备注<input aria-label="条目备注" value={String(entry.comment ?? "")} onChange={(e) => update({ comment: e.target.value })} className={fieldClass} /></label>
      <div className="grid gap-3 sm:grid-cols-2">
        <label>主关键词（每行一个）<textarea rows={3} value={Array.isArray(entry.key) ? entry.key.join("\n") : ""} onChange={(e) => update({ key: e.target.value.split("\n") })} className={fieldClass} /></label>
        <label>辅助关键词（每行一个）<textarea rows={3} value={Array.isArray(entry.keysecondary) ? entry.keysecondary.join("\n") : ""} onChange={(e) => update({ keysecondary: e.target.value.split("\n") })} className={fieldClass} /></label>
      </div>
      <label className="block">条目内容<textarea aria-label="条目内容" rows={7} value={String(entry.content ?? "")} onChange={(e) => update({ content: e.target.value })} className={fieldClass} /></label>
      <div className="flex flex-wrap gap-4"><label className="flex items-center gap-2"><input type="checkbox" checked={entry.disable === true || entry.disabled === true} onChange={(e) => update({ disable: e.target.checked, ...(Object.hasOwn(entry, "disabled") ? { disabled: e.target.checked } : {}) })} />停用</label>{check("constant", "常驻")}{check("vectorized", "向量条目")}{check("selective", "使用辅助关键词", true)}</div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <label>注入位置<select className={fieldClass} value={Number(entry.position ?? 0)} onChange={(e) => update({ position: Number(e.target.value) })}>
          {["角色定义前", "角色定义后", "作者注释前", "作者注释后", "按聊天深度", "示例前", "示例后", "Outlet"].map((name, i) => <option key={i} value={i}>{name}</option>)}
        </select></label>
        {number("order", "排序", 100)}{number("depth", "注入深度", 4)}
        <label>消息角色<select className={fieldClass} value={String(entry.role ?? 0)} onChange={(e) => update({ role: Number(e.target.value) })}>
          <option value={0}>System</option><option value={1}>User</option><option value={2}>Assistant</option>
          {["system", "user", "assistant"].includes(String(entry.role)) && <option value={String(entry.role)}>{String(entry.role)}</option>}
        </select></label>
        <label>辅助逻辑<select className={fieldClass} value={Number(entry.selectiveLogic ?? 0)} onChange={(e) => update({ selectiveLogic: Number(e.target.value) })}>
          <option value={0}>任意命中</option><option value={1}>不全部命中</option><option value={2}>全部不命中</option><option value={3}>全部命中</option>
        </select></label>
        <label>Outlet 名称<input className={fieldClass} value={String(entry.outletName ?? "")} onChange={(e) => update({ outletName: e.target.value })} /></label>
      </div>
      <details className="rounded-lg border border-tavern-border p-3"><summary className="cursor-pointer">分组、概率与时序</summary>
        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
          <label>包含组（逗号分隔）<input className={fieldClass} value={String(entry.group ?? "")} onChange={(e) => update({ group: e.target.value })} /></label>
          {number("groupWeight", "组权重", 100)}{inherit("useGroupScoring", "组评分")}
          {number("probability", "激活概率 %", 100)}{number("sticky", "持续消息数")}{number("cooldown", "冷却消息数")}{number("delay", "延迟消息数")}
          {number("scanDepth", "扫描深度（空为全局）", 0, true)}
          <label>递归延迟<input type="number" min={0} step={1} className={fieldClass} value={(entry.delayUntilRecursion ?? entry.delayed) === true ? 1 : Number(entry.delayUntilRecursion ?? entry.delayed ?? 0)} onChange={(e) => update({ delayUntilRecursion: Number(e.target.value) || false })} /></label>
          {inherit("caseSensitive", "区分大小写")}{inherit("matchWholeWords", "完整词匹配")}
        </div>
        <div className="mt-4 flex flex-wrap gap-4">{check("groupOverride", "组内优先覆盖")}{check("useProbability", "启用概率", true)}{check("excludeRecursion", "不参与递归扫描")}{check("preventRecursion", "不触发后续递归")}</div>
      </details>
    </div>}
  </div>;
}

export default function LibraryDialog({ onClose, scope }: { onClose: () => void; scope: string }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [tab, setTab] = useState<"world" | "regex" | "backup">("world");
  const [resources, setResources] = useState<LibraryResourceDto[]>([]);
  const [document, setDocument] = useState<LibraryDocumentDto | null>(null);
  const [draft, setDraft] = useState<LibraryDocumentDto | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [localDraft, setLocalDraft] = useState<LibraryDraft | null>(null);
  const [draftError, setDraftError] = useState("");
  const dirty = !!draft && JSON.stringify(draft.data) !== JSON.stringify(document?.data);
  const clearDraft = (id: string) => { try { removeLibraryDraft(scope, id); setDraftError(""); } catch { setDraftError("无法移除浏览器本地草稿，请检查站点存储权限"); } };
  const discard = () => {
    if (!dirty) return true;
    if (!window.confirm("还有未保存的草稿，确定放弃并移除本地草稿吗？")) return false;
    if (draft) clearDraft(draft.resource.id);
    return true;
  };
  const change = (data: LibraryDocumentDto["data"]) => {
    if (!draft) return;
    const next = { ...draft, data }; setDraft(next);
    try { writeLibraryDraft(scope, next); setDraftError(""); }
    catch { setDraftError("本地草稿保存失败（存储不可用或空间不足），请及时保存资料或复制内容"); }
  };
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  const close = () => { if (!busy && discard()) onClose(); };
  useEffect(() => { dialog.current?.showModal(); void api.library().then(setResources).catch((e: Error) => setError(e.message)); }, []);
  const load = async (id: string) => {
    if (!discard()) return;
    setBusy(true); setError(""); setStatus("");
    try {
      const value = await api.libraryDocument(id); setDocument(value); setDraft(structuredClone(value)); setLocalDraft(null);
      try { const saved = readLibraryDraft(scope, id); if (saved && JSON.stringify(saved.document.data) !== JSON.stringify(value.data)) setLocalDraft(saved); }
      catch { setDraftError("本地草稿读取失败，可点击清除本地草稿后重试"); }
    }
    catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  };
  const save = async () => {
    if (!draft || busy) return;
    setBusy(true); setError(""); setStatus("");
    try {
      const saved = await api.saveLibraryDocument(draft);
      setDocument(saved); setDraft(structuredClone(saved)); clearDraft(saved.resource.id); setLocalDraft(null); setStatus("已保存，原文件已备份");
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  };
  const create = async () => {
    if (!discard()) return;
    setBusy(true); setError(""); setStatus("");
    try {
      const value = await api.createWorld(name);
      setResources(await api.library()); setDocument(value); setDraft(structuredClone(value)); setName(""); setLocalDraft(null); setStatus("世界书已创建；请添加条目并在设置中启用");
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  };
  return <dialog ref={dialog} aria-labelledby="library-title" onCancel={(event) => { event.preventDefault(); close(); }}
    className="m-auto max-h-[92dvh] w-[min(960px,96vw)] overflow-y-auto rounded-xl border border-tavern-border bg-tavern-panel p-0 text-tavern-text backdrop:bg-black/60">
    <div className="sticky top-0 z-10 flex flex-wrap items-center justify-between gap-2 border-b border-tavern-border bg-tavern-panel p-4">
      <h2 id="library-title" className="font-medium">资料库{dirty ? " · 未保存" : ""}</h2>
      <button type="button" disabled={busy} onClick={close} className={buttonClass}>关闭</button>
      <div role="tablist" aria-label="资料库功能" className="flex w-full flex-wrap gap-2">
        {([["world", "世界书"], ["regex", "正则脚本"], ["backup", "备份与迁移"]] as const).map(([id, label]) => <button key={id} type="button" role="tab" aria-selected={tab === id} disabled={busy}
          onClick={() => { if (tab !== id && discard()) { setTab(id); setDraft(null); setDocument(null); setLocalDraft(null); setError(""); setStatus(""); } }} className={buttonClass + (tab === id ? " border-tavern-accent text-tavern-accent" : "")}>{label}</button>)}
      </div>
    </div>
    <div className="space-y-4 p-4 text-sm">
      {tab === "backup" ? <LibraryBackupPanel onBusy={setBusy} /> : <>
        <fieldset disabled={busy} className="space-y-4 disabled:opacity-60">
          <label className="block">{tab === "world" ? "世界书文件" : "正则来源"}<select aria-label="资料文件" value={draft?.resource.id ?? ""} onChange={(e) => { if (e.target.value) void load(e.target.value); }} className={fieldClass}>
            <option value="">选择资料…</option>
            {resources.filter((r) => tab === "world" ? r.kind === "world" : r.kind !== "world").map((r) => <option key={r.id} value={r.id}>{r.kind === "preset-regex" ? "预设 · " : r.kind === "character-regex" ? "角色卡 · " : ""}{r.label}</option>)}
          </select></label>
          {tab === "world" && <div className="flex items-end gap-2"><label className="min-w-0 flex-1">新世界书名称<input value={name} onChange={(e) => setName(e.target.value)} className={fieldClass} /></label><button type="button" disabled={!name.trim()} onClick={() => void create()} className={buttonClass}>新建世界书</button></div>}
          {localDraft && <div role="status" className="space-y-2 rounded border border-tavern-accent p-3">
            <p>发现本地草稿（{new Date(localDraft.updatedAt).toLocaleString()}）。{localDraft.document.revision !== document?.revision ? "原文件已更新，恢复后仍需处理版本冲突。" : ""}</p>
            <button type="button" className={buttonClass} onClick={() => { setDraft(structuredClone(localDraft.document)); setLocalDraft(null); setStatus("已恢复本地草稿，尚未写入资料库"); }}>恢复本地草稿</button>
            <button type="button" className={buttonClass + " ml-2"} onClick={() => { clearDraft(localDraft.document.resource.id); setLocalDraft(null); }}>清除本地草稿</button>
          </div>}
          {draft && (tab === "world" ? <WorldEditor key={draft.resource.id + draft.revision} value={draft.data as World} onChange={change} />
            : <RegexEditor key={draft.resource.id + draft.revision} scripts={draft.data as RegexScript[]} onChange={change} />)}
        </fieldset>
        {document && <LibraryHistory key={document.resource.id + document.revision} document={document} dirty={dirty} busy={busy} onBusy={setBusy} onRestored={(value) => { setDocument(value); setDraft(structuredClone(value)); clearDraft(value.resource.id); setLocalDraft(null); setStatus("历史版本已恢复，恢复前原文件已备份"); }} />}
        {draftError && <div role="alert" className="text-amber-400">{draftError}{draft && <button type="button" className={buttonClass + " ml-2"} onClick={() => { clearDraft(draft.resource.id); setLocalDraft(null); }}>清除本地草稿</button>}</div>}
        {draft && <div className="flex flex-wrap gap-3 border-t border-tavern-border pt-4">
          <button type="button" onClick={() => void save()} disabled={busy || !dirty} className="rounded-lg bg-tavern-accent px-4 py-2 text-tavern-bg disabled:opacity-40">{busy ? "处理中…" : "保存资料"}</button>
          <button type="button" disabled={busy} onClick={() => void load(draft.resource.id)} className={buttonClass}>重新载入</button>
          <p className="w-full text-xs text-tavern-dim">生成期间请先停止所有聊天。保存会保留未知字段；冲突时草稿保留，重新载入会丢弃草稿。</p>
        </div>}
      </>}
      {status && <p role="status" className="text-tavern-accent">{status}</p>}
      {error && <p role="alert" className="break-words text-red-400">{error}</p>}
    </div>
  </dialog>;
}
