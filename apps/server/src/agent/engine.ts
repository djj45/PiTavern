import { Agent } from "@earendil-works/pi-agent-core";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Message, Model, Models, Usage } from "@earendil-works/pi-ai";
import type { BridgeSampling } from "../context/bridge.ts";
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
  model: Model<"openai-completions">;
  chatId: string;
  thinkingLevel: "off" | "low" | "medium" | "high";
  /** simple 模式：系统提示词 + 历史（不含本轮用户消息，配合 prompt()） */
  systemPrompt?: string;
  history?: Message[];
  /** bridge 模式：组装器产出的完整消息列表（含本轮用户消息，配合 continue()） */
  messages?: Message[];
  /** bridge 模式：预设采样参数 */
  sampling?: BridgeSampling;
}

/**
 * 构建酒馆 Agent：
 * - finishTurn 强制 {action:"end"}：一次用户输入 = 一回合回复，防自主循环（RP 延迟敏感）；
 * - sessionId=chatId：给支持会话缓存的网关做 prompt cache 命中；
 * - sampling 经 streamFn 包装透传（pi Agent 本身不携带采样参数）。
 */
export function createTavernAgent(options: TavernAgentOptions): Agent {
  const { sampling } = options;
  const streamFn: typeof options.models.streamSimple = (model, context, streamOptions) => {
    const merged = {
      ...streamOptions,
      ...(sampling?.temperature !== undefined ? { temperature: sampling.temperature } : {}),
      ...(sampling?.maxTokens !== undefined ? { maxTokens: sampling.maxTokens } : {}),
      ...(sampling?.samplingParams
        ? { samplingParams: { ...(streamOptions?.samplingParams ?? {}), ...sampling.samplingParams } }
        : {}),
    };
    return options.models.streamSimple(model, context, merged);
  };

  const thinkingLevel = options.model.reasoning ? options.thinkingLevel : "off";
  const initialState =
    options.messages !== undefined
      ? {
          model: options.model,
          thinkingLevel,
          messages: options.messages as AgentMessage[],
        }
      : {
          systemPrompt: options.systemPrompt ?? "",
          model: options.model,
          thinkingLevel,
          messages: (options.history ?? []) as AgentMessage[],
        };

  return new Agent({
    initialState,
    streamFn,
    finishTurn: async () => ({ action: "end" }),
    sessionId: options.chatId,
  });
}
