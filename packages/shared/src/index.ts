/**
 * PiTavern 前后端共享契约：WS 事件协议与 DTO。
 *
 * 这是 server ⇄ web 的唯一协议定义。新增事件时先改这里，
 * 两端 TS 会同时报错，避免契约漂移。
 */

export const PITAVERN_VERSION = "0.2.2";

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
  useGroupScoring?: boolean;
  minActivations?: number;
  minActivationsDepthMax?: number;
  /** 0 不单独限制；使用模型计数器，未知模型回退估算。 */
  budgetTokens?: number;
}

// ---------------------------------------------------------------- DTO

export interface ProviderModelDto {
  id: string;
  name: string;
  reasoning: boolean;
  contextWindow: number;
  maxTokens: number;
  tokenizer?: TokenizerSetting;
  /** 该模型默认思考强度；未设置时回退到全局 thinkingLevel。 */
  thinkingLevel?: ReasoningLevel;
}

/** Discovery returns identity only; capability limits remain user-configured. */
export interface DiscoveredModelDto {
  id: string;
  name: string;
}

export interface ModelDiscoveryRequest {
  providerId?: string;
  baseUrl: string;
  apiKey?: string;
}

export type TokenizerSetting = "auto" | "cl100k_base" | "o200k_base" | "estimate";

export interface GenerationUsageDto {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  costTotal: number;
  responses: number;
  responsesWithUsage: number;
}

export interface ToolActivityDto {
  key: string;
  toolCallId: string;
  toolName: string;
  args: unknown;
  status: "running" | "done" | "error";
  summary?: string;
  durationMs?: number;
}

export interface WorldInfoDecisionDto {
  uid: string;
  world: string;
  label: string;
  status: "included" | "skipped";
  reason: string;
  tokens?: number;
}

export interface ContextAssemblyDto {
  mode: "simple" | "bridge" | "takeover";
  historyMessages: number;
  omittedHistoryMessages: number;
  promptEntries?: number;
  absoluteInjections?: number;
  worldInfo: WorldInfoDecisionDto[];
  worldInfoTotal: number;
}

export interface ContextDiagnosticsDto {
  request: number;
  tokenizer: string;
  counting: "tokenizer" | "estimate";
  contextWindow: number;
  outputReserved: number;
  safetyMargin: number;
  inputBudget: number;
  beforeTokens: number;
  afterTokens: number;
  breakdown: { system: number; conversation: number; tools: number; framing: number };
  compressedMessages: number;
  compressedTurns: number;
  keptMessages: number;
  overBudget: boolean;
  assembly: ContextAssemblyDto;
}

export interface GenerationRecordDto {
  id: string;
  version: number;
  userMessageId: string;
  kind: "send" | "regenerate" | "retry" | "script";
  provider: string;
  model: string;
  startedAt: string;
  finishedAt?: string;
  status: "running" | "succeeded" | "failed" | "aborted" | "interrupted";
  error?: string;
  usage: GenerationUsageDto;
  tools: ToolActivityDto[];
  context?: ContextDiagnosticsDto;
}

export interface GenerationPageDto {
  records: GenerationRecordDto[];
  before: string | null;
}

export interface ChatActivityDto extends GenerationPageDto {
  revision: number;
  turns: number;
  totalGenerations: number;
  usage: GenerationUsageDto;
  toolCounts: Record<string, number>;
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
/** 推理模型的思考强度；off 关闭，其余对应 pi 的 thinking level。 */
export type ReasoningLevel = "off" | "minimal" | "low" | "medium" | "high";

export interface DialoguePairDto {
  /** 对白起始符号，例如「、“。 */
  open: string;
  /** 对白结束符号，例如」、”。 */
  close: string;
  /** 该组符号的颜色；留空时使用聊天配色里的默认对白颜色。 */
  color?: string;
}

/** 默认把中文直角引号和弯引号内的文字标成对白色。 */
export const DEFAULT_DIALOGUE_PAIRS: DialoguePairDto[] = [
  { open: "「", close: "」" },
  { open: "“", close: "”" },
];

export interface ChatAppearanceDto {
  /** 角色回复文字颜色；空串表示跟随主题。 */
  speechColor: string;
  /** 对白文字颜色；空串表示跟随主题强调色。 */
  dialogueColor: string;
  /** 参与对白着色的成对符号。 */
  dialoguePairs: DialoguePairDto[];
}

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
  /** 官方 API / 推理模型使用的思考强度；只有 model.reasoning 为真时生效 */
  thinkingLevel: ReasoningLevel;
  /** native=纯文本流式；game_tool=强制工具调用防截断 */
  outputProtocol: "native" | "game_tool";
  protocolStrict: boolean;
  compression: { enabled: boolean; keepFullTurns: number };
  /** 接管模式：历史保留轮数与状态投影开关 */
  takeover: { recentTurns: number; stateProjection: boolean };
  /** 多分支：正常回复成功后自动追加的额外候选数（0 关闭，最多 4） */
  branches: { autoGenerate: number };
  /** 聊天文字配色；空串跟随主题。 */
  appearance: ChatAppearanceDto;
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

export interface GroupChatDto { name: string; members: string[] }

export interface ChatSummaryDto {
  group?: GroupChatDto;
  /** 相对 dataDir 的路径，作为唯一 id，如 "chats/Seraphina/2026-10-26@20h30m00s.jsonl" */
  id: string;
  character: string;
  title: string;
  messageCount: number;
  lastMessage: string;
  updatedAt: string;
  /** 用户重命名后的显示名（聊天 JSONL 的 chat_metadata._pitavernTitle）。 */
  displayName?: string;
  /** 置顶排序（chat_metadata._pitavernPinned）。 */
  pinned?: boolean;
  /** 归档后从主对话列表隐藏（chat_metadata._pitavernArchived）。 */
  archived?: boolean;
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

export interface ChatPageDto {
  messages: ChatMessageDto[];
  total: number;
  /** Exclusive message offset for the next older page. */
  before: number | null;
  revision: string;
}

export interface ReplyChoicesDto {
  userMessageId: string;
  selected: number;
  count: number;
}

/** 多分支树中的一个候选回复。 */
export interface BranchCandidateDto {
  index: number;
  /** 第一条回复正文的开头，用于选择器。 */
  preview: string;
  /** 该候选之后是否还保存着后续剧情。 */
  hasContinuation: boolean;
}

/** 沿当前活动分支列出的一个分叉回合（仅列出拥有多个候选的回合）。 */
export interface BranchPointDto {
  userMessageId: string;
  /** 第几个用户回合（从 1 开始）。 */
  turn: number;
  /** 用户消息预览。 */
  userPreview: string;
  selected: number;
  count: number;
  candidates: BranchCandidateDto[];
}

/** 从故事起点到某个分支选择的一条路径步骤。 */
export interface BranchPathStepDto {
  userMessageId: string;
  selected: number;
}

/** 完整分支目录中的一个候选路线节点。 */
export interface BranchTreeNodeDto {
  /** 稳定节点 ID（由完整选择路径决定）。 */
  id: string;
  /** 候选自身的持久化 ID；旧存档回退到完整路径 ID。 */
  branchId: string;
  parentId?: string;
  depth: number;
  /** 该分叉所在用户回合（从 1 开始）。 */
  turn: number;
  /** 默认标题，例如“第 8 轮 · 接受邀请”。 */
  title: string;
  /** 用户自定义名称。 */
  name?: string;
  note?: string;
  userPreview: string;
  assistantPreview: string;
  /** 该路线当前保存的最后一段剧情预览。 */
  preview: string;
  pathText: string;
  path: BranchPathStepDto[];
  pathIds: string[];
  pathLabels: string[];
  /** 直接下级分支选择数量。 */
  childCount: number;
  descendantCount: number;
  /** 该路线保存到的最后用户回合。 */
  totalTurns: number;
  /** 从该分叉到下一分叉之间合并显示的回合数。 */
  linearTurns: number;
  isActive: boolean;
  isCurrent: boolean;
  favorite: boolean;
  tags: string[];
  archived?: boolean;
  visitedAt?: string;
  children: BranchTreeNodeDto[];
}

export interface BranchIndexDto {
  revision: string;
  nodes: BranchTreeNodeDto[];
  total: number;
  truncated: boolean;
  currentNodeId?: string;
  activePath: string[];
}

export interface BranchMetaPatchDto {
  name?: string | null;
  note?: string | null;
  favorite?: boolean;
  archived?: boolean;
  tags?: string[];
}

export interface BranchSwitchResultDto {
  revision: string;
  index: BranchIndexDto;
}

export interface BranchPreviewDto {
  revision: string;
  nodeId: string;
  total: number;
  offset: number;
  messages: ChatMessageDto[];
  nextOffset: number | null;
}

export interface BranchSearchMatchDto {
  nodeId: string;
  snippet: string;
}

export interface BranchSearchDto {
  query: string;
  matches: BranchSearchMatchDto[];
  truncated: boolean;
  /** 下一页在扁平节点列表中的游标；null 表示已搜完。 */
  nextCursor: number | null;
}

export interface GreetingChoicesDto {
  selected: number;
  labels: string[];
}

export interface ChatBackupDto {
  id: string;
  createdAt: string;
  bytes: number;
}

export interface ChatBackupPreviewDto {
  backup: ChatBackupDto;
  messages: ChatMessageDto[];
  total: number;
  /** Current chat revision, checked again when restoring. */
  revision: string;
}

export interface ChatSnapshotDto {
  id: string;
  character: string;
  messages: ChatMessageDto[];
  running: boolean;
  streamingText: string;
  /** 当前生成请求的服务端开始时间；用于刷新/重连后继续计时。 */
  generationStartedAt?: string;
  group?: GroupChatDto;
  memberDisplays?: Record<string, ChatDisplayDto>;
  streamingCharacter?: string;
  stagedMessages?: ChatMessageDto[];
  /** 接管模式的状态投影（chat_metadata.projection） */
  projection?: string;
  page?: Omit<ChatPageDto, "messages">;
  replyChoices?: ReplyChoicesDto;
  /** 可来回切换的历史分支点（按回合顺序）。 */
  branchChoices?: BranchPointDto[];
  /** Card openings are selectable only before the first user turn. */
  greetingChoices?: GreetingChoicesDto;
  activity?: ChatActivityDto;
  activityError?: string;
  /** 渲染只读副本；不改变消息正文。 */
  display?: ChatDisplayDto;
  /** M4：当前聊天的世界快照/模板/能力；未初始化世界时缺省。 */
  world?: import("./world.ts").WorldChatStateDto;
}

export interface ChatDisplayDto {
  scripts: import("./regex.ts").RegexScript[];
  char: string;
  user: string;
  personaDescription?: string;
  variables?: Record<string, unknown>;
  lastUserMessage?: string;
}

export interface AuthorNoteDto {
  text: string;
  interval: number;
  depth: number;
  /** 0=故事之后，1=聊天深度，2=故事之前 */
  position: 0 | 1 | 2;
  role: "system" | "user" | "assistant";
}

export interface AuthorNoteSnapshotDto {
  note: AuthorNoteDto;
  revision: string;
  contextMode: "simple" | "bridge" | "takeover";
}

// ---------------------------------------------------------------- WS 协议

export type ClientMessage =
  | { type: "chat.send"; chatId: string; text: string; speakers?: string[] }
  | { type: "chat.regenerate"; chatId: string; messageId: string; expectedText: string; instruction?: string }
  | { type: "chat.abort"; chatId: string }
  | { type: "chat.sync"; chatId: string }
  | { type: "ping" };

export type ServerEvent =
  | { type: "library.changed" }
  | { type: "maintenance"; message: string; restartRequired: boolean }
  | { type: "hello"; version: string; maintenance?: string }
  | { type: "pong" }
  /** 本轮生成开始 */
  | { type: "chat.started"; chatId: string; message: ChatMessageDto; startedAt: string }
  | { type: "chat.regenerating"; chatId: string; startedAt: string }
  | { type: "chat.speaker"; chatId: string; character: string; stagedMessages: ChatMessageDto[] }
  /** Absolute persisted activity state; safe to replay after reconnect. */
  | { type: "chat.activity"; chatId: string; activity: ChatActivityDto }
  | { type: "chat.snapshot"; chatId: string; snapshot: ChatSnapshotDto; append?: boolean }
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

export type LibraryKind = "world" | "character-world" | "global-regex" | "preset-regex" | "character-regex";
export interface LibraryResourceDto { id: string; kind: LibraryKind; label: string }
export interface LibraryDocumentDto {
  resource: LibraryResourceDto;
  revision: string;
  /** Whole world file, character_book, or scripts array; unknown fields are round-tripped. */
  data: Record<string, unknown> | import("./regex.ts").RegexScript[];
}
export interface LibraryBackupPreviewDto {
  id: string;
  createdAt: string;
  files: number;
  bytes: number;
  counts: Record<string, number>;
  settings?: Pick<ConnectionDto, "persona" | "contextMode" | "activePreset" | "activeWorlds" | "worldInfo" | "outputProtocol" | "protocolStrict" | "compression" | "takeover" | "branches"> & { thinkingLevel: string; toolsEnabled: boolean };
}

export interface LibraryHistoryDto { id: string; createdAt: string; bytes: number; revision: string }
export interface LibraryHistoryPageDto { items: LibraryHistoryDto[]; before: string | null }
export interface LibraryHistoryPreviewDto { backup: LibraryHistoryDto; document: LibraryDocumentDto }

export interface LibraryBackupProgressDto {
  phase: "collecting" | "compressing" | "uploading" | "validating" | "restoring" | "committing" | "done";
  files: number; bytes: number; totalFiles?: number; totalBytes?: number;
}
export interface LibraryBackupJobDto {
  id: string; action: "export" | "import" | "restore";
  state: "running" | "succeeded" | "failed" | "cancelled";
  progress: LibraryBackupProgressDto; error?: string;
  preview?: LibraryBackupPreviewDto;
  restored?: { stDataDir: string; previousDataDir: string; restartRequired: true };
}
export interface LibraryBackupStorageDto {
  directory: string; bytes: number; files: number;
  items: { id: string; kind: "archive" | "import" | "incomplete"; bytes: number; files: number; modifiedAt: string; inUse: boolean }[];
}
