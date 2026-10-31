import type { GroupChatDto, ChatMessageDto, ChatActivityDto, ChatDisplayDto, ChatPageDto, ReplyChoicesDto, GreetingChoicesDto, BranchPointDto, ServerEvent } from "@pitavern/shared";
import type { WorldChatStateDto } from "@pitavern/shared/world";
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
  group?: GroupChatDto;
  memberDisplays?: Record<string, ChatDisplayDto>;
  streamingCharacter?: string;
  stagedMessages?: ChatMessageDto[];
  items: ChatItem[];
  streamingText: string | null;
  /** 当前生成的服务端开始时间；用于流式气泡计时。 */
  generationStartedAt?: string;
  pending: boolean;
  usage: UsageStats;
  /** 接管模式的状态投影 */
  projection?: string;
  page?: Omit<ChatPageDto, "messages">;
  replyChoices?: ReplyChoicesDto;
  /** 沿当前活动路径可来回切换的历史分支点。 */
  branchChoices?: BranchPointDto[];
  greetingChoices?: GreetingChoicesDto;
  activity?: ChatActivityDto;
  activityError?: string;
  display?: ChatDisplayDto;
  /** M4：当前聊天的世界快照/模板/能力；未初始化时缺省。 */
  world?: WorldChatStateDto;
}

export type ChatsState = Record<string, ChatState>;
export type ChatAction = ServerEvent | { type: "pending" | "remove"; chatId: string } | { type: "disconnected" }
  | { type: "history.page"; chatId: string; page: ChatPageDto; before: number };

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
    const activity = previous?.activity && snapshot.activity && previous.activity.revision > snapshot.activity.revision
      ? previous.activity : snapshot.activity ?? (snapshot.activityError ? previous?.activity : undefined);
    const preserve = previous && (event.append || (snapshot.page && snapshot.page.revision === previous.page?.revision));
    const byId = new Map(snapshot.messages.map((m) => [m.id, m]));
    const existingIds = new Set(previous?.items.flatMap((item) => isToolItem(item) ? [] : [item.id]));
    const merged = preserve ? [
      ...previous.items.map((item) => isToolItem(item) ? item : byId.get(item.id) ?? item),
      ...snapshot.messages.filter((message) => !existingIds.has(message.id)),
    ] : snapshot.messages;
    const items = activity ? merged.filter((item) => !isToolItem(item)) : merged;
    const page = snapshot.page && { ...snapshot.page,
      ...(preserve && previous.page ? { before: previous.page.before } : {}),
    };
    return { ...state, [event.chatId]: {
      id: snapshot.id, character: snapshot.character, group: snapshot.group, memberDisplays: snapshot.memberDisplays, streamingCharacter: snapshot.streamingCharacter, stagedMessages: snapshot.stagedMessages, items, page, replyChoices: snapshot.replyChoices, branchChoices: snapshot.branchChoices, greetingChoices: snapshot.greetingChoices,
      streamingText: snapshot.running ? snapshot.streamingText : null,
      generationStartedAt: snapshot.running ? snapshot.generationStartedAt : undefined,
      pending: false, activity, activityError: snapshot.activityError, display: snapshot.display, world: snapshot.world,
      usage: activity ? { ...activity.usage, turns: activity.turns } : previous?.usage ?? EMPTY_USAGE,
      ...(snapshot.projection ? { projection: snapshot.projection } : {}),
    } };
  }
  if (!previous) return state;
  let chat = previous;
  switch (event.type) {
    case "chat.activity":
      if (chat.activity && chat.activity.revision > event.activity.revision) return state;
      chat = { ...chat, activity: event.activity, activityError: undefined, usage: { ...event.activity.usage, turns: event.activity.turns } };
      break;
    case "history.page": {
      if (!chat.page || chat.page.revision !== event.page.revision || chat.page.before !== event.before) return state;
      const ids = new Set(chat.items.flatMap((item) => isToolItem(item) ? [] : [item.id]));
      const { messages, ...page } = event.page;
      chat = { ...chat, items: [...messages.filter((message) => !ids.has(message.id)), ...chat.items], page };
      break;
    }
    case "chat.projection":
      chat = { ...chat, projection: event.projection };
      break;
    case "pending":
      chat = { ...chat, pending: true, generationStartedAt: chat.generationStartedAt ?? new Date().toISOString() };
      break;
    case "chat.regenerating":
      chat = { ...chat, pending: false, streamingText: "", generationStartedAt: event.startedAt };
      break;
    case "chat.started":
      chat = { ...chat, pending: false, streamingText: "", generationStartedAt: event.startedAt, stagedMessages: [], items: [...chat.items, event.message],
        display: chat.display && { ...chat.display, lastUserMessage: event.message.text },
        page: chat.page && { ...chat.page, total: chat.page.total + 1 }, replyChoices: undefined, greetingChoices: undefined,
        usage: chat.activity ? chat.usage : { ...chat.usage, turns: chat.usage.turns + 1 } };
      break;
    case "chat.speaker":
      chat = { ...chat, streamingText: "", streamingCharacter: event.character, stagedMessages: event.stagedMessages };
      break;
    case "chat.delta":
      chat = { ...chat, streamingText: (chat.streamingText ?? "") + event.delta };
      break;
    case "chat.done":
      chat = { ...chat, streamingText: "", stagedMessages: [], items: [...chat.items, event.message] };
      break;
    case "chat.finished":
      chat = { ...chat, pending: false, streamingText: null, generationStartedAt: undefined, stagedMessages: [], items: chat.items.map((item) =>
        isToolItem(item) && item.status === "running" ? { ...item, status: "error", summary: "本轮已结束" } : item) };
      break;
    case "chat.error":
      chat = { ...chat, pending: false };
      break;
    case "chat.tool_start":
      if (chat.activity) break;
      chat = { ...chat, items: [...chat.items, {
        kind: "tool", key: event.toolCallId, toolCallId: event.toolCallId,
        toolName: event.toolName, args: event.args, status: "running",
      }] };
      break;
    case "chat.tool_end":
      if (chat.activity) break;
      chat = { ...chat, items: chat.items.map((item) => isToolItem(item) && item.toolCallId === event.toolCallId
        ? { ...item, status: event.isError ? "error" : "done", summary: event.details?.summary, durationMs: event.durationMs } : item) };
      break;
    case "chat.usage":
      if (chat.activity) break;
      chat = { ...chat, usage: {
        ...chat.usage, input: chat.usage.input + event.input, output: chat.usage.output + event.output,
        totalTokens: chat.usage.totalTokens + event.totalTokens, costTotal: chat.usage.costTotal + event.costTotal,
      } };
      break;
  }
  return chat === previous ? state : { ...state, [event.chatId]: chat };
}
