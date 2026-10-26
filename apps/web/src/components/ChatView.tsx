import { useEffect, useRef, useState } from "react";
import type { ChatMessageDto } from "@pitavern/shared";

interface ChatViewProps {
  chat: { id: string; character: string; messages: ChatMessageDto[] } | null;
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
      <div className={`max-w-[80%] ${isUser ? "items-end" : "items-start"} flex flex-col`}>
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

export function ChatView({ chat, personaName, streamingText, onSend, onStop, disabled }: ChatViewProps) {
  const [input, setInput] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);
  const isStreaming = streamingText !== null;

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chat?.messages.length, streamingText]);

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
        <div className="mx-auto flex max-w-3xl flex-col gap-5">
          {chat.messages.map((m) => (
            <MessageBubble key={m.id} message={m} avatarUrl={avatarUrl} />
          ))}
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
