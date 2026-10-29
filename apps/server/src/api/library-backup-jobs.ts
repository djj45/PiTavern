import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { Express } from 'express';
import type { Readable } from 'node:stream';
import type { LibraryBackupJobDto } from '@pitavern/shared';
import type { TavernConfig } from '../config.ts';
import type { SessionManager } from '../session/manager.ts';
import type { LibraryBackupStore, BackupOperation } from '../stdata/library-backup.ts';
import { portableSettings } from '../stdata/portable-config.ts';
interface Job {
  dto: LibraryBackupJobDto; controller: AbortController; release: () => void;
  started: boolean; timer?: ReturnType<typeof setTimeout>; archive?: string;
}
export const backupControlPath = (route: string): boolean => /^\/library-backup\/jobs(?:\/[a-f0-9-]{36}(?:\/(upload|cancel|download))?)?$/.test(route);

export function attachLibraryBackupJobs(app: Express, store: LibraryBackupStore, config: TavernConfig, sessions: SessionManager): void {
  const jobs = new Map<string, Job>();
  const get = (id: string): Job => { const job = jobs.get(id); if (!job) throw new Error('备份任务不存在或已过期'); return job; };
  const execute = async (job: Job, run: (op: BackupOperation) => Promise<void>) => {
    job.started = true; clearTimeout(job.timer);
    try {
      await run({ signal: job.controller.signal, update: (progress) => { job.dto.progress = progress; } });
      job.dto.state = 'succeeded'; job.dto.progress = { ...job.dto.progress, phase: 'done' };
    } catch (cause) {
      job.dto.state = job.controller.signal.aborted ? 'cancelled' : 'failed';
      job.dto.error = job.controller.signal.aborted ? '操作已取消；原资料库与连接设置保持不变' : (cause as Error).message;
    } finally { clearTimeout(job.timer); job.release(); }
  };
  app.post('/api/library-backup/jobs', (req, res) => {
    try {
      const { action, includeSettings, previewId, applySettings } = req.body ?? {};
      if (!['export', 'import', 'restore'].includes(action) || (includeSettings !== undefined && typeof includeSettings !== 'boolean') || (applySettings !== undefined && typeof applySettings !== 'boolean') || (action === 'restore' && typeof previewId !== 'string')) throw new Error('备份任务参数无效');
      // Only bounded in-memory task metadata expires; artifacts are never automatically removed.
      for (const [id, job] of jobs) if (jobs.size >= 30 && job.dto.state !== 'running') jobs.delete(id);
      if (jobs.size >= 30) throw new Error('备份任务过多');
      const release = sessions.beginMaintenance('正在处理资料库备份，可在备份面板查看进度或取消');
      const dto: LibraryBackupJobDto = { id: randomUUID(), action, state: 'running', progress: { phase: action === 'import' ? 'uploading' : action === 'restore' ? 'restoring' : 'collecting', files: 0, bytes: 0 } };
      const job: Job = { dto, controller: new AbortController(), release, started: false }; jobs.set(dto.id, job);
      res.status(202).json(dto);
      if (action === 'export') void execute(job, async (op) => { job.archive = await store.export(includeSettings ? portableSettings(config) : undefined, op); });
      else if (action === 'restore') void execute(job, async (op) => { dto.restored = await store.restore(previewId, config, !!applySettings, op); sessions.requireRestart(); });
      else { job.timer = setTimeout(() => { job.controller.abort(); dto.state = 'cancelled'; dto.error = '等待上传超时，请重试'; release(); }, 60000); job.timer.unref(); }
    } catch (cause) { res.status(409).json({ error: (cause as Error).message }); }
  });
  app.post('/api/library-backup/jobs/:id/upload', async (req, res) => {
    try {
      const job = get(String(req.params.id));
      if (job.dto.action !== 'import' || job.started || job.dto.state !== 'running') throw new Error('此任务不能接收上传');
      const abort = () => job.controller.abort(); req.once('aborted', abort);
      await execute(job, async (op) => { job.dto.preview = await store.preview(req as Readable, op); });
      req.removeListener('aborted', abort);
      if (!res.destroyed) res.json(job.dto);
    } catch (cause) { if (!res.headersSent && !res.destroyed) res.status(400).json({ error: (cause as Error).message }); }
  });
  app.get('/api/library-backup/jobs/:id', (req, res) => {
    try { res.json(get(String(req.params.id)).dto); } catch (cause) { res.status(404).json({ error: (cause as Error).message }); }
  });
  app.post('/api/library-backup/jobs/:id/cancel', (req, res) => {
    try {
      const job = get(String(req.params.id));
      if (job.dto.state !== 'running' || job.dto.progress.phase === 'committing') throw new Error('任务已结束或正在提交，不能再取消；请查看最终结果');
      job.controller.abort();
      if (!job.started) { clearTimeout(job.timer); job.dto.state = 'cancelled'; job.dto.error = '操作已取消'; job.release(); }
      res.json(job.dto);
    } catch (cause) { res.status(409).json({ error: (cause as Error).message }); }
  });
  app.get('/api/library-backup/jobs/:id/download', (req, res) => {
    try {
      const job = get(String(req.params.id));
      if (job.dto.state !== 'succeeded' || !job.archive) throw new Error('备份尚未完成');
      res.download(job.archive, path.basename(job.archive), { dotfiles: 'allow' }, (error) => { if (error && !res.headersSent) res.status(404).json({ error: '归档已移除或下载失败' }); });
    } catch (cause) { res.status(400).json({ error: (cause as Error).message }); }
  });
  app.get('/api/library-backup/storage', async (_req, res) => {
    try { res.json(await store.storage(!!sessions.writeBlocked)); } catch (cause) { res.status(400).json({ error: (cause as Error).message }); }
  });
  app.delete('/api/library-backup/storage', (req, res) => {
    try { sessions.assertIdle(); store.removeArtifact(req.body?.id, req.body?.confirmation); res.json({ ok: true }); }
    catch (cause) { res.status(409).json({ error: (cause as Error).message }); }
  });
}
