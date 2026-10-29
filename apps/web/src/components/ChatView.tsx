import { ScriptDialog } from "./ScriptDialog.tsx";
import { lazy, memo, Suspense, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from "react";
import type { ChatAppearanceDto, ChatDisplayDto, ChatMessageDto, DialoguePairDto, ReasoningLevel } from "@pitavern/shared";
import { RegexPlacement } from "@pitavern/shared/regex";
import { displayMessageIsolated } from "../displayRegex.ts";
import { isToolItem, TOOL_META, toolArgPreview, type ChatItem, type ToolItem } from "../chatItems.ts";

import { chatExportUrl } from "../api.ts";
import type { ChatState } from "../chatState.ts";
import { VirtualRow } from "./VirtualRow.tsx";
import { BackupDialog } from "./BackupDialog.tsx";
import { AuthorNoteDialog } from "./AuthorNoteDialog.tsx";
import { BranchDialog } from "./BranchDialog.tsx";
const MarkdownContent = lazy(() => import("./MessageContent.tsx").then(({ MessageContent }) => ({ default: MessageContent })));
const MessageContent = memo(function MessageContent({ text, placement, depth, display, dialoguePairs }: {
  text: string; placement: number; depth: number; display?: ChatDisplayDto; dialoguePairs?: DialoguePairDto[];
}) {
  // 分支切换会带来新的 display 对象，但内容通常没变；用内容签名避免重跑显示正则后短暂回退到原文（宏展开会造成换行抖动）。
  const displayKey = JSON.stringify(display ?? null);
  const [result, setResult] = useState<{ text: string; error?: string; source: string; displayKey: string; placement: number; depth: number }>();
  useEffect(() => {
    const controller = new AbortController();
    // Debounce streaming updates so each delta does not spawn and terminate a worker.
    const timer = setTimeout(() => {
      void displayMessageIsolated(text, placement, depth, display, controller.signal).then((value) => {
        if (!controller.signal.aborted) setResult({ text: value, source: text, displayKey, placement, depth });
      }).catch((error: Error) => {
        if (!controller.signal.aborted) setResult({ text, error: error.message, source: text, displayKey, placement, depth });
      });
    }, 60);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [text, placement, depth, displayKey]);
  const valid = result?.source === text && result.displayKey === displayKey && result.placement === placement && result.depth === depth;
  // 内容没变时保留上一次处理结果，避免分支切换/显示配置刷新时短暂回退到未展开宏的原文。
  const rendered = result?.source === text ? result.text : text;
  return <><Suspense fallback={<div className="whitespace-pre-wrap break-words">{rendered}</div>}><MarkdownContent text={rendered} dialoguePairs={dialoguePairs} /></Suspense>
    {valid && result.error && <p role="alert" className="mt-1 text-xs text-amber-400">{result.error}</p>}</>;
});

/** 流式生成计时；刷新或重连后从服务端 startedAt 继续。 */
function GenerationTimer({ startedAt }: { startedAt?: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!startedAt) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [startedAt]);
  if (!startedAt) return null;
  const started = Date.parse(startedAt);
  if (!Number.isFinite(started)) return null;
  const seconds = Math.max(0, Math.floor((now - started) / 1000));
  const minutes = Math.floor(seconds / 60);
  const display = minutes > 0 ? minutes + ":" + String(seconds % 60).padStart(2, "0") : seconds + "s";
  return <span role="timer" className="tabular-nums text-tavern-accent" aria-label={"已生成 " + seconds + " 秒"}>{display}</span>;
}

function CharacterAvatar({ src, name }: { src: string; name: string }) {
  const [failed, setFailed] = useState(false);
  return failed ? <span role="img" aria-label={name + "头像"}
    className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-tavern-accent/20 text-sm text-tavern-accent">{Array.from(name)[0]}</span>
    : <img src={src} alt="" onError={() => setFailed(true)} className="h-9 w-9 shrink-0 rounded-full object-cover" />;
}

interface ModelOption {
  providerId: string;
  providerName: string;
  modelId: string;
  modelName: string;
  reasoning?: boolean;
  thinkingLevel?: ReasoningLevel;
}

const THINKING_OPTIONS: { value: ReasoningLevel; label: string }[] = [
  { value: "off", label: "关闭" },
  { value: "minimal", label: "最低" },
  { value: "low", label: "低" },
  { value: "medium", label: "中" },
  { value: "high", label: "高" },
];

interface ChatViewProps {
  chat: ChatState | null;
  personaName: string;
  models: ModelOption[];
  currentModel: string;
  onModelChange: (providerId: string, modelId: string) => void;
  thinkingLevel: ReasoningLevel;
  onThinkingLevelChange: (level: ReasoningLevel) => void;
  appearance?: ChatAppearanceDto;
  streamingText: string | null;
  onSend: (text: string, speakers?: string[]) => boolean;
  onStop: () => void;
  onEdit: (messageId: string, text: string, expectedText: string) => Promise<boolean>;
  onRegenerate: (instruction?: string) => void;
  onSelectBranch: (userMessageId: string, selected: number) => Promise<boolean>;
  onSelectGreeting: (selected: number) => Promise<void>;
  onLoadOlder: () => Promise<boolean>;
  loadingOlder: boolean;
  onRestored: () => void;
  disabled: boolean;
  maintenance?: boolean;
  connected: boolean;
}

function MessageBubble({ message, avatarUrl, onEdit, busy, onPin, depth, display, speechColor, dialogueColor, dialoguePairs }: {
  message: ChatMessageDto; avatarUrl?: string; onEdit: ChatViewProps["onEdit"]; busy: boolean; onPin: (value: boolean) => void;
  depth: number; display?: ChatDisplayDto; speechColor?: string; dialogueColor?: string; dialoguePairs?: DialoguePairDto[];
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
      <div className={`flex min-w-0 flex-col ${draft ? "w-full flex-1 items-stretch" : isUser ? "max-w-[90%] items-end sm:max-w-[80%]" : "flex-1 items-start"}`}>
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
              rows={Math.min(24, Math.max(6, draft.text.split("\n").length))}
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
            (isUser ? "bg-tavern-accent/20 text-tavern-text" : "bg-tavern-raised text-tavern-text")}
            style={!isUser ? {
              ...(speechColor ? { color: speechColor } : {}),
              ...(dialogueColor ? { "--tavern-dialogue-color": dialogueColor } : {}),
            } as CSSProperties : undefined}>
            <MessageContent text={message.text} placement={isUser ? RegexPlacement.USER_INPUT : RegexPlacement.AI_OUTPUT} depth={depth}
              display={display ? { ...display, char: message.name } : undefined} dialoguePairs={!isUser ? dialoguePairs : undefined} />
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

const History = memo(function History({ items, avatarUrl, onEdit, busy, scrollRoot, display, memberDisplays, appearance, streamingOffset = 0 }: {
  items: ChatItem[]; avatarUrl: string; onEdit: ChatViewProps["onEdit"]; busy: boolean; scrollRoot: RefObject<HTMLDivElement | null>;
  display?: ChatDisplayDto; memberDisplays?: Record<string, ChatDisplayDto>; appearance?: ChatAppearanceDto; streamingOffset?: number;
}) {
  const depths = new Map<string, number>();
  let depth = streamingOffset;
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index];
    if (!isToolItem(item)) depths.set(item.id, depth++);
  }
  return <>{items.map((item, index) => <VirtualRow key={isToolItem(item) ? item.key : item.id} root={scrollRoot} initialVisible={index >= items.length - 8}>
    {(onPin) => isToolItem(item) ? <ToolCard item={item} onPin={onPin} />
      : <MessageBubble message={item} avatarUrl={"/api/characters/" + encodeURIComponent(item.name) + "/avatar"} onEdit={onEdit} busy={busy} onPin={onPin} depth={depths.get(item.id)!}
        display={memberDisplays?.[item.name] ?? display} speechColor={appearance?.speechColor}
        dialogueColor={appearance?.dialogueColor} dialoguePairs={appearance?.dialoguePairs} />}
  </VirtualRow>)}</>;
});

export function ChatView({ chat, personaName, models, currentModel, onModelChange, thinkingLevel, onThinkingLevelChange, appearance, streamingText, onSend, onStop, onEdit, onRegenerate,
  onSelectBranch, onSelectGreeting, onLoadOlder, loadingOlder, onRestored, disabled, maintenance = false, connected }: ChatViewProps) {
  const [responder, setResponder] = useState("");
  useEffect(() => setResponder(""), [chat?.id]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const input = chat ? drafts[chat.id] ?? "" : "";
  const setInput = (value: string) => {
    if (chat) setDrafts((previous) => ({ ...previous, [chat.id]: value }));
  };
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollRoot = useRef<HTMLDivElement>(null);
  const contents = useRef<HTMLDivElement>(null);
  const [backupsFor, setBackupsFor] = useState<string | null>(null);
  const [scriptFor, setScriptFor] = useState<string | null>(null);
  const [noteFor, setNoteFor] = useState<string | null>(null);
  const [branchOpen, setBranchOpen] = useState(false);
  const [actionsOpen, setActionsOpen] = useState(false);
  const [greetingOpen, setGreetingOpen] = useState(false);
  const actionsRef = useRef<HTMLDivElement>(null);
  const greetingRef = useRef<HTMLDivElement>(null);
  const [switching, setSwitching] = useState(false);
  useEffect(() => { setBranchOpen(false); setActionsOpen(false); setGreetingOpen(false); }, [chat?.id]);
  useEffect(() => {
    if (!actionsOpen && !greetingOpen) return;
    const closeOnPointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (actionsOpen && !actionsRef.current?.contains(target)) setActionsOpen(false);
      if (greetingOpen && !greetingRef.current?.contains(target)) setGreetingOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setActionsOpen(false);
      setGreetingOpen(false);
    };
    document.addEventListener("pointerdown", closeOnPointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnPointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [actionsOpen, greetingOpen]);
  const followRef = useRef(true);
  const isStreaming = streamingText !== null;
  const locked = isStreaming || switching || !connected || maintenance;

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
  const chooseGreeting = async (index: number) => {
    setSwitching(true);
    try { await onSelectGreeting(index); } finally { setSwitching(false); }
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
  const latestMessage = chat.items.filter((item) => !isToolItem(item)).at(-1);
  const hasUserTurn = chat.items.some((item) => !isToolItem(item) && item.role === "user");
  const canRegenerate = hasUserTurn && Boolean(latestMessage);
  const branchCount = chat.branchChoices?.length ?? 0;
  // 最新分叉点优先显示，即使之后已经在选中分支上继续写了新回合。
  const lastBranch = chat.branchChoices?.at(-1);
  const branchLabel = lastBranch ? `分支 ${lastBranch.selected + 1}/${lastBranch.count}` : "分支";
  const currentModelOption = models.find((model) => `${model.providerId}::${model.modelId}` === currentModel);
  const effectiveThinkingLevel = currentModelOption?.thinkingLevel ?? thinkingLevel;
  const submit = () => {
    const text = input.trim();
    if (!text || locked || (disabled && !text.startsWith("/"))) return;
    if (onSend(text, chat.group && responder ? [responder] : undefined)) setInput("");
  };

  return (
    <main className="relative flex min-w-0 flex-1 flex-col">
      {scriptFor === chat.id && chat.page && <ScriptDialog chatId={chat.id} revision={chat.page.revision} onClose={() => setScriptFor(null)} onStop={onStop} />}
      <div ref={scrollRoot} data-chat-scroll className="flex-1 overflow-y-auto px-6 py-4" onScroll={(event) => {
        const element = event.currentTarget;
        followRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
      }}>
        <div ref={contents} className="flex w-full flex-col gap-4 pt-4">
          {chat.page?.before != null && <button type="button" onClick={() => void loadOlder()} disabled={loadingOlder || locked}
            className="self-center rounded border border-tavern-border px-3 py-2 text-xs text-tavern-dim disabled:opacity-40">{loadingOlder ? "加载中…" : "加载更早的消息"}</button>}
          <History key={chat.id} items={[...chat.items, ...(chat.stagedMessages ?? [])]} avatarUrl={avatarUrl} onEdit={onEdit} busy={locked} scrollRoot={scrollRoot}
            display={chat.display} memberDisplays={chat.memberDisplays} appearance={appearance} streamingOffset={streamingText ? 1 : 0} />
          {isStreaming && (
            <div className="flex gap-3">
              <CharacterAvatar key={chat.streamingCharacter} src={"/api/characters/" + encodeURIComponent(chat.streamingCharacter ?? chat.character) + "/avatar"} name={chat.streamingCharacter ?? chat.character} />
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="mb-1 px-1 text-xs text-tavern-dim">{chat.streamingCharacter ?? chat.character}</span>
                <div className="min-w-0 w-full rounded-2xl bg-tavern-raised px-4 py-2.5 text-[15px] leading-relaxed"
                  style={{
                    ...(appearance?.speechColor ? { color: appearance.speechColor } : {}),
                    ...(appearance?.dialogueColor ? { "--tavern-dialogue-color": appearance.dialogueColor } : {}),
                  } as CSSProperties}>
                  <div className="mb-1.5 flex items-center gap-1.5 text-[11px] text-tavern-dim">
                    <span className={"inline-block h-1.5 w-1.5 animate-pulse rounded-full " + (streamingText ? "bg-emerald-400" : "bg-tavern-accent")} />
                    <span>{streamingText ? "生成中" : "思考中"}</span>
                    <GenerationTimer startedAt={chat.generationStartedAt} />
                  </div>
                  <MessageContent text={streamingText ?? ""} placement={RegexPlacement.AI_OUTPUT} depth={0}
                    display={chat.memberDisplays?.[chat.streamingCharacter ?? chat.character] ?? chat.display} dialoguePairs={appearance?.dialoguePairs} />
                  <span className="ml-0.5 inline-block h-4 w-2 animate-pulse bg-tavern-accent align-middle" />
                </div>
              </div>
            </div>
          )}
          <div ref={bottomRef} />
        </div>
      </div>

      <div className="shrink-0 border-t border-tavern-border bg-tavern-panel p-4">
        {chat.group && <label className="mb-2 flex w-full items-center gap-2 text-xs text-tavern-dim">本轮发言
          <select aria-label="本轮发言角色" value={responder} disabled={locked} onChange={(e) => setResponder(e.target.value)} className="min-w-0 rounded border border-tavern-border bg-tavern-bg p-1.5">
            <option value="">全员依次：{chat.group.members.join(" → ")}</option>
            {chat.group.members.map((name) => <option key={name} value={name}>{name}</option>)}
          </select>
        </label>}
        <div className="w-full">
          <div className="rounded-2xl border border-tavern-border bg-tavern-bg p-2 transition-colors focus-within:border-tavern-accent-dim">
            <textarea
              aria-label="消息输入"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  submit();
                }
              }}
              rows={Math.min(6, Math.max(1, input.split("\n").length))}
              placeholder={`/ 开头执行 STscript；以 ${personaName} 的身份发言…（Enter 发送，Shift+Enter 换行）`}
              className="block w-full resize-none border-0 bg-transparent px-2 py-2 text-[15px] text-tavern-text outline-none placeholder:text-tavern-dim"
            />
            <div className="mt-1 flex flex-wrap items-center gap-2 border-t border-tavern-border/60 px-1 pt-2">
              <div className="flex min-w-0 flex-1 basis-40 items-center gap-2 text-xs text-tavern-dim">
                <div ref={actionsRef} className="relative shrink-0">
                  <button type="button" aria-label="聊天操作" onClick={() => setActionsOpen((value) => !value)}
                    className="flex h-7 w-7 items-center justify-center rounded-full border border-tavern-border bg-tavern-raised text-base leading-none text-tavern-dim hover:border-tavern-accent-dim hover:text-tavern-text">
                    ＋
                  </button>
                  {actionsOpen && (
                    <div role="menu" aria-label="聊天操作菜单"
                      className="absolute bottom-full left-0 z-50 mb-2 w-44 overflow-hidden rounded-xl border border-tavern-border bg-tavern-panel py-1 text-sm shadow-xl">
                      <button type="button" role="menuitem" disabled={locked || !chat.page?.revision}
                        onClick={() => { setActionsOpen(false); setScriptFor(chat.id); }}
                        className="block w-full px-3 py-2 text-left text-tavern-text hover:bg-tavern-raised disabled:opacity-40">STscript</button>
                      <button type="button" role="menuitem" disabled={locked}
                        onClick={() => { setActionsOpen(false); setNoteFor(chat.id); }}
                        className="block w-full px-3 py-2 text-left text-tavern-text hover:bg-tavern-raised disabled:opacity-40">作者注释</button>
                      <button type="button" role="menuitem" disabled={locked}
                        onClick={() => { setActionsOpen(false); setBackupsFor(chat.id); }}
                        className="block w-full px-3 py-2 text-left text-tavern-text hover:bg-tavern-raised disabled:opacity-40">备份与恢复</button>
                      <div className="my-1 border-t border-tavern-border" />
                      <a role="menuitem" href={chatExportUrl(chat.id, "md")} onClick={() => setActionsOpen(false)}
                        className="block px-3 py-2 text-tavern-text hover:bg-tavern-raised">导出 MD</a>
                      <a role="menuitem" href={chatExportUrl(chat.id, "jsonl")} onClick={() => setActionsOpen(false)}
                        className="block px-3 py-2 text-tavern-text hover:bg-tavern-raised">导出 JSONL</a>
                    </div>
                  )}
                </div>
                {models.length === 0 ? (
                  <span className="min-w-0 truncate">未配置模型</span>
                ) : (
                  <div className="group relative inline-flex min-w-0 max-w-xs items-center">
                    <span aria-hidden="true" className="pointer-events-none flex min-w-0 items-center gap-1 py-1 pl-1 text-xs text-tavern-dim group-hover:text-tavern-text">
                      <span className="truncate">{currentModelOption ? `${currentModelOption.providerName} / ${currentModelOption.modelName}${currentModelOption.reasoning ? " ✦" : ""}` : "选择模型"}</span>
                      <span className="shrink-0 text-[10px]">⌄</span>
                    </span>
                    <select
                      aria-label="当前模型"
                      value={currentModel}
                      onChange={(event) => {
                        const [providerId, modelId] = event.target.value.split("::");
                        if (providerId && modelId) onModelChange(providerId, modelId);
                      }}
                      className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
                    >
                      {!currentModel && <option value="">选择模型</option>}
                      {models.map((model) => (
                        <option key={`${model.providerId}::${model.modelId}`} value={`${model.providerId}::${model.modelId}`}>
                          {model.providerName} / {model.modelName}
                          {model.reasoning ? " ✦" : ""}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
                {currentModelOption?.reasoning && (
                  <label className="ml-1 flex shrink-0 items-center gap-1.5">
                    <span className="hidden sm:inline">推理</span>
                    <span className="relative flex items-center">
                      <select aria-label="推理等级" value={effectiveThinkingLevel}
                        onChange={(event) => onThinkingLevelChange(event.target.value as ReasoningLevel)}
                        className="cursor-pointer appearance-none rounded-md bg-transparent py-1 pl-1 pr-4 text-xs text-tavern-dim outline-none hover:text-tavern-text focus:text-tavern-text">
                        {THINKING_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                      </select>
                      <span className="pointer-events-none absolute right-0 top-1/2 -translate-y-1/2 text-[10px] text-tavern-dim">⌄</span>
                    </span>
                  </label>
                )}
              </div>
              <div className="ml-auto flex shrink-0 items-center gap-2">
                {chat.greetingChoices && (
                  <div ref={greetingRef} className="relative">
                    <button type="button" aria-label="开场白" title="选择开场白"
                      disabled={locked || !chat.page?.revision}
                      onClick={() => setGreetingOpen((value) => !value)}
                      className="rounded-lg border border-tavern-border px-2.5 py-1.5 text-xs text-tavern-dim hover:border-tavern-accent-dim hover:text-tavern-text disabled:opacity-40">
                      🎭 开场白
                    </button>
                    {greetingOpen && (
                      <div role="dialog" aria-label="选择开场白"
                        className="absolute bottom-full right-0 z-30 mb-2 w-80 max-w-[calc(100vw-2rem)] rounded-xl border border-tavern-border bg-tavern-panel p-3 text-xs shadow-2xl">
                        <p className="mb-2 text-tavern-dim">第 {chat.greetingChoices.selected + 1} / {chat.greetingChoices.labels.length} 页 · 发送第一条消息后不再切换</p>
                        <div className="flex max-h-64 flex-col gap-1 overflow-y-auto">
                          {chat.greetingChoices.labels.map((label, index) => (
                            <button key={index} type="button"
                              aria-current={index === chat.greetingChoices!.selected ? "true" : undefined}
                              onClick={() => { setGreetingOpen(false); void chooseGreeting(index); }}
                              className={`rounded-lg px-2.5 py-2 text-left leading-5 ${index === chat.greetingChoices!.selected
                                ? "bg-tavern-accent/15 text-tavern-accent"
                                : "text-tavern-text hover:bg-tavern-raised"}`}>
                              {label.replace(/\{\{user\}\}/gi, personaName).replace(/\{\{char\}\}/gi, chat.character)}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}
                <button
                  type="button"
                  onClick={() => setBranchOpen(true)}
                  disabled={locked}
                  aria-label="剧情分支"
                  title={branchCount > 0 ? `可回到 ${branchCount} 个分叉回合切换剧情；也可以指定方向重新生成` : "查看剧情分支，或按指定方向重新生成"}
                  className="rounded-lg border border-tavern-border px-2.5 py-1.5 text-xs text-tavern-dim hover:border-tavern-accent-dim hover:text-tavern-text disabled:opacity-40"
                >
                  ⑂ {branchLabel}
                </button>
                <button
                  type="button"
                  onClick={() => onRegenerate()}
                  disabled={locked || disabled || !canRegenerate}
                  aria-label="重新生成回复"
                  title="重新生成回复（成功后保留为候选分支）"
                  className="rounded-lg border border-tavern-border px-2.5 py-1.5 text-sm text-tavern-dim hover:border-tavern-accent-dim hover:text-tavern-text disabled:opacity-40"
                >
                  ↻
                </button>
                {isStreaming ? (
                  <button
                    type="button"
                    onClick={onStop}
                    disabled={!connected}
                    className="rounded-lg border border-tavern-border bg-tavern-raised px-4 py-1.5 text-sm text-tavern-text hover:border-red-400 hover:text-red-400"
                  >
                    停止
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={submit}
                    disabled={(disabled && !input.trim().startsWith("/")) || locked || !input.trim()}
                    className="rounded-lg bg-tavern-accent px-4 py-1.5 text-sm font-medium text-tavern-bg disabled:opacity-40"
                  >
                    发送
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
      {backupsFor === chat.id && <BackupDialog key={chat.id} chatId={chat.id} busy={locked} onClose={() => setBackupsFor(null)} onRestored={onRestored} />}
      {noteFor === chat.id && <AuthorNoteDialog key={chat.id} chatId={chat.id} busy={locked} onClose={() => setNoteFor(null)} />}
      {branchOpen && <BranchDialog points={chat.branchChoices ?? []} busy={locked} canRegenerate={canRegenerate && !disabled && !isStreaming}
        onSelect={onSelectBranch} onRegenerate={(instruction) => onRegenerate(instruction.trim() || undefined)} onClose={() => setBranchOpen(false)} />}
    </main>
  );
}
