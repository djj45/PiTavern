import type { ServerEvent } from "@pitavern/shared";
import { isToolItem, type ChatItem } from "./chatItems.ts";
export interface UsageStats {
  input: number;
  output: number;
  totalTokens: number;
  costTotal: number;
  turns: number;
}

export const EMPTY_USAGE: UsageStats = { input: 0, output: 0, totalTokens: 0, costTotal: 0, turns: 0 };

export interface ChatState {
  id: string;
  character: string;
  items: ChatItem[];
  streamingText: string | null;
  pending: boolean;
  usage: UsageStats;
}

export type ChatsState = Record<string, ChatState>;
export type ChatAction = ServerEvent | { type: "pending" | "remove"; chatId: string } | { type: "disconnected" };

/** 按聊天独立归并事件；后台聊天完成不会改变当前聊天的生成状态。 */
export function chatReducer(state: ChatsState, event: ChatAction): ChatsState {
  if (event.type === "disconnected") {
    return Object.fromEntries(Object.entries(state).map(([id, chat]) => [id, { ...chat, pending: false }]));
  }
  if (!("chatId" in event)) return state;
  const previous = state[event.chatId];
  if (event.type === "remove") {
    const next = { ...state };
    delete next[event.chatId];
    return next;
  }
  if (event.type === "chat.snapshot") {
    const { snapshot } = event;
    return { ...state, [event.chatId]: {
      id: snapshot.id, character: snapshot.character, items: snapshot.messages,
      streamingText: snapshot.running ? snapshot.streamingText : null,
      pending: false, usage: previous?.usage ?? EMPTY_USAGE,
    } };
  }
  if (!previous) return state;
  let chat = previous;
  switch (event.type) {
    case "pending":
      chat = { ...chat, pending: true };
      break;
    case "chat.started":
      chat = { ...chat, pending: false, streamingText: "", items: [...chat.items, event.message], usage: { ...chat.usage, turns: chat.usage.turns + 1 } };
      break;
    case "chat.delta":
      chat = { ...chat, streamingText: (chat.streamingText ?? "") + event.delta };
      break;
    case "chat.done":
      chat = { ...chat, streamingText: "", items: [...chat.items, event.message] };
      break;
    case "chat.finished":
      chat = { ...chat, pending: false, streamingText: null, items: chat.items.map((item) =>
        isToolItem(item) && item.status === "running" ? { ...item, status: "error", summary: "本轮已结束" } : item) };
      break;
    case "chat.error":
      chat = { ...chat, pending: false };
      break;
    case "chat.tool_start":
      chat = { ...chat, items: [...chat.items, {
        kind: "tool", key: event.toolCallId, toolCallId: event.toolCallId,
        toolName: event.toolName, args: event.args, status: "running",
      }] };
      break;
    case "chat.tool_end":
      chat = { ...chat, items: chat.items.map((item) => isToolItem(item) && item.toolCallId === event.toolCallId
        ? { ...item, status: event.isError ? "error" : "done", summary: event.details?.summary, durationMs: event.durationMs } : item) };
      break;
    case "chat.usage":
      chat = { ...chat, usage: {
        ...chat.usage, input: chat.usage.input + event.input, output: chat.usage.output + event.output,
        totalTokens: chat.usage.totalTokens + event.totalTokens, costTotal: chat.usage.costTotal + event.costTotal,
      } };
      break;
  }
  return chat === previous ? state : { ...state, [event.chatId]: chat };
}
