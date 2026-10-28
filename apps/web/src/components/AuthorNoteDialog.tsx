import { useEffect, useRef, useState } from "react";
import type { AuthorNoteDto, AuthorNoteSnapshotDto } from "@pitavern/shared";
import { api } from "../api.ts";

export function AuthorNoteDialog({ chatId, busy, onClose }: { chatId: string; busy: boolean; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [snapshot, setSnapshot] = useState<AuthorNoteSnapshotDto | null>(null);
  const [draft, setDraft] = useState<AuthorNoteDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [reload, setReload] = useState(0);
  const [error, setError] = useState("");
  useEffect(() => { dialog.current?.showModal(); }, []);
  useEffect(() => {
    let active = true;
    setLoading(true); setError("");
    api.authorNote(chatId).then((data) => { if (active) { setSnapshot(data); setDraft(data.note); } })
      .catch((cause: Error) => { if (active) setError(cause.message); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [chatId, reload]);
  const save = async () => {
    if (!draft || !snapshot || busy || saving || loading) return;
    setSaving(true); setError("");
    try { await api.saveAuthorNote(chatId, draft, snapshot.revision); onClose(); }
    catch (cause) { setError((cause as Error).message); }
    finally { setSaving(false); }
  };
  const fieldClass = "mt-1 w-full rounded-lg border border-tavern-border bg-tavern-bg px-3 py-2 text-tavern-text";
  return <dialog ref={dialog} aria-labelledby="author-note-title" onCancel={(event) => { event.preventDefault(); if (!saving) onClose(); }}
    className="m-auto max-h-[90vh] w-[min(640px,94vw)] overflow-y-auto rounded-xl border border-tavern-border bg-tavern-panel p-0 text-tavern-text backdrop:bg-black/60">
    <form onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <div className="flex items-center justify-between border-b border-tavern-border p-4">
        <h2 id="author-note-title" className="font-medium">作者注释</h2>
        <button type="button" onClick={onClose} disabled={saving} className="rounded px-3 py-1 disabled:opacity-40">关闭</button>
      </div>
      <div className="space-y-4 p-4 text-sm">
        <p className="text-xs leading-5 text-tavern-dim">注释保存到当前聊天，参与 ST 桥接模式的上下文组装。支持角色、变量和 Outlet 宏。</p>
        {snapshot && snapshot.contextMode !== "bridge" && <p className="text-xs text-amber-300">当前不是 ST 桥接模式；保存后需在设置中切换到 ST 桥接模式才会注入。</p>}
        {loading && <p className="text-tavern-dim">读取作者注释…</p>}
        {draft && <fieldset disabled={loading || saving || busy} className="space-y-4 disabled:opacity-60">
          <label className="block">注释内容<textarea aria-label="作者注释内容" rows={7} maxLength={100000} value={draft.text}
            onChange={(event) => setDraft({ ...draft, text: event.target.value })} className={fieldClass + " resize-y"} /></label>
          <div className="grid grid-cols-2 gap-3">
            <label>每隔几轮注入<input aria-label="注释间隔" type="number" min={0} max={1000} step={1} required value={draft.interval}
              onChange={(event) => setDraft({ ...draft, interval: Number(event.target.value) })} className={fieldClass} /></label>
            <label>消息深度<input aria-label="注释深度" type="number" min={0} max={1000} step={1} required value={draft.depth} disabled={draft.position !== 1}
              onChange={(event) => setDraft({ ...draft, depth: Number(event.target.value) })} className={fieldClass + " disabled:opacity-40"} /></label>
            <label>插入位置<select aria-label="注释位置" value={draft.position} onChange={(event) => setDraft({ ...draft, position: Number(event.target.value) as AuthorNoteDto["position"] })} className={fieldClass}>
              <option value={1}>按聊天深度</option><option value={0}>故事之后</option><option value={2}>故事之前</option>
            </select></label>
            <label>消息角色<select aria-label="注释角色" value={draft.role} onChange={(event) => setDraft({ ...draft, role: event.target.value as AuthorNoteDto["role"] })} className={fieldClass}>
              <option value="system">System</option><option value="user">User</option><option value="assistant">Assistant</option>
            </select></label>
          </div>
          <p className="text-xs leading-5 text-tavern-dim">间隔 0 为关闭，1 为每轮。深度 0 为最新消息之后，1 为最新消息之前；System 消息仍会由模型适配层合并到系统提示词。</p>
        </fieldset>}
        {busy && <p className="text-xs text-tavern-dim">生成期间不能保存注释。</p>}
        {error && <p role="alert" className="text-sm text-red-400">{error}</p>}
      </div>
      <div className="flex flex-wrap items-center gap-3 border-t border-tavern-border p-4">
        <button type="submit" disabled={!draft || !snapshot || loading || saving || busy} className="rounded-lg bg-tavern-accent px-4 py-2 text-sm text-tavern-bg disabled:opacity-40">{saving ? "保存中…" : "保存作者注释"}</button>
        <button type="button" disabled={loading || saving} onClick={() => setReload((value) => value + 1)}
          className="rounded-lg border border-tavern-border px-3 py-2 text-sm disabled:opacity-40">重新载入（丢弃草稿）</button>
        <p className="w-full text-xs text-tavern-dim">保存前自动备份；其他窗口修改过聊天时会保留草稿并提示冲突。</p>
      </div>
    </form>
  </dialog>;
}
