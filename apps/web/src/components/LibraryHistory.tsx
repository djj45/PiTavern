import { useState } from 'react';
import type { LibraryDocumentDto, LibraryHistoryPageDto, LibraryHistoryPreviewDto } from '@pitavern/shared';
import { api } from '../api.ts';
import { buttonClass } from './libraryStyles.ts';
export function LibraryHistory({ document, dirty, busy, onBusy, onRestored }: {
  document: LibraryDocumentDto; dirty: boolean; busy: boolean; onBusy: (value: boolean) => void; onRestored: (value: LibraryDocumentDto) => void;
}) {
  const [page, setPage] = useState<LibraryHistoryPageDto | null>(null);
  const [preview, setPreview] = useState<LibraryHistoryPreviewDto | null>(null);
  const [accepted, setAccepted] = useState(false);
  const [error, setError] = useState('');
  const run = async (action: () => Promise<void>) => {
    onBusy(true); setError(''); try { await action(); } catch (cause) { setError((cause as Error).message); } finally { onBusy(false); }
  };
  const load = (before?: string) => run(async () => {
    const next = await api.libraryHistory(document.resource.id, before);
    setPage(before && page ? { ...next, items: [...page.items, ...next.items] } : next);
  });
  return <details className="rounded-lg border border-tavern-border p-3">
    <summary className="cursor-pointer">编辑历史与恢复</summary>
    <div className="mt-3 space-y-3">
      <button type="button" disabled={busy} onClick={() => void load()} className={buttonClass}>查看编辑历史</button>
      {page && !page.items.length && <p>暂无历史备份；首次保存已有文件后会生成。</p>}
      {page && <ul className="max-h-48 space-y-2 overflow-y-auto">{page.items.map((item) => <li key={item.id}>
        <button type="button" disabled={busy} className={buttonClass + ' max-w-full text-left'} onClick={() => void run(async () => {
          setPreview(await api.previewLibraryHistory(document.resource.id, item.id)); setAccepted(false);
        })}>{new Date(item.createdAt).toLocaleString()} · {(item.bytes / 1024).toFixed(1)} KiB · {item.revision.slice(0, 8)}</button>
      </li>)}</ul>}
      {page?.before && <button type="button" disabled={busy} onClick={() => void load(page.before!)} className={buttonClass}>加载更早版本</button>}
      {preview && <div className="space-y-3">
        <p>左侧是当前已保存内容，右侧是历史版本。恢复前会再次备份当前原文件。</p>
        <div className="grid min-w-0 gap-3 sm:grid-cols-2">
          <label>当前版本<pre aria-label="当前资料内容" className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded bg-tavern-bg p-2 text-xs">{JSON.stringify(document.data, null, 2)}</pre></label>
          <label>历史版本<pre aria-label="历史资料内容" className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded bg-tavern-bg p-2 text-xs">{JSON.stringify(preview.document.data, null, 2)}</pre></label>
        </div>
        {dirty && <p className="text-amber-400">请先保存或明确放弃当前草稿，再恢复历史版本。</p>}
        <label className="flex items-center gap-2"><input type="checkbox" checked={accepted} disabled={busy || dirty} onChange={(e) => setAccepted(e.target.checked)} />我已对比内容，确认恢复此版本</label>
        <button type="button" className={buttonClass} disabled={busy || dirty || !accepted} onClick={() => void run(async () => {
          const saved = await api.restoreLibraryHistory(document.resource.id, preview.backup.id, document.revision);
          setPreview(null); setAccepted(false); onRestored(saved); setPage(null);
        })}>恢复此历史版本</button>
      </div>}
      {error && <p role="alert" className="break-words text-red-400">{error}</p>}
    </div>
  </details>;
}
