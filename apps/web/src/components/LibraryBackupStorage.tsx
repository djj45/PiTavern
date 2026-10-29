import { useState } from 'react';
import type { LibraryBackupStorageDto } from '@pitavern/shared';
import { api } from '../api.ts';
import { buttonClass, fieldClass } from './libraryStyles.ts';
const size = (bytes: number) => (bytes / 1024 / 1024).toFixed(2) + ' MiB';
export function LibraryBackupStorage({ disabled }: { disabled: boolean }) {
  const [storage, setStorage] = useState<LibraryBackupStorageDto | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [selected, setSelected] = useState(''), [confirmation, setConfirmation] = useState('');
  const load = async () => { setBusy(true); setError(''); try { setStorage(await api.libraryBackupStorage()); } catch (cause) { setError((cause as Error).message); } finally { setBusy(false); } };
  return <details className="rounded-lg border border-tavern-border p-3">
    <summary className="cursor-pointer">备份磁盘占用与管理</summary>
    <div className="mt-3 space-y-3">
      <p className="text-xs leading-5 text-tavern-dim">导出、导入校验和取消后的文件均保留，不自动清理。此处只管理归档工作目录；不会移除当前或恢复前的资料库。</p>
      <button type="button" disabled={disabled || busy} className={buttonClass} onClick={() => void load()}>{busy ? '统计中…' : '刷新备份占用'}</button>
      {storage && <>
        <p className="break-all text-xs">目录：{storage.directory}</p>
        <p>总计 {size(storage.bytes)} · {storage.files} 个文件 · {storage.items.length} 项</p>
        <ul className="max-h-80 space-y-3 overflow-y-auto">{storage.items.map((item) => <li key={item.id} className="space-y-1 rounded border border-tavern-border p-2">
          <p className="break-all text-xs">{item.id}</p>
          <p className="text-xs text-tavern-dim">{item.kind === 'archive' ? '完整导出' : item.kind === 'import' ? '导入与校验产物' : '未完成导出'} · {size(item.bytes)} · {item.files} 个文件 · {new Date(item.modifiedAt).toLocaleString()}</p>
          <button type="button" className={buttonClass} disabled={disabled || busy || item.inUse} onClick={() => { setSelected(item.id); setConfirmation(''); }}>{item.inUse ? '预览或任务占用中' : '移除归档'}</button>
        </li>)}</ul>
      </>}
      {selected && <div className="space-y-2 rounded border border-red-500/40 p-3">
        <p className="break-all">将永久移除 {selected}。请输入完整名称确认，先自行保存需要的备份。</p>
        <input aria-label="确认移除归档名称" value={confirmation} onChange={(e) => setConfirmation(e.target.value)} className={fieldClass} />
        <button type="button" className={buttonClass} disabled={disabled || busy || confirmation !== selected} onClick={() => {
          setBusy(true); setError(''); void api.removeLibraryBackupArtifact(selected, confirmation).then(async () => {
            setSelected(''); setConfirmation(''); setStorage(await api.libraryBackupStorage());
          }).catch((cause: Error) => setError(cause.message)).finally(() => setBusy(false));
        }}>永久移除此归档</button>
        <button type="button" disabled={busy} className={buttonClass + ' ml-2'} onClick={() => setSelected('')}>取消移除</button>
      </div>}
      {error && <p role="alert" className="break-words text-red-400">{error}</p>}
    </div>
  </details>;
}
