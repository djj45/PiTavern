import { useEffect, useRef, useState } from "react";
import type { BranchPointDto } from "@pitavern/shared";

export interface BranchDialogProps {
  points: BranchPointDto[];
  busy: boolean;
  /** 切换分支；返回是否成功（成功后由调用方关闭/刷新） */
  onSelect: (userMessageId: string, index: number) => Promise<boolean>;
  /** 用可选的方向要求重新生成最后一条回复 */
  onRegenerate: (instruction: string) => void;
  /** 最后一条消息是否是可重新生成的助手回复 */
  canRegenerate: boolean;
  onClose: () => void;
}

export function BranchDialog({ points, busy, onSelect, onRegenerate, canRegenerate, onClose }: BranchDialogProps) {
  const [instruction, setInstruction] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const pendingRef = useRef<string | null>(null);
  const ordered = [...points].sort((a, b) => b.turn - a.turn);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const choose = async (point: BranchPointDto, index: number) => {
    if (busy || pendingRef.current !== null || index === point.selected) return;
    const key = `${point.userMessageId}:${index}`;
    pendingRef.current = key;
    setPending(key);
    try {
      const switched = await onSelect(point.userMessageId, index);
      if (switched) onClose();
    } catch {
      // 失败时由调用方显示 notice，这里保持弹窗并恢复候选按钮。
    } finally {
      pendingRef.current = null;
      setPending(null);
    }
  };

  const regenerate = () => {
    onRegenerate(instruction.trim());
    onClose();
  };

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-label="分支选择" aria-busy={busy || pending !== null}
        onClick={(event) => event.stopPropagation()}
        className="max-h-[85vh] w-full max-w-3xl overflow-y-auto rounded-xl border border-tavern-border bg-tavern-panel p-5 text-tavern-text shadow-2xl">
        <div className="mb-4 flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-medium">剧情分支</h2>
            <p className="mt-1 text-xs leading-5 text-tavern-dim">切换候选会保留各分支已生成的后续剧情；切到没有后续的分支后可以直接继续发言。</p>
          </div>
          <button type="button" onClick={onClose} aria-label="关闭分支选择"
            className="shrink-0 rounded-lg border border-tavern-border px-3 py-1.5 text-sm hover:bg-tavern-raised">关闭</button>
        </div>

        {!ordered.length ? (
          <p className="rounded-lg border border-dashed border-tavern-border bg-tavern-bg/50 px-4 py-8 text-center text-sm leading-6 text-tavern-dim">
            还没有分支。重新生成回复后，旧回复会保留为可切换的候选。
          </p>
        ) : (
          <ol className="space-y-4">
            {ordered.map((point) => (
              <li key={point.userMessageId} className="rounded-xl border border-tavern-border bg-tavern-bg/40 p-4">
                <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
                  <h3 className="min-w-0 break-words text-sm font-medium">
                    第 {point.turn} 轮 · <span className="font-normal text-tavern-dim">{point.userPreview}</span>
                  </h3>
                  <span className="shrink-0 text-xs text-tavern-dim">{point.count} 个候选</span>
                </div>
                <div className="grid gap-2 sm:grid-cols-2">
                  {point.candidates.map((candidate) => {
                    const selected = candidate.index === point.selected;
                    const switching = pending === `${point.userMessageId}:${candidate.index}`;
                    const disabled = busy || pending !== null || selected;
                    return (
                      <button key={candidate.index} type="button" disabled={disabled} aria-pressed={selected}
                        aria-busy={switching || undefined} onClick={() => void choose(point, candidate.index)}
                        className={"flex min-w-0 flex-col gap-2 rounded-lg border p-3 text-left text-sm transition-colors " + (selected
                          ? "border-tavern-accent bg-tavern-accent/10"
                          : "border-tavern-border bg-tavern-panel hover:border-tavern-accent-dim hover:bg-tavern-raised disabled:cursor-not-allowed disabled:opacity-50")}>
                        <span className="flex flex-wrap items-center gap-2">
                          <span className="flex h-6 min-w-6 items-center justify-center rounded-full border border-tavern-border bg-tavern-bg px-1.5 text-xs text-tavern-dim">{candidate.index + 1}</span>
                          {selected && <span className="rounded-full bg-tavern-accent px-2 py-0.5 text-[11px] font-medium text-tavern-bg">当前</span>}
                          {candidate.hasContinuation && <span className="rounded-full border border-tavern-border px-2 py-0.5 text-[11px] text-tavern-dim">有后续</span>}
                          {switching && <span className="text-[11px] text-tavern-accent">切换中…</span>}
                        </span>
                        <span className="line-clamp-2 whitespace-pre-wrap break-words leading-5 text-tavern-text">
                          {candidate.preview || "（空回复）"}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </li>
            ))}
          </ol>
        )}

        <div className="mt-5 border-t border-tavern-border pt-4">
          <label htmlFor="branch-regenerate-instruction" className="block text-sm font-medium">换条路线（可选）</label>
          <textarea id="branch-regenerate-instruction" rows={2} value={instruction} onChange={(event) => setInstruction(event.target.value)}
            placeholder="例如：让主角拒绝邀请，改走夜探路线"
            className="mt-2 w-full resize-y rounded-lg border border-tavern-border bg-tavern-bg px-3 py-2 text-sm text-tavern-text placeholder:text-tavern-dim focus:border-tavern-accent focus:outline-none" />
          <div className="mt-2 flex flex-wrap items-center gap-3">
            <button type="button" disabled={busy || !canRegenerate} onClick={regenerate}
              className="rounded-lg bg-tavern-accent px-4 py-2 text-sm font-medium text-tavern-bg disabled:cursor-not-allowed disabled:opacity-40">
              按此方向重新生成
            </button>
            <p className="text-xs text-tavern-dim">只影响本次生成，不会写进聊天记录</p>
          </div>
          {!canRegenerate && <p className="mt-2 text-xs text-tavern-dim">最后一条不是可重新生成的回复</p>}
        </div>
      </div>
    </div>
  );
}
