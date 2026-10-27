/**
 * PiTavern 前后端共享契约：WS 事件协议与 DTO。
 *
 * 这是 server ⇄ web 的唯一协议定义。新增事件时先改这里，
 * 两端 TS 会同时报错，避免契约漂移。
 */

export const PITAVERN_VERSION = "0.1.0";

/** SillyTavern instruct 预设的单人对话字段。 */
export interface InstructTemplate {
  name: string;
  input_sequence: string;
  output_sequence: string;
  system_sequence: string;
  input_suffix: string;
  output_suffix: string;
  system_suffix: string;
  story_string_prefix?: string;
  story_string_suffix?: string;
  user_alignment_message?: string;
  first_input_sequence?: string;
  last_input_sequence?: string;
  first_output_sequence?: string;
  last_output_sequence?: string;
  last_system_sequence?: string;
  stop_sequence: string;
  wrap: boolean;
  macro: boolean;
  names_behavior: "none" | "always" | "force";
  system_same_as_user: boolean;
  sequences_as_stop_strings: boolean;
}

export const INSTRUCT_TEMPLATES: Record<string, InstructTemplate> = {
  ChatML: {
    name: "ChatML", input_sequence: "<|im_start|>user\n", output_sequence: "<|im_start|>assistant\n",
    system_sequence: "<|im_start|>system\n", input_suffix: "<|im_end|>\n", output_suffix: "<|im_end|>\n",
    system_suffix: "<|im_end|>\n", stop_sequence: "<|im_end|>", wrap: false, macro: true,
    names_behavior: "none", system_same_as_user: false, sequences_as_stop_strings: true,
  },
  Alpaca: {
    name: "Alpaca", input_sequence: "### Instruction:", output_sequence: "### Response:",
    system_sequence: "", input_suffix: "\n\n", output_suffix: "\n\n", system_suffix: "\n\n",
    stop_sequence: "", wrap: true, macro: true, names_behavior: "none", system_same_as_user: false,
    sequences_as_stop_strings: true,
  },
};

export interface VectorSettings {
  enabled: boolean;
  providerId: string;
  model: string;
  queryMessages: number;
  maxEntries: number;
  scoreThreshold: number;
}

export interface WorldInfoSettings {
  scanDepth: number;
  recursionSteps: number;
  caseSensitive: boolean;
  matchWholeWords: boolean;
  minActivations?: number;
  minActivationsDepthMax?: number;
  /** 0 不单独限制；使用保守字符估算，非模型精确 token 数。 */
  budgetTokens?: number;
}

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
  apiType?: "chat" | "text";
  instruct?: InstructTemplate;
  models: ProviderModelDto[];
}

/** 连接设置（apiKey 永不下发到前端，只回传 hasApiKey） */
export interface ConnectionDto {
  providers: ProviderDto[];
  defaultProvider: string;
  defaultModel: string;
  stDataDir: string;
  persona: { name: string; description: string };
  /** simple=内置简洁组装；bridge=ST 预设桥接组装；takeover=agent 原生接管组装 */
  contextMode: "simple" | "bridge" | "takeover";
  activePreset: string;
  activeWorlds: string[];
  worldInfo: WorldInfoSettings;
  vectors: VectorSettings;
  /** native=纯文本流式；game_tool=强制工具调用防截断 */
  outputProtocol: "native" | "game_tool";
  protocolStrict: boolean;
  compression: { enabled: boolean; keepFullTurns: number };
  /** 接管模式：历史保留轮数与状态投影开关 */
  takeover: { recentTurns: number; stateProjection: boolean };
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
  /** 接管模式的状态投影（chat_metadata.projection） */
  projection?: string;
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
  /** 状态投影已落库；增量更新，不替换聊天正文和工具活动。 */
  | { type: "chat.projection"; chatId: string; projection: string }
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
