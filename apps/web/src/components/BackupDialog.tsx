import { useEffect, useRef, useState } from "react";
import type { ChatBackupDto, ChatBackupPreviewDto } from "@pitavern/shared";
import { api } from "../api.ts";

export function BackupDialog({ chatId, busy, onClose, onRestored }: {
  chatId: string; busy: boolean; onClose: () => void; onRestored: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [backups, setBackups] = useState<ChatBackupDto[]>([]);
  const [before, setBefore] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [preview, setPreview] = useState<ChatBackupPreviewDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [previewing, setPreviewing] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [previewVersion, setPreviewVersion] = useState(0);
  const [error, setError] = useState("");
  useEffect(() => { dialog.current?.showModal(); }, []);
  useEffect(() => {
    let active = true;
    api.backups(chatId).then((result) => {
      if (!active) return;
      setBackups(result.backups); setBefore(result.before); setSelected(result.backups[0]?.id ?? null);
    }).catch((e: Error) => { if (active) setError(e.message); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [chatId]);
  useEffect(() => {
    let active = true;
    setPreview(null);
    if (!selected) return;
    setPreviewing(true); setError("");
    api.previewBackup(chatId, selected).then((result) => { if (active) setPreview(result); })
      .catch((e: Error) => { if (active) setError(e.message); })
      .finally(() => { if (active) setPreviewing(false); });
    return () => { active = false; };
  }, [chatId, selected, previewVersion]);
  const more = async () => {
    if (!before || loading) return;
    setLoading(true);
    try { const result = await api.backups(chatId, before); setBackups((old) => [...old, ...result.backups]); setBefore(result.before); }
    catch (e) { setError((e as Error).message); }
    finally { setLoading(false); }
  };
  const restore = async () => {
    if (!preview || busy || restoring) return;
    setRestoring(true); setError("");
    try { await api.restoreBackup(chatId, preview.backup.id, preview.revision); onRestored(); onClose(); }
    catch (e) { setError((e as Error).message); }
    finally { setRestoring(false); }
  };
  return <dialog ref={dialog} aria-labelledby="backup-title" onCancel={(event) => { event.preventDefault(); if (!restoring) onClose(); }}
    className="m-auto w-[min(900px,94vw)] max-h-[90vh] rounded-xl border border-tavern-border bg-tavern-panel p-0 text-tavern-text backdrop:bg-black/60">
    <div className="flex items-center justify-between border-b border-tavern-border p-4">
      <h2 id="backup-title" className="font-medium">聊天备份</h2>
      <button onClick={onClose} disabled={restoring} aria-label="关闭备份" className="rounded px-3 py-1 disabled:opacity-40">关闭</button>
    </div>
    <div className="flex max-h-[60vh] min-h-64 flex-col sm:flex-row">
      <div className="max-h-40 overflow-y-auto border-b border-tavern-border p-3 sm:max-h-none sm:w-60 sm:shrink-0 sm:border-r sm:border-b-0">
        {!loading && !backups.length && <p className="text-sm text-tavern-dim">暂无备份。编辑、切换候选或重新生成回复后会自动保留备份。</p>}
        {backups.map((backup) => <button key={backup.id} disabled={restoring} onClick={() => setSelected(backup.id)}
          aria-pressed={selected === backup.id} className={"mb-1 w-full rounded p-2 text-left text-xs " + (selected === backup.id ? "bg-tavern-accent/20" : "hover:bg-tavern-raised")}>
          <span className="block">{new Date(backup.createdAt).toLocaleString("zh-CN")}</span>
          <span className="text-tavern-dim">{(backup.bytes / 1024).toFixed(1)} KB</span>
        </button>)}
        {loading && <p className="text-xs text-tavern-dim">加载中…</p>}
        {before && <button disabled={loading || restoring} onClick={() => void more()} className="p-2 text-xs text-tavern-accent">加载更早备份</button>}
      </div>
      <div className="min-w-0 flex-1 overflow-y-auto p-4">
        {previewing && <p className="text-sm text-tavern-dim">读取预览…</p>}
        {preview && <>
          <p className="mb-3 text-xs text-tavern-dim">共 {preview.total} 条消息，预览最近 {preview.messages.length} 条；每条最多显示 2000 字符。</p>
          {preview.messages.map((message) => <div key={message.id} className="mb-3 rounded-lg bg-tavern-raised p-3">
            <p className="mb-1 text-xs text-tavern-accent">{message.name}</p>
            <p className="whitespace-pre-wrap break-words text-sm">{message.text.slice(0, 2000)}{message.text.length > 2000 ? "…" : ""}</p>
          </div>)}
        </>}
      </div>
    </div>
    <div className="border-t border-tavern-border p-4">
      {error && <p role="alert" className="mb-2 text-sm text-red-400">{error}</p>}
      <p className="mb-3 text-xs text-tavern-dim">恢复将替换整份聊天及其状态。恢复前会再次备份当前存档，方便撤回。</p>
      <button disabled={!selected || previewing || restoring} onClick={() => setPreviewVersion((value) => value + 1)}
        className="mr-3 rounded-lg border border-tavern-border px-4 py-2 text-sm disabled:opacity-40">刷新预览</button>
      <button disabled={!preview || previewing || busy || restoring} onClick={() => void restore()}
        className="rounded-lg bg-tavern-accent px-4 py-2 text-sm text-tavern-bg disabled:opacity-40">{restoring ? "恢复中…" : "恢复此备份"}</button>
    </div>
  </dialog>;
}
