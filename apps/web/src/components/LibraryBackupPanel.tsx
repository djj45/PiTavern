import { useEffect, useRef, useState } from 'react';
import type { LibraryBackupJobDto, LibraryBackupPreviewDto } from '@pitavern/shared';
import { api } from '../api.ts';
import { buttonClass } from './libraryStyles.ts';
import { LibraryBackupStorage } from './LibraryBackupStorage.tsx';
const size = (bytes: number) => (bytes / 1024 / 1024).toFixed(2) + ' MiB';
const labels: Record<string, string> = { characters: '角色卡', chats: '聊天', worlds: '世界书', 'OpenAI Settings': '预设', skills: 'Skills', '.pitavern': '活动、备份与全局正则' };
const phases = { collecting: '扫描文件', compressing: '压缩归档', uploading: '上传归档', validating: '完整校验', restoring: '恢复文件', committing: '提交目录设置', done: '完成' };

export function LibraryBackupPanel({ onBusy }: { onBusy: (busy: boolean) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<LibraryBackupPreviewDto | null>(null);
  const [busy, setBusy] = useState(''), [error, setError] = useState(''), [status, setStatus] = useState('');
  const [accepted, setAccepted] = useState(false), [includeSettings, setIncludeSettings] = useState(false), [applySettings, setApplySettings] = useState(false);
  const [restored, setRestored] = useState<{ stDataDir: string; previousDataDir: string } | null>(null);
  const [job, setJob] = useState<LibraryBackupJobDto | null>(null);
  const [uploadBytes, setUploadBytes] = useState<{ loaded: number; total: number } | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const previewId = useRef<string | null>(null), watch = useRef<AbortController | null>(null);
  const storageKey = 'PiTavern.backup.job';
  const remember = (id?: string) => { try { if (id) sessionStorage.setItem(storageKey, id); else sessionStorage.removeItem(storageKey); } catch { /* Resuming after refresh is optional when browser storage is blocked. */ } };
  const start = (message: string) => { setBusy(message); onBusy(true); setError(''); setStatus(''); setCancelling(false); };
  const finish = () => { setBusy(''); onBusy(false); setCancelling(false); };
  const follow = async (initial: LibraryBackupJobDto, signal: AbortSignal): Promise<LibraryBackupJobDto> => {
    let current = initial, failures = 0; setJob(current);
    while (current.state === 'running') {
      await new Promise((resolve) => setTimeout(resolve, 200)); signal.throwIfAborted();
      try { current = await api.libraryBackupJob(current.id, signal); failures = 0; setJob(current); }
      catch (cause) { if (signal.aborted || ++failures >= 3) throw cause; }
    }
    return current;
  };
  const completed = (result: LibraryBackupJobDto) => {
    if (result.state === 'failed') { remember(); throw new Error(result.error || '备份操作失败'); }
    if (result.state === 'cancelled') { remember(); setStatus(result.error || '操作已取消'); return; }
    if (result.preview) { setPreview(result.preview); previewId.current = result.preview.id; setAccepted(false); setApplySettings(false); }
    else if (result.restored) { setRestored(result.restored); previewId.current = null; remember(); }
    else {
      remember(); const anchor = document.createElement('a'); anchor.href = '/api/library-backup/jobs/' + encodeURIComponent(result.id) + '/download'; anchor.download = ''; anchor.click();
      setStatus('备份已生成，正在下载；服务器归档保留在备份工作目录');
    }
  };
  const resume = async (id: string) => {
    start('正在查询备份任务…'); watch.current?.abort(); const controller = new AbortController(); watch.current = controller;
    try { completed(await follow(await api.libraryBackupJob(id, controller.signal), controller.signal)); }
    catch (cause) { if (!controller.signal.aborted) setError((cause as Error).message + '；可重新查询任务状态'); }
    finally { if (!controller.signal.aborted) finish(); }
  };
  useEffect(() => {
    let remembered: string | null = null; try { remembered = sessionStorage.getItem(storageKey); } catch { /* optional */ }
    if (remembered) void resume(remembered);
    return () => {
      watch.current?.abort();
      if (previewId.current) { void api.discardLibraryBackup(previewId.current).catch(() => {}); remember(); }
    };
  }, []);
  const run = async (action: 'export' | 'import' | 'restore', file?: File) => {
    if (file && file.size > 512 * 1024 * 1024) { setError('压缩归档不能超过 512 MiB'); return; }
    start(action === 'export' ? '正在导出备份…' : action === 'import' ? '正在上传并完整校验备份…' : '正在恢复到新目录…');
    watch.current?.abort(); const controller = new AbortController(); watch.current = controller; setUploadBytes(null);
    try {
      if (action === 'import' && previewId.current) { await api.discardLibraryBackup(previewId.current); previewId.current = null; }
      if (action === 'import') { setPreview(null); setAccepted(false); }
      const next = await api.startLibraryBackupJob({ action, includeSettings, previewId: preview?.id, applySettings });
      remember(next.id); setJob(next);
      const uploading = file ? api.uploadLibraryBackupJob(next.id, file, (loaded) => setUploadBytes({ loaded, total: file.size })).catch(async () => {
        // The status endpoint remains available even if cancellation closes the upload socket.
        await api.cancelLibraryBackupJob(next.id).catch(() => {});
      }) : Promise.resolve();
      const result = await follow(next, controller.signal); await uploading;
      if (!controller.signal.aborted) completed(result);
    } catch (cause) { if (!controller.signal.aborted) setError((cause as Error).message); }
    finally { if (!controller.signal.aborted) { finish(); if (input.current) input.current.value = ''; } }
  };
  const cancel = async () => {
    if (!job) return; setCancelling(true);
    try { await api.cancelLibraryBackupJob(job.id); }
    catch (cause) { setError((cause as Error).message); }
    finally { setCancelling(false); }
  };
  const progress = job?.progress;
  return <div className="space-y-4">
    <p className="leading-6 text-tavern-dim">归档包含角色卡、聊天、世界书、预设、Skills、全局正则、生成活动和历史备份。向量缓存会自动重建；连接地址、API 密钥与默认模型始终留在本机。</p>
    <p className="text-xs leading-5 text-tavern-dim">导出或导入前请先停止全部生成。归档上限 512 MiB；单文件上限 32 MiB，展开总计上限 2 GiB。归档含完整私人聊天，请妥善保管。</p>
    <fieldset disabled={!!busy || !!restored} className="space-y-3 disabled:opacity-50">
      <label className="flex items-center gap-2"><input type="checkbox" checked={includeSettings} onChange={(e) => setIncludeSettings(e.target.checked)} />导出时附带便携应用设置（不含连接和密钥）</label>
      <p className="text-xs leading-5 text-tavern-dim">可携带 persona、上下文模式、启用的世界书与预设、扫描预算、输出协议、压缩及接管设置。向量连接、模型和路径保持目标机器原值。</p>
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" onClick={() => void run('export')} className={buttonClass}>导出整库备份</button>
        <label className={buttonClass + ' cursor-pointer'}>选择备份并预览<input aria-label="选择整库备份" ref={input} type="file" accept=".gz,.pitavern.gz,application/gzip" className="mt-2 block max-w-full text-xs" onChange={(e) => { const file = e.target.files?.[0]; if (file) void run('import', file); }} /></label>
      </div>
    </fieldset>
    {busy && <div role="status" className="space-y-2 rounded border border-tavern-border p-3 text-tavern-accent">
      <p>{busy}{progress ? ' · ' + phases[progress.phase] : ''}</p>
      {progress && <p className="text-xs">已处理 {progress.files}{progress.totalFiles != null ? ' / ' + progress.totalFiles : ''} 个文件 · {size(progress.bytes)}{progress.totalBytes != null ? ' / ' + size(progress.totalBytes) : ''}</p>}
      {uploadBytes && progress?.phase === 'uploading' && <><progress aria-label="归档上传进度" max={uploadBytes.total || 1} value={uploadBytes.loaded} className="w-full" /><p className="text-xs">已上传 {size(uploadBytes.loaded)} / {size(uploadBytes.total)}</p></>}
      {progress?.totalFiles != null && <progress aria-label="归档处理进度" max={progress.totalFiles || 1} value={progress.files} className="w-full" />}
      {job?.state === 'running' && <button type="button" disabled={cancelling || progress?.phase === 'committing'} onClick={() => void cancel()} className={buttonClass}>{progress?.phase === 'committing' ? '正在提交，不能取消' : cancelling ? '正在取消…' : '取消当前任务'}</button>}
    </div>}
    {!busy && job?.state === 'running' && <button type="button" onClick={() => void resume(job.id)} className={buttonClass}>重新查询任务状态</button>}
    {preview && !restored && <div className="space-y-4 rounded-lg border border-tavern-border p-4">
      <h3 className="font-medium">备份预览</h3>
      <p>创建于 {new Date(preview.createdAt).toLocaleString()} · {preview.files} 个文件 · 展开 {size(preview.bytes)}</p>
      <ul className="space-y-1 text-tavern-dim">{Object.entries(preview.counts).map(([name, count]) => <li key={name}>{labels[name] ?? name}：{count} 个文件</li>)}</ul>
      {preview.settings ? <div className="space-y-2">
        <details><summary className="cursor-pointer">查看归档中的便携设置</summary><pre aria-label="便携设置预览" className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded bg-tavern-bg p-2 text-xs">{JSON.stringify(preview.settings, null, 2)}</pre></details>
        <label className="flex items-center gap-2"><input type="checkbox" checked={applySettings} disabled={!!busy} onChange={(e) => setApplySettings(e.target.checked)} />同时应用归档中的便携设置</label>
      </div> : <p className="text-xs text-tavern-dim">归档不含便携设置，恢复时保持本机应用设置。</p>}
      <p className="leading-6">恢复会创建同级新目录并切换数据目录设置，当前资料库会完整保留。完成后必须重启服务；{applySettings ? '仅应用预览中的便携设置，本机连接与密钥保留。' : '本机连接与其他设置保持当前值。'}</p>
      <label className="flex items-start gap-2"><input type="checkbox" disabled={!!busy} checked={accepted} onChange={(e) => setAccepted(e.target.checked)} className="mt-1" />我已核对预览，恢复完成后会重启服务</label>
      <button type="button" disabled={!!busy || !accepted} onClick={() => void run('restore')} className="rounded-lg bg-tavern-accent px-4 py-2 text-tavern-bg disabled:opacity-40">恢复到新目录</button>
      <button type="button" disabled={!!busy} onClick={() => {
        start('正在取消预览…'); void api.discardLibraryBackup(preview.id).then(() => { setPreview(null); previewId.current = null; setAccepted(false); remember(); }).catch((cause: Error) => setError(cause.message)).finally(finish);
      }} className={buttonClass + ' ml-3'}>取消预览</button>
    </div>}
    {restored && <div role="status" className="space-y-2 break-all rounded-lg border border-tavern-accent p-4">
      <p className="font-medium text-tavern-accent">恢复完成，请重启 PiTavern 服务后继续。</p>
      <p>新目录：{restored.stDataDir}</p><p>旧目录（回退保留）：{restored.previousDataDir}</p>
      <p className="text-xs leading-5 text-tavern-dim">回退时，在停止服务后将 data/config.json 的 stDataDir 改回旧目录。使用自定义 PITAVERN_CONFIG 时请修改对应配置文件。</p>
    </div>}
    {!restored && <LibraryBackupStorage disabled={!!busy} />}
    {status && <p role="status" className="text-tavern-accent">{status}</p>}
    {error && <p role="alert" className="break-words text-red-400">{error}</p>}
  </div>;
}
