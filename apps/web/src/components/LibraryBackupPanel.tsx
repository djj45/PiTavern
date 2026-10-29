import { useEffect, useRef, useState } from "react";
import type { LibraryBackupPreviewDto } from "@pitavern/shared";
import { api } from "../api.ts";
import { buttonClass } from "./libraryStyles.ts";

const size = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
const labels: Record<string, string> = { characters: "角色卡", chats: "聊天", worlds: "世界书", "OpenAI Settings": "预设", skills: "Skills", ".pitavern": "活动、备份与全局正则" };

export function LibraryBackupPanel({ onBusy }: { onBusy: (busy: boolean) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<LibraryBackupPreviewDto | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [accepted, setAccepted] = useState(false);
  const [restored, setRestored] = useState<{ stDataDir: string; previousDataDir: string } | null>(null);
  const previewId = useRef<string | null>(null);
  useEffect(() => () => { if (previewId.current) void api.discardLibraryBackup(previewId.current).catch(() => {}); }, []);
  const start = (message: string) => { setBusy(message); onBusy(true); setError(""); };
  const finish = () => { setBusy(""); onBusy(false); };
  const download = async () => {
    start("正在导出备份…");
    try {
      const blob = await api.exportLibraryBackup();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a"); anchor.href = url; anchor.download = `PiTavern-${new Date().toISOString().replace(/[:.]/g, "-")}.pitavern.gz`; anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (cause) { setError((cause as Error).message); }
    finally { finish(); }
  };
  const upload = async (file: File) => {
    setPreview(null); setAccepted(false);
    if (file.size > 512 * 1024 * 1024) { setError("压缩归档不能超过 512 MiB"); return; }
    start("正在上传并完整校验备份…");
    try {
      if (previewId.current) { await api.discardLibraryBackup(previewId.current); previewId.current = null; }
      const next = await api.previewLibraryBackup(file); previewId.current = next.id; setPreview(next);
    }
    catch (cause) { setError((cause as Error).message); }
    finally { finish(); if (input.current) input.current.value = ""; }
  };
  const restore = async () => {
    if (!preview || !accepted) return;
    start("正在恢复到新目录…");
    try { setRestored(await api.restoreLibraryBackup(preview.id)); previewId.current = null; }
    catch (cause) { setError((cause as Error).message); }
    finally { finish(); }
  };
  return <div className="space-y-4">
    <p className="leading-6 text-tavern-dim">归档包含角色卡、聊天、世界书、预设、Skills、全局正则、生成活动和历史备份。向量缓存会自动重建；连接、API 密钥与应用设置不在归档内。</p>
    <p className="text-xs leading-5 text-tavern-dim">导出或导入前请先停止全部生成。归档上限 512 MiB；单文件上限 32 MiB，展开总计上限 2 GiB。归档含完整私人聊天，请妥善保管。</p>
    <fieldset disabled={!!busy || !!restored} className="flex flex-wrap items-center gap-3 disabled:opacity-50">
      <button type="button" onClick={() => void download()} className={buttonClass}>导出整库备份</button>
      <label className={buttonClass + " cursor-pointer"}>选择备份并预览<input ref={input} type="file" accept=".gz,.pitavern.gz,application/gzip" className="mt-2 block max-w-full text-xs" onChange={(e) => { const file = e.target.files?.[0]; if (file) void upload(file); }} /></label>
    </fieldset>
    {busy && <p role="status" className="text-tavern-accent">{busy}</p>}
    {preview && !restored && <div className="space-y-4 rounded-lg border border-tavern-border p-4">
      <h3 className="font-medium">备份预览</h3>
      <p>创建于 {new Date(preview.createdAt).toLocaleString()} · {preview.files} 个文件 · 展开 {size(preview.bytes)}</p>
      <ul className="space-y-1 text-tavern-dim">{Object.entries(preview.counts).map(([name, count]) => <li key={name}>{labels[name] ?? name}：{count} 个文件</li>)}</ul>
      <p className="leading-6">恢复会创建同级新目录并切换数据目录设置，当前资料库会完整保留。完成后必须重启服务；本机连接与其他设置保持当前值。</p>
      <label className="flex items-start gap-2"><input type="checkbox" disabled={!!busy} checked={accepted} onChange={(e) => setAccepted(e.target.checked)} className="mt-1" />我已核对预览，恢复完成后会重启服务</label>
      <button type="button" disabled={!!busy || !accepted} onClick={() => void restore()} className="rounded-lg bg-tavern-accent px-4 py-2 text-tavern-bg disabled:opacity-40">恢复到新目录</button>
      <button type="button" disabled={!!busy} onClick={() => {
        start("正在取消预览…");
        void api.discardLibraryBackup(preview.id).then(() => { setPreview(null); previewId.current = null; setAccepted(false); }).catch((cause: Error) => setError(cause.message)).finally(finish);
      }} className={buttonClass + " ml-3"}>取消预览</button>
    </div>}
    {restored && <div role="status" className="space-y-2 break-all rounded-lg border border-tavern-accent p-4">
      <p className="font-medium text-tavern-accent">恢复完成，请重启 PiTavern 服务后继续。</p>
      <p>新目录：{restored.stDataDir}</p><p>旧目录（回退保留）：{restored.previousDataDir}</p>
      <p className="text-xs leading-5 text-tavern-dim">回退时，在停止服务后将 data/config.json 的 stDataDir 改回旧目录。使用自定义 PITAVERN_CONFIG 时请修改对应配置文件。</p>
    </div>}
    {error && <p role="alert" className="break-words text-red-400">{error}</p>}
  </div>;
}
