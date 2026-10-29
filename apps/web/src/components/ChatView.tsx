import { lazy, memo, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { ChatDisplayDto, ChatMessageDto } from "@pitavern/shared";
import { RegexPlacement } from "@pitavern/shared/regex";
import { displayMessage } from "../messageDisplay.ts";
import { isToolItem, TOOL_META, toolArgPreview, type ChatItem, type ToolItem } from "../chatItems.ts";

import { chatExportUrl } from "../api.ts";
import type { ChatState } from "../chatState.ts";
import { VirtualRow } from "./VirtualRow.tsx";
import { BackupDialog } from "./BackupDialog.tsx";
import { AuthorNoteDialog } from "./AuthorNoteDialog.tsx";
const MarkdownContent = lazy(() => import("./MessageContent.tsx").then(({ MessageContent }) => ({ default: MessageContent })));
const MessageContent = memo(function MessageContent({ text, placement, depth, display }: {
  text: string; placement: number; depth: number; display?: ChatDisplayDto;
}) {
  const rendered = useMemo(() => displayMessage(text, placement, depth, display), [text, placement, depth, display]);
  return <Suspense fallback={<div className="whitespace-pre-wrap break-words">{rendered}</div>}><MarkdownContent text={rendered} /></Suspense>;
});

function CharacterAvatar({ src, name }: { src: string; name: string }) {
  const [failed, setFailed] = useState(false);
  return failed ? <span role="img" aria-label={name + "头像"}
    className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-tavern-accent/20 text-sm text-tavern-accent">{Array.from(name)[0]}</span>
    : <img src={src} alt="" onError={() => setFailed(true)} className="h-9 w-9 shrink-0 rounded-full object-cover" />;
}

interface ChatViewProps {
  chat: ChatState | null;
  personaName: string;
  streamingText: string | null;
  onSend: (text: string) => boolean;
  onStop: () => void;
  onEdit: (messageId: string, text: string, expectedText: string) => Promise<boolean>;
  onRegenerate: () => void;
  onSelectReply: (selected: number) => Promise<void>;
  onLoadOlder: () => Promise<boolean>;
  loadingOlder: boolean;
  onRestored: () => void;
  disabled: boolean;
  maintenance?: boolean;
  connected: boolean;
}

function MessageBubble({ message, avatarUrl, onEdit, busy, onPin, depth, display }: {
  message: ChatMessageDto; avatarUrl?: string; onEdit: ChatViewProps["onEdit"]; busy: boolean; onPin: (value: boolean) => void;
  depth: number; display?: ChatDisplayDto;
}) {
  const isUser = message.role === "user";
  const [thinkOpen, setThinkOpen] = useState(false);
  const [draft, setDraft] = useState<{ text: string; original: string } | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => onPin(Boolean(draft) || thinkOpen), [Boolean(draft), thinkOpen, onPin]);
  const save = async () => {
    if (!draft || saving || busy || !draft.text.trim()) return;
    setSaving(true);
    try { if (await onEdit(message.id, draft.text, draft.original)) setDraft(null); }
    finally { setSaving(false); }
  };
  return (
    <div className={`flex gap-3 ${isUser ? "flex-row-reverse" : ""}`}>
      {!isUser && avatarUrl && <CharacterAvatar key={avatarUrl} src={avatarUrl} name={message.name} />}
      <div className={`flex min-w-0 max-w-[90%] flex-col sm:max-w-[80%] ${isUser ? "items-end" : "items-start"}`}>
        <span className="mb-1 px-1 text-xs text-tavern-dim">{message.name}</span>
        {message.thinking && (
          <div className="mb-1 w-full">
            <button
              type="button"
              onClick={() => setThinkOpen((v) => !v)}
              className="rounded-full border border-tavern-border px-2.5 py-0.5 text-xs text-tavern-dim hover:border-tavern-accent-dim"
            >
              💭 思考过程 {thinkOpen ? "▲" : "▼"}
            </button>
            {thinkOpen && (
              <div className="mt-1 whitespace-pre-wrap rounded-lg border border-tavern-border bg-tavern-bg/60 px-3 py-2 text-xs leading-5 text-tavern-dim">
                <MessageContent text={message.thinking} placement={RegexPlacement.REASONING} depth={depth} display={display} />
              </div>
            )}
          </div>
        )}
        {draft ? (
          <div className="w-full min-w-0 rounded-xl border border-tavern-accent-dim bg-tavern-raised p-3">
            <textarea aria-label="编辑消息内容" value={draft.text} disabled={saving || busy}
              onChange={(event) => setDraft({ ...draft, text: event.target.value })}
              onKeyDown={(event) => {
                if (event.key === "Escape" && !saving) setDraft(null);
                if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !event.nativeEvent.isComposing) { event.preventDefault(); void save(); }
              }}
              rows={Math.min(12, Math.max(4, draft.text.split("\n").length))}
              className="w-full min-w-0 resize-y rounded border border-tavern-border bg-tavern-bg p-2 text-sm sm:min-w-80" />
            <p className="my-2 text-xs text-tavern-dim">只修改本条，后续对话保留；旧状态投影和世界书计时缓存会清除。</p>
            <div className="flex gap-2 text-xs">
              <button type="button" onClick={() => void save()} disabled={saving || busy || !draft.text.trim()}
                className="rounded bg-tavern-accent px-3 py-1.5 text-tavern-bg disabled:opacity-40">{saving ? "保存中…" : "保存修改"}</button>
              <button type="button" onClick={() => setDraft(null)} disabled={saving}
                className="rounded border border-tavern-border px-3 py-1.5">取消</button>
            </div>
          </div>
        ) : (
          <div className={"min-w-0 w-full rounded-2xl px-4 py-2.5 text-[15px] leading-relaxed " +
            (isUser ? "bg-tavern-accent/20 text-tavern-text" : "bg-tavern-raised text-tavern-text")}>
            <MessageContent text={message.text} placement={isUser ? RegexPlacement.USER_INPUT : RegexPlacement.AI_OUTPUT} depth={depth} display={display} />
          </div>
        )}
        {!draft && <button type="button" aria-label={"编辑" + message.name + "的消息"} disabled={busy}
          onClick={() => setDraft({ text: message.text, original: message.text })}
          className="mt-1 rounded px-2 py-1 text-xs text-tavern-dim hover:text-tavern-text disabled:opacity-40">编辑</button>}
      </div>
    </div>
  );
}

function ToolCard({ item, onPin }: { item: ToolItem; onPin: (value: boolean) => void }) {
  const [open, setOpen] = useState(false);
  useEffect(() => onPin(open), [open, onPin]);
  const meta = TOOL_META[item.toolName] ?? { icon: "🔧", label: item.toolName };
  const refused = item.status === "done" && item.summary?.startsWith("被拒");
  return (
    <div className="flex justify-center">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`flex max-w-[85%] items-center gap-2 rounded-full border px-3 py-1 text-xs ${
          item.status === "error"
            ? "border-red-500/50 text-red-300"
            : refused
              ? "border-amber-500/40 text-amber-300"
              : "border-tavern-border text-tavern-dim hover:border-tavern-accent-dim"
        }`}
      >
        <span>{meta.icon}</span>
        <span>{meta.label}</span>
        {toolArgPreview(item.toolName, item.args) && (
          <span className="max-w-64 truncate text-tavern-dim/80">{toolArgPreview(item.toolName, item.args)}</span>
        )}
        <span>·</span>
        {item.status === "running" ? (
          <span className="animate-pulse">调用中…</span>
        ) : (
          <span className={item.summary ? "" : "opacity-60"}>{item.summary ?? (item.status === "error" ? "失败" : "完成")}</span>
        )}
        {item.durationMs != null && item.status !== "running" && (
          <span className="text-tavern-dim/60">{item.durationMs}ms</span>
        )}
        <span className="text-tavern-dim/50">{open ? "▲" : "▼"}</span>
      </button>
      {open && (
        <div className="mt-1 w-full max-w-[85%] rounded-lg border border-tavern-border bg-tavern-bg/60 p-2 text-left text-xs text-tavern-dim">
          <pre className="overflow-x-auto whitespace-pre-wrap break-all">{JSON.stringify(item.args, null, 2)}</pre>
        </div>
      )}
    </div>
  );
}

const History = memo(function History({ items, avatarUrl, onEdit, busy, scrollRoot, display, streamingOffset = 0 }: {
  items: ChatItem[]; avatarUrl: string; onEdit: ChatViewProps["onEdit"]; busy: boolean; scrollRoot: RefObject<HTMLDivElement | null>;
  display?: ChatDisplayDto; streamingOffset?: number;
}) {
  const depths = new Map<string, number>();
  let depth = streamingOffset;
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index];
    if (!isToolItem(item)) depths.set(item.id, depth++);
  }
  return <>{items.map((item, index) => <VirtualRow key={isToolItem(item) ? item.key : item.id} root={scrollRoot} initialVisible={index >= items.length - 8}>
    {(onPin) => isToolItem(item) ? <ToolCard item={item} onPin={onPin} />
      : <MessageBubble message={item} avatarUrl={avatarUrl} onEdit={onEdit} busy={busy} onPin={onPin} depth={depths.get(item.id)!} display={display} />}
  </VirtualRow>)}</>;
});

export function ChatView({ chat, personaName, streamingText, onSend, onStop, onEdit, onRegenerate,
  onSelectReply, onLoadOlder, loadingOlder, onRestored, disabled, maintenance = false, connected }: ChatViewProps) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const input = chat ? drafts[chat.id] ?? "" : "";
  const setInput = (value: string) => {
    if (chat) setDrafts((previous) => ({ ...previous, [chat.id]: value }));
  };
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollRoot = useRef<HTMLDivElement>(null);
  const contents = useRef<HTMLDivElement>(null);
  const [backupsFor, setBackupsFor] = useState<string | null>(null);
  const [noteFor, setNoteFor] = useState<string | null>(null);
  const [switching, setSwitching] = useState(false);
  const followRef = useRef(true);
  const isStreaming = streamingText !== null;
  const locked = isStreaming || switching || !connected || maintenance;
  const lastRun = chat?.activity?.records[0];
  const toolItems = useMemo<ToolItem[]>(() => lastRun?.tools.map((tool) => ({ ...tool, kind: "tool" })) ?? [], [lastRun]);

  useEffect(() => {
    const node = contents.current;
    if (!node) return;
    const observer = new ResizeObserver(() => {
      if (followRef.current) bottomRef.current?.scrollIntoView({ behavior: "auto" });
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [chat?.id]);

  useLayoutEffect(() => {
    followRef.current = true;
    bottomRef.current?.scrollIntoView({ behavior: "auto" });
  }, [chat?.id]);
  useLayoutEffect(() => {
    if (followRef.current) bottomRef.current?.scrollIntoView({ behavior: "auto" });
  }, [chat?.items.length, streamingText]);

  const loadOlder = async () => {
    if (!scrollRoot.current || loadingOlder) return;
    followRef.current = false;
    const node = scrollRoot.current;
    const first = node.querySelector("[data-chat-row]");
    const top = first?.getBoundingClientRect().top;
    if (await onLoadOlder()) requestAnimationFrame(() => {
      if (first?.isConnected && top !== undefined) node.scrollTop += first.getBoundingClientRect().top - top;
    });
  };
  const chooseReply = async (index: number) => {
    setSwitching(true);
    try { await onSelectReply(index); } finally { setSwitching(false); }
  };

  if (!chat) {
    return (
      <main className="flex flex-1 items-center justify-center text-tavern-dim">
        <div className="text-center">
          <div className="mb-3 text-5xl">🍺</div>
          <p>从左侧选择对话，或开始新对话</p>
          {disabled && <p className="mt-2 text-xs">还没有配置模型连接，请先到「设置」里添加中转/API</p>}
        </div>
      </main>
    );
  }

  const avatarUrl = `/api/characters/${encodeURIComponent(chat.character)}/avatar`;
  const submit = () => {
    const text = input.trim();
    if (!text || locked || disabled) return;
    if (onSend(text)) setInput("");
  };

  return (
    <main className="flex min-w-0 flex-1 flex-col">
      <div className="flex min-h-9 flex-wrap shrink-0 items-center gap-2 border-b border-tavern-border bg-tavern-panel px-4 text-xs text-tavern-dim">
        <span className="truncate font-medium text-tavern-text">{chat.character}</span>
        <span>· {chat.page?.total ?? chat.items.filter((i) => !isToolItem(i)).length} 条消息</span>
        <span className="ml-auto flex items-center gap-2">
          <button onClick={() => setNoteFor(chat.id)} disabled={locked}
            className="rounded border border-tavern-border px-1.5 py-0.5 disabled:opacity-40">作者注释</button>
          <button onClick={() => setBackupsFor(chat.id)} disabled={locked}
            className="rounded border border-tavern-border px-1.5 py-0.5 disabled:opacity-40">备份与恢复</button>
          <a
            href={chatExportUrl(chat.id, "md")}
            className="rounded border border-tavern-border px-1.5 py-0.5 hover:border-tavern-accent-dim hover:text-tavern-text"
          >
            导出 MD
          </a>
          <a
            href={chatExportUrl(chat.id, "jsonl")}
            className="rounded border border-tavern-border px-1.5 py-0.5 hover:border-tavern-accent-dim hover:text-tavern-text"
          >
            JSONL
          </a>
        </span>
      </div>
      <div ref={scrollRoot} data-chat-scroll className="flex-1 overflow-y-auto px-6 py-4" onScroll={(event) => {
        const element = event.currentTarget;
        followRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
      }}>
        <div ref={contents} className="mx-auto flex max-w-3xl flex-col gap-4">
          {chat.page?.before != null && <button type="button" onClick={() => void loadOlder()} disabled={loadingOlder || locked}
            className="self-center rounded border border-tavern-border px-3 py-2 text-xs text-tavern-dim disabled:opacity-40">{loadingOlder ? "加载中…" : "加载更早的消息"}</button>}
          <History key={chat.id} items={chat.items} avatarUrl={avatarUrl} onEdit={onEdit} busy={locked} scrollRoot={scrollRoot}
            display={chat.display} streamingOffset={streamingText ? 1 : 0} />
          {toolItems.length > 0 && <section aria-label="最近一次生成的工具活动" className="flex flex-col gap-3">
            <p className="text-center text-xs text-tavern-dim">最近一次生成的工具活动 · 完整记录见活动面板</p>
            <History items={toolItems} avatarUrl={avatarUrl} onEdit={onEdit} busy={locked} scrollRoot={scrollRoot} />
          </section>}
          {isStreaming && (
            <div className="flex gap-3">
              <CharacterAvatar key={avatarUrl} src={avatarUrl} name={chat.character} />
              <div className="flex min-w-0 max-w-[90%] flex-col sm:max-w-[80%]">
                <span className="mb-1 px-1 text-xs text-tavern-dim">{chat.character}</span>
                <div className="min-w-0 w-full rounded-2xl bg-tavern-raised px-4 py-2.5 text-[15px] leading-relaxed">
                  <MessageContent text={streamingText ?? ""} placement={RegexPlacement.AI_OUTPUT} depth={0} display={chat.display} />
                  <span className="ml-0.5 inline-block h-4 w-2 animate-pulse bg-tavern-accent align-middle" />
                </div>
              </div>
            </div>
          )}
          <div ref={bottomRef} />
        </div>
      </div>

      <div className="shrink-0 border-t border-tavern-border bg-tavern-panel p-4">
        {(chat.replyChoices || chat.items.some((item) => !isToolItem(item) && item.role === "user")) && <div className="mx-auto mb-2 flex max-w-3xl flex-wrap items-center gap-2 text-xs">
          <button type="button" onClick={onRegenerate} disabled={locked || disabled}
            className="shrink-0 rounded border border-tavern-border px-2.5 py-1.5 text-tavern-dim hover:text-tavern-text disabled:opacity-40">{chat.replyChoices?.count === 0 ? "重试本轮" : "重新生成回复"}</button>
          {chat.replyChoices && chat.replyChoices.count > 1 && <span className="flex items-center gap-2">
            <button aria-label="上一个候选回复" disabled={locked || chat.replyChoices.selected === 0} onClick={() => void chooseReply(chat.replyChoices!.selected - 1)}
              className="rounded border border-tavern-border px-2 py-1 disabled:opacity-40">←</button>
            <span>候选 {chat.replyChoices.selected + 1} / {chat.replyChoices.count}</span>
            <button aria-label="下一个候选回复" disabled={locked || chat.replyChoices.selected === chat.replyChoices.count - 1} onClick={() => void chooseReply(chat.replyChoices!.selected + 1)}
              className="rounded border border-tavern-border px-2 py-1 disabled:opacity-40">→</button>
          </span>}
          <span className="text-tavern-dim">成功后保留候选；失败或停止时状态不变。</span>
        </div>}
        <div className="mx-auto flex max-w-3xl items-end gap-2">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                submit();
              }
            }}
            rows={Math.min(6, Math.max(1, input.split("\n").length))}
            placeholder={`以 ${personaName} 的身份发言…（Enter 发送，Shift+Enter 换行）`}
            className="flex-1 resize-none rounded-xl border border-tavern-border bg-tavern-bg px-3.5 py-2.5 text-[15px] text-tavern-text outline-none placeholder:text-tavern-dim focus:border-tavern-accent-dim"
          />
          {isStreaming ? (
            <button
              type="button"
              onClick={onStop}
              disabled={!connected}
              className="rounded-xl border border-tavern-border bg-tavern-raised px-4 py-2.5 text-sm text-tavern-text hover:border-red-400 hover:text-red-400"
            >
              停止
            </button>
          ) : (
            <button
              type="button"
              onClick={submit}
              disabled={disabled || locked || !input.trim()}
              className="rounded-xl bg-tavern-accent px-4 py-2.5 text-sm font-medium text-tavern-bg disabled:opacity-40"
            >
              发送
            </button>
          )}
        </div>
      </div>
      {backupsFor === chat.id && <BackupDialog key={chat.id} chatId={chat.id} busy={locked} onClose={() => setBackupsFor(null)} onRestored={onRestored} />}
      {noteFor === chat.id && <AuthorNoteDialog key={chat.id} chatId={chat.id} busy={locked} onClose={() => setNoteFor(null)} />}
    </main>
  );
}
