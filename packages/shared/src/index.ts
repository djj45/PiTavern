/**
 * PiTavern 前后端共享契约：WS 事件协议与 DTO。
 *
 * 这是 server ⇄ web 的唯一协议定义。新增事件时先改这里，
 * 两端 TS 会同时报错，避免契约漂移。
 */

export const PITAVERN_VERSION = "0.1.0";

// ---------------------------------------------------------------- DTO

export interface ProviderModelDto {
  id: string;
  name: string;
  reasoning: boolean;
  contextWindow: number;
  maxTokens: number;
}

export interface ProviderDto {
  id: string;
  name: string;
  baseUrl: string;
  hasApiKey: boolean;
  models: ProviderModelDto[];
}

/** 连接设置（apiKey 永不下发到前端，只回传 hasApiKey） */
export interface ConnectionDto {
  providers: ProviderDto[];
  defaultProvider: string;
  defaultModel: string;
  stDataDir: string;
  persona: { name: string; description: string };
  /** simple=内置简洁组装；bridge=ST 预设桥接组装 */
  contextMode: "simple" | "bridge";
  activePreset: string;
  activeWorlds: string[];
  worldInfo: { scanDepth: number; recursionSteps: number; caseSensitive: boolean; matchWholeWords: boolean };
  /** native=纯文本流式；game_tool=强制工具调用防截断 */
  outputProtocol: "native" | "game_tool";
  protocolStrict: boolean;
  compression: { enabled: boolean; keepFullTurns: number };
}

export interface PresetSummaryDto {
  name: string;
  promptCount: number;
  orderCount: number;
}

export interface WorldSummaryDto {
  name: string;
  entryCount: number;
}

export interface CharacterDto {
  /** 人物卡名（也是头像接口的 key） */
  name: string;
  avatarUrl: string;
  description: string;
  personality: string;
  scenario: string;
  firstMes: string;
  alternateGreetings: string[];
  tags: string[];
  creator: string;
}

export interface ChatSummaryDto {
  /** 相对 dataDir 的路径，作为唯一 id，如 "chats/Seraphina/2026-10-26@20h30m00s.jsonl" */
  id: string;
  character: string;
  title: string;
  messageCount: number;
  lastMessage: string;
  updatedAt: string;
}

export type ChatRole = "user" | "assistant";

export interface ChatMessageDto {
  id: string;
  role: ChatRole;
  /** 发送者显示名（角色名 / 用户 persona 名） */
  name: string;
  text: string;
  sendDate: string;
  /** 思维链（输出协议 tavern_think 或 reasoning 模型思考），前端折叠展示 */
  thinking?: string;
}

export interface ChatSnapshotDto {
  id: string;
  character: string;
  messages: ChatMessageDto[];
  running: boolean;
  streamingText: string;
}

// ---------------------------------------------------------------- WS 协议

export type ClientMessage =
  | { type: "chat.send"; chatId: string; text: string }
  | { type: "chat.abort"; chatId: string }
  | { type: "chat.sync"; chatId: string }
  | { type: "ping" };

export type ServerEvent =
  | { type: "hello"; version: string }
  | { type: "pong" }
  /** 本轮生成开始 */
  | { type: "chat.started"; chatId: string; message: ChatMessageDto }
  | { type: "chat.snapshot"; chatId: string; snapshot: ChatSnapshotDto }
  /** 整个用户回合结束，包括停止、失败和没有正文的情况。 */
  | { type: "chat.finished"; chatId: string }
  /** 正文流式增量 */
  | { type: "chat.delta"; chatId: string; delta: string }
  /** 思维链流式增量（M4 起协议输出会用到，先通管线） */
  | { type: "chat.thinking"; chatId: string; delta: string }
  /** 一条助手消息已落库；工具回合可能继续，chat.finished 才表示整轮结束。 */
  | { type: "chat.done"; chatId: string; message: ChatMessageDto }
  /** 本轮 token/成本统计 */
  | {
      type: "chat.usage";
      chatId: string;
      input: number;
      output: number;
      totalTokens: number;
      costTotal: number;
    }
  | { type: "chat.error"; chatId: string; message: string }
  | { type: "chat.tool_start"; chatId: string; toolCallId: string; toolName: string; args: unknown }
  | {
      type: "chat.tool_end";
      chatId: string;
      toolCallId: string;
      toolName: string;
      isError: boolean;
      durationMs?: number;
      /** 工具回传的 UI 摘要（每个工具保证含 summary 字段） */
      details?: { summary?: string; [key: string]: unknown };
    };
