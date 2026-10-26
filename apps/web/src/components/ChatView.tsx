import { useEffect, useRef, useState } from "react";
import type { ChatMessageDto } from "@pitavern/shared";
import { isToolItem, TOOL_META, toolArgPreview, type ChatItem, type ToolItem } from "../chatItems.ts";

interface ChatViewProps {
  chat: { id: string; character: string; items: ChatItem[] } | null;
  personaName: string;
  streamingText: string | null;
  onSend: (text: string) => void;
  onStop: () => void;
  disabled: boolean;
}

function MessageBubble({ message, avatarUrl }: { message: ChatMessageDto; avatarUrl?: string }) {
  const isUser = message.role === "user";
  return (
    <div className={`flex gap-3 ${isUser ? "flex-row-reverse" : ""}`}>
      {!isUser && avatarUrl && <img src={avatarUrl} alt="" className="h-9 w-9 shrink-0 rounded-full object-cover" />}
      <div className={`flex max-w-[80%] flex-col ${isUser ? "items-end" : "items-start"}`}>
        <span className="mb-1 px-1 text-xs text-tavern-dim">{message.name}</span>
        <div
          className={`whitespace-pre-wrap rounded-2xl px-4 py-2.5 text-[15px] leading-relaxed ${
            isUser ? "bg-tavern-accent/20 text-tavern-text" : "bg-tavern-raised text-tavern-text"
          }`}
        >
          {message.text}
        </div>
      </div>
    </div>
  );
}

function ToolCard({ item }: { item: ToolItem }) {
  const [open, setOpen] = useState(false);
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

export function ChatView({ chat, personaName, streamingText, onSend, onStop, disabled }: ChatViewProps) {
  const [input, setInput] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);
  const isStreaming = streamingText !== null;

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chat?.items.length, streamingText]);

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
    if (!text || isStreaming || disabled) return;
    onSend(text);
    setInput("");
  };

  return (
    <main className="flex min-w-0 flex-1 flex-col">
      <div className="flex-1 overflow-y-auto px-6 py-4">
        <div className="mx-auto flex max-w-3xl flex-col gap-4">
          {chat.items.map((item, i) =>
            isToolItem(item) ? (
              <ToolCard key={item.key} item={item} />
            ) : (
              <MessageBubble key={item.id || `msg-${i}`} message={item} avatarUrl={avatarUrl} />
            ),
          )}
          {isStreaming && (
            <div className="flex gap-3">
              <img src={avatarUrl} alt="" className="h-9 w-9 shrink-0 rounded-full object-cover" />
              <div className="flex max-w-[80%] flex-col">
                <span className="mb-1 px-1 text-xs text-tavern-dim">{chat.character}</span>
                <div className="whitespace-pre-wrap rounded-2xl bg-tavern-raised px-4 py-2.5 text-[15px] leading-relaxed">
                  {streamingText}
                  <span className="ml-0.5 inline-block h-4 w-2 animate-pulse bg-tavern-accent align-middle" />
                </div>
              </div>
            </div>
          )}
          <div ref={bottomRef} />
        </div>
      </div>

      <div className="shrink-0 border-t border-tavern-border bg-tavern-panel p-4">
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
              className="rounded-xl border border-tavern-border bg-tavern-raised px-4 py-2.5 text-sm text-tavern-text hover:border-red-400 hover:text-red-400"
            >
              停止
            </button>
          ) : (
            <button
              type="button"
              onClick={submit}
              disabled={disabled || !input.trim()}
              className="rounded-xl bg-tavern-accent px-4 py-2.5 text-sm font-medium text-tavern-bg disabled:opacity-40"
            >
              发送
            </button>
          )}
        </div>
      </div>
    </main>
  );
}
