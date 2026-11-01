import { useEffect, useRef, useState, type FormEvent } from "react";
import type { CharacterDto, ChatImportIssueDto, ChatImportPreviewDto, ChatImportResultDto } from "@pitavern/shared";
import { ApiError, api } from "../api.ts";

const MAX_BYTES = 32 * 1024 * 1024;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
}

function issueLocation(issue: ChatImportIssueDto): string {
  if (issue.line) return issue.path ? `第 ${issue.line} 行 · ${issue.path}` : `第 ${issue.line} 行`;
  return issue.path ? `文件级 · ${issue.path}` : "文件级";
}

interface ErrorDetails {
  issues: ChatImportIssueDto[];
  duplicate?: { chatId: string; title: string };
}

function errorDetails(error: unknown): ErrorDetails {
  if (!(error instanceof ApiError)) return { issues: [] };
  const body = error.body as {
    errors?: ChatImportIssueDto[];
    issues?: ChatImportIssueDto[];
    issueCount?: number;
    preview?: ChatImportPreviewDto;
    duplicate?: { chatId?: string; title?: string };
  } | null;
  // 预览内联 errors 与导入 422 的 issues 都要按行号展示。
  const issues = Array.isArray(body?.issues) ? body.issues
    : Array.isArray(body?.errors) ? body.errors
      : body?.preview?.errors ?? [];
  const duplicate = body?.duplicate && typeof body.duplicate.title === "string"
    ? { chatId: typeof body.duplicate.chatId === "string" ? body.duplicate.chatId : "", title: body.duplicate.title }
    : undefined;
  return { issues, duplicate };
}

interface ImportChatDialogProps {
  characters: CharacterDto[];
  onClose: () => void;
  onImported: (result: ChatImportResultDto) => void | Promise<void>;
}

/** 单个聊天 JSONL 导入：选择文件 → 只读预览 → 确认角色/标题 → 导入并打开。 */
export function ImportChatDialog({ characters, onClose, onImported }: ImportChatDialogProps) {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<ChatImportPreviewDto | null>(null);
  const [character, setCharacter] = useState("");
  const [title, setTitle] = useState("");
  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState("");
  const [importError, setImportError] = useState<unknown>(null);
  const sequence = useRef(0);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || importing) return;
      event.preventDefault();
      onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [importing, onClose]);

  const handleFile = async (next: File | undefined) => {
    if (!next) return;
    const request = ++sequence.current;
    setFile(next);
    setPreview(null);
    setCharacter("");
    setTitle("");
    setError("");
    setImportError(null);
    setImporting(false);
    if (next.size > MAX_BYTES) {
      setError(`文件超过 32 MiB 上限（${formatBytes(next.size)}），无法导入`);
      return;
    }
    setLoading(true);
    try {
      const result = await api.previewChatImport(next);
      if (request !== sequence.current) return;
      setPreview(result);
      setCharacter(result.suggestedCharacter && characters.some((card) => card.name === result.suggestedCharacter)
        ? result.suggestedCharacter
        : "");
      setTitle((result.suggestedTitle || next.name.replace(/\.(jsonl|json|txt)$/i, "")).slice(0, 100));
    } catch (cause) {
      if (request !== sequence.current) return;
      setError((cause as Error).message || "读取预览失败");
      setImportError(cause);
    } finally {
      if (request === sequence.current) setLoading(false);
    }
  };

  const reasons = importError ? errorDetails(importError) : null;
  const issues = reasons?.issues.length ? reasons.issues : preview?.errors ?? [];
  const duplicate = preview?.duplicate ?? reasons?.duplicate;
  const canImport = !!file && !!preview && preview.valid && !duplicate && !!character
    && title.trim().length > 0 && !loading && !importing;

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!file || !preview || !canImport) return;
    setImporting(true);
    setError("");
    setImportError(null);
    try {
      const result = await api.importChat(file, { character, sha256: preview.sha256, title: title.trim() });
      await onImported(result);
      onClose();
    } catch (cause) {
      setError((cause as Error).message || "导入失败");
      setImportError(cause);
    } finally {
      setImporting(false);
    }
  };

  const counts = preview ? [
    ["消息", preview.messages],
    ["用户", preview.userMessages],
    ["助手", preview.assistantMessages],
    ["系统", preview.systemMessages],
    ["候选/隐藏消息", preview.hiddenMessages],
    ["分叉点", preview.branchPoints],
    ["候选", preview.candidates],
    ["隐藏 continuation", preview.hiddenContinuations],
    ["隐藏分支", preview.hiddenBranches],
  ] as const : [];

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/60 p-4"
      onPointerDown={(event) => { if (event.target === event.currentTarget && !importing) onClose(); }}>
      <form role="dialog" aria-modal="true" aria-label="导入聊天" onSubmit={(event) => void submit(event)}
        className="flex max-h-[90dvh] w-full max-w-2xl flex-col overflow-y-auto rounded-xl border border-tavern-border bg-tavern-panel p-4 text-tavern-text shadow-2xl sm:p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-base font-medium">导入聊天</h2>
            <p className="mt-1 text-xs leading-5 text-tavern-dim">选择 PiTavern / SillyTavern 导出的单个聊天 JSONL；校验通过后可关联已有角色卡并打开。</p>
          </div>
          <button type="button" aria-label="关闭导入聊天" disabled={importing} onClick={onClose}
            className="shrink-0 rounded-md px-2 py-1 text-tavern-dim hover:bg-tavern-raised hover:text-tavern-text disabled:opacity-40">✕</button>
        </div>

        <p className="mt-3 rounded-lg bg-tavern-bg p-2 text-xs leading-5 text-tavern-dim">
          单个聊天文件不包含角色卡、独立生成记录和供应商配置。需要完整迁移请使用「资料 → 备份与迁移」整库归档。
        </p>

        <label className="mt-3 block min-w-0 cursor-pointer rounded-lg border border-dashed border-tavern-border bg-tavern-bg p-3">
          <span className="block text-sm font-medium">选择聊天 JSONL 文件</span>
          <span className="mt-0.5 block text-xs text-tavern-dim">接受 .jsonl / .json / 纯文本；按内容校验，上限 32 MiB。</span>
          <input ref={fileInput} type="file" aria-label="选择聊天 JSONL 文件" disabled={importing}
            accept=".jsonl,.json,.txt,text/plain,application/json"
            onChange={(event) => {
              const next = event.target.files?.[0];
              event.target.value = "";
              if (next) void handleFile(next);
            }}
            className="mt-2 block w-full min-w-0 max-w-full text-xs text-tavern-dim file:mr-2 file:rounded file:border file:border-tavern-border file:bg-tavern-raised file:px-2 file:py-1 file:text-tavern-text" />
        </label>

        {loading && <p role="status" className="mt-3 text-sm text-tavern-accent">正在解析并校验文件…</p>}
        {error && <p role="alert" className="mt-3 break-words rounded border border-red-500/40 bg-red-500/10 p-2 text-sm text-red-300">{error}</p>}

        {preview && (
          <div className="mt-3 space-y-3">
            <section aria-label="文件预览" className="rounded-lg border border-tavern-border p-3">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <h3 className="text-sm font-medium">文件预览</h3>
                <span className={`rounded px-1.5 py-0.5 text-xs ${duplicate ? "bg-amber-500/15 text-amber-300" : preview.valid ? "bg-emerald-500/15 text-emerald-300" : "bg-red-500/15 text-red-300"}`}>
                  {duplicate ? "重复文件，不能导入" : preview.valid ? "校验通过" : "校验未通过，不能导入"}
                </span>
              </div>
              <p className="mt-2 break-all text-sm">{preview.fileName} · {formatBytes(preview.bytes)}（{preview.bytes} 字节） · {preview.lines} 行 · {preview.messages} 条消息</p>
              <dl className="mt-2 grid grid-cols-2 gap-1.5 text-xs sm:grid-cols-3">
                {counts.map(([label, value]) => (
                  <div key={label} className="min-w-0 rounded bg-tavern-bg px-2 py-1.5">
                    <dt className="text-tavern-dim">{label}</dt>
                    <dd className="truncate text-tavern-text">{value}</dd>
                  </div>
                ))}
              </dl>
              <p className="mt-2 break-words text-xs leading-5 text-tavern-dim">
                聊天角色：{preview.detectedCharacter ?? "未检测到"}；建议关联：{preview.suggestedCharacter ?? "无"}；参与角色：
                {[...preview.userNames, ...preview.assistantNames].join("、") || "（无）"}
              </p>
              {preview.group && (
                <p className="mt-1 break-words text-xs leading-5 text-tavern-dim">
                  群聊：{preview.group.name} · 成员：{preview.group.members.join("、") || "（无）"}
                  {preview.group.missingMembers.length > 0 && <span className="text-amber-300"> · 缺少角色卡：{preview.group.missingMembers.join("、")}</span>}
                </p>
              )}
              {preview.world && (
                <div aria-label="世界状态预览" className="mt-2 rounded bg-tavern-bg p-2 text-xs leading-5">
                  <p>世界状态：快照 {preview.world.snapshots} 个 · 模板 {preview.world.templates} 个 · {preview.world.capability === "read-only" ? "只读" : "模板有效（运行时仍受模型与工具设置影响）"}</p>
                  {preview.world.templateNames.length > 0 && <p className="break-words text-tavern-dim">模板：{preview.world.templateNames.join("、")}</p>}
                  {preview.world.capability === "read-only" && <p className="break-words text-amber-300">只读原因：{preview.world.reason ?? "模板缺失、版本或规则不兼容"}</p>}
                </div>
              )}
            </section>

            {duplicate && (
              <div role="alert" className="rounded border border-amber-500/40 bg-amber-500/10 p-2 text-sm text-amber-200">
                该文件已导入过：《{duplicate.title}》。为避免覆盖已有聊天，不能重复导入。
              </div>
            )}

            {issues.length > 0 && (
              <section aria-label="校验错误" className="rounded border border-red-500/40 bg-red-500/10 p-2">
                <h3 className="text-sm font-medium text-red-300">校验错误</h3>
                <ul className="mt-1 space-y-1 text-xs leading-5 text-red-200">
                  {issues.map((issue, index) => (
                    <li key={index} className="break-words"><span className="font-medium">{issueLocation(issue)}</span>：{issue.message}</li>
                  ))}
                </ul>
                {preview.issueCount > issues.length && <p className="mt-1 text-xs text-red-300">另有 {preview.issueCount - issues.length} 条错误未显示。</p>}
              </section>
            )}

            {preview.warnings.length > 0 && (
              <section aria-label="导入警告" className="rounded border border-amber-500/30 bg-amber-500/5 p-2">
                <h3 className="text-sm font-medium text-amber-300">警告</h3>
                <ul className="mt-1 list-disc space-y-1 pl-4 text-xs leading-5 text-amber-100">
                  {preview.warnings.map((warning, index) => <li key={index} className="break-words">{warning}</li>)}
                </ul>
              </section>
            )}

            {!preview.characterKnown && preview.detectedCharacter && (
              <p className="text-xs leading-5 text-amber-300">原聊天角色「{preview.detectedCharacter}」不在资料库中；请选择任意已有角色卡关联，原文发言者会保持不变。</p>
            )}
            {characters.length === 0 && <p className="text-xs leading-5 text-red-300">资料库里还没有角色卡，无法关联导入。</p>}

            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block min-w-0 text-xs text-tavern-dim">关联角色
                <select aria-label="关联角色" value={character} disabled={importing || characters.length === 0}
                  onChange={(event) => setCharacter(event.target.value)}
                  className="mt-1 w-full rounded-lg border border-tavern-border bg-tavern-bg px-3 py-2 text-sm text-tavern-text disabled:opacity-50">
                  <option value="">请选择已有角色卡</option>
                  {characters.map((card) => <option key={card.name} value={card.name}>{card.name}</option>)}
                </select>
              </label>
              <label className="block min-w-0 text-xs text-tavern-dim">聊天标题
                <input aria-label="聊天标题" value={title} maxLength={100} disabled={importing}
                  onChange={(event) => setTitle(event.target.value)}
                  className="mt-1 w-full rounded-lg border border-tavern-border bg-tavern-bg px-3 py-2 text-sm text-tavern-text disabled:opacity-50" />
              </label>
            </div>
          </div>
        )}

        <div className="mt-4 flex flex-col-reverse gap-2 border-t border-tavern-border pt-3 sm:flex-row sm:justify-end">
          <button type="button" disabled={importing} onClick={onClose}
            className="rounded-lg border border-tavern-border px-4 py-2 text-sm hover:bg-tavern-raised disabled:opacity-40">取消</button>
          <button type="submit" disabled={!canImport}
            className="rounded-lg bg-tavern-accent px-4 py-2 text-sm font-medium text-tavern-bg disabled:cursor-not-allowed disabled:opacity-40">
            {importing ? "导入中…" : "导入并打开"}
          </button>
        </div>
      </form>
    </div>
  );
}
