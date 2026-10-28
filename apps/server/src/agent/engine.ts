import { Agent } from "@earendil-works/pi-agent-core";
import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import type { Api, Message, Model, Models, SystemMessage, Usage } from "@earendil-works/pi-ai";
import type { BridgeSampling } from "../context/bridge.ts";
import type { CompressionConfig } from "../context/compression.ts";
import { compressHistory } from "../context/compression.ts";
import { createTokenCounter, inputBudget, measureContext, type TokenCounter } from "../context/tokens.ts";
import { INSTRUCT_TEMPLATES, type ContextAssemblyDto, type ContextDiagnosticsDto, type InstructTemplate } from "@pitavern/shared";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import { GAME_TOOL_NAME } from "./protocol/game-content.ts";
import type { CharacterCard, StChatLine } from "../stdata/types.ts";

const ZERO_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/**
 * M1 极简系统提示词（simple 模式）。bridge 模式下由组装器产出完整上下文。
 */
export function buildSystemPrompt(card: CharacterCard, persona: { name: string; description: string }): string {
  const parts: string[] = [];
  if (card.description) parts.push(card.description);
  if (card.personality) parts.push(`### 性格\n${card.personality}`);
  if (card.scenario) parts.push(`### 场景\n${card.scenario}`);
  if (card.systemPrompt) parts.push(`### 卡片附加指令\n${card.systemPrompt}`);
  parts.push(
    [
      "### 扮演规则",
      `- 你扮演 ${card.name}，与用户（${persona.name}）进行角色扮演。`,
      "- 以第三人称叙述 + 角色对白的混合文体回复，不要替用户行动或说话。",
      "- 保持人物设定与已有剧情的连贯性；输出使用中文。",
      persona.description ? `- 用户人设：${persona.description}` : "",
    ]
      .filter(Boolean)
      .join("\n"),
  );
  return parts.join("\n\n");
}

/** ST 聊天行 → pi 消息。is_system 行（划线/注释）不进上下文。 */
export function historyToAgentMessages(lines: StChatLine[]): Message[] {
  const messages: Message[] = [];
  for (const line of lines) {
    if (line.is_system || !line.mes.trim()) continue;
    if (line.is_user) {
      messages.push({ role: "user", content: line.mes, timestamp: Date.now() });
    } else {
      // 导入的历史没有真实 provider 元数据，填充占位字段以满足 AssistantMessage 结构
      messages.push({
        role: "assistant",
        content: [{ type: "text", text: line.mes }],
        api: "openai-completions",
        provider: "pitavern",
        model: "imported",
        usage: ZERO_USAGE,
        stopReason: "stop",
        timestamp: Date.now(),
      });
    }
  }
  return messages;
}

export interface TavernAgentOptions {
  models: Models;
  model: Model<Api>;
  templateNames?: { char: string; user: string };
  chatId: string;
  thinkingLevel: "off" | "low" | "medium" | "high";
  /** simple 模式：系统提示词 + 历史（不含本轮用户消息，配合 prompt()） */
  systemPrompt?: string;
  history?: Message[];
  /** bridge 模式：组装器产出的完整消息列表（含本轮用户消息，配合 continue()） */
  messages?: Message[];
  /** bridge 模式：预设采样参数 */
  sampling?: BridgeSampling;
  /** 酒馆工具四件套（M3） */
  tools?: AgentTool<any>[];
  /** M4 输出协议：game_tool 时透传 tool_choice=required */
  outputProtocol?: "native" | "game_tool";
  protocolStrict?: boolean;
  /** M4 历史压缩（transformContext 挂载） */
  compression?: CompressionConfig;
  tokenCounter?: TokenCounter;
  instruct?: InstructTemplate;
  contextAssembly?: ContextAssemblyDto;
  onContext?: (diagnostics: ContextDiagnosticsDto) => void;
}

/**
 * 构建酒馆 Agent：
 * - finishTurn 强制 {action:"end"}：一次用户输入 = 一回合回复，防自主循环（RP 延迟敏感）；
 * - sessionId=chatId：给支持会话缓存的网关做 prompt cache 命中；
 * - sampling 经 streamFn 包装透传（pi Agent 本身不携带采样参数）。
 */
export function createTavernAgent(options: TavernAgentOptions): Agent {
  const { sampling } = options;
  const maxTokens = sampling?.maxTokens ?? options.model.maxTokens;
  const budget = inputBudget(options.model.contextWindow || 128_000, maxTokens);
  const counter = options.tokenCounter ?? createTokenCounter(options.model.id);
  const textFormat = options.model.api === "openai-text-completions" ? {
    template: options.instruct ?? INSTRUCT_TEMPLATES.ChatML,
    names: options.templateNames ?? { char: "Assistant", user: "User" },
  } : undefined;
  const measure = (messages: AgentMessage[]) => measureContext(messages, counter, textFormat);
  let beforeTokens = 0;
  let compressedMessages = 0;
  let compressedTurns = 0;
  let request = 0;
  const strictToolChoice =
    options.outputProtocol === "game_tool" && options.protocolStrict !== false
      ? ({ tool_choice: "required" } as Record<string, unknown>)
      : undefined;
  const streamFn: typeof options.models.streamSimple = (model, context, streamOptions) => {
    const merged = {
      ...streamOptions,
      ...(sampling?.temperature !== undefined ? { temperature: sampling.temperature } : {}),
      ...(sampling?.maxTokens !== undefined ? { maxTokens: sampling.maxTokens } : {}),
      ...(sampling?.samplingParams || strictToolChoice || options.templateNames
        ? {
            samplingParams: {
              ...(streamOptions?.samplingParams ?? {}),
              ...sampling?.samplingParams,
              ...strictToolChoice,
              ...(model.api === "openai-text-completions" && options.templateNames
                ? { pitavern_char: options.templateNames.char, pitavern_user: options.templateNames.user } : {}),
            },
          }
        : {}),
    };
    const messages = normalizeContext(context).messages;
    const measured = measure(messages);
    const overBudget = measured.total > budget.inputBudget;
    options.onContext?.({
      request: ++request, tokenizer: counter.name, counting: counter.kind, ...budget,
      beforeTokens, afterTokens: measured.total, breakdown: measured.breakdown,
      compressedMessages, compressedTurns, keptMessages: messages.filter((message) => message.role !== "system").length,
      overBudget, assembly: options.contextAssembly ?? { mode: "simple", historyMessages: 0, omittedHistoryMessages: 0, worldInfo: [], worldInfoTotal: 0 },
    });
    if (overBudget) {
      throw new Error("上下文超过预留输出后的预算，请在活动面板查看诊断，减少保留轮数、精简角色/世界书，或检查模型上下文长度设置");
    }
    return options.models.streamSimple(model, context, merged);
  };

  const thinkingLevel = options.model.reasoning ? options.thinkingLevel : "off";
  const tools = options.tools ?? [];

  // bridge 模式：messages[0] 已是 system，工具声明须挂到首条 system 消息的 toolsAdded，
  // 否则 pi 的 createInitialSystemMessage 不会创建、模型看不到工具
  let initialMessages: AgentMessage[];
  if (options.messages !== undefined) {
    initialMessages = [...(options.messages as AgentMessage[])];
    if (tools.length > 0 && initialMessages[0]?.role === "system") {
      const first = initialMessages[0] as SystemMessage;
      initialMessages[0] = { ...first, toolsAdded: [...(first.toolsAdded ?? []), ...tools] };
    }
  } else {
    initialMessages = (options.history ?? []) as AgentMessage[];
  }

  const initialState =
    options.messages !== undefined
      ? { model: options.model, thinkingLevel, messages: initialMessages, tools }
      : { systemPrompt: options.systemPrompt ?? "", model: options.model, thinkingLevel, messages: initialMessages, tools };

  // 单回合 RP 语义：纯文本或 game_content 已产出正文即收尾；
  // 四件套工具回合续跑（查书/召回后续写）；MAX_TURNS 上限防失控。
  const MAX_TURNS = 10;
  let turnCount = 0;
  const compression = options.compression;

  return new Agent({
    initialState,
    streamFn,
    transformContext: async (messages) => {
      beforeTokens = measure(messages).total;
      const result = compressHistory(messages, compression ?? { enabled: false, keepFullTurns: 6 }, budget.inputBudget,
        (items) => measure(items).total);
      compressedMessages = result.stats.squashedMessages;
      compressedTurns = result.stats.squashedTurns;
      return result.messages;
    },
    finishTurn: async (turn) => {
      turnCount += 1;
      if (turnCount >= MAX_TURNS) return { action: "end" };
      const calledGameContent = turn.message.content.some(
        (c) => c.type === "toolCall" && c.name === GAME_TOOL_NAME,
      );
      if (calledGameContent) return { action: "end" };
      return turn.toolResults.length > 0 ? undefined : { action: "end" };
    },
    sessionId: options.chatId,
  });
}
