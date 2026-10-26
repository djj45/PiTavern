import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { extractSummary } from "../agent/protocol/game-content.ts";

export interface CompressionConfig {
  enabled: boolean;
  /** 尾部保留全文的轮数（一轮 = 用户+剧情） */
  keepFullTurns: number;
}

const SEPARATOR = "<|sep|>";
const USER_PREFIX = "|用户|";
const STORY_PREFIX = "|游戏剧情|";
/** 无 summary 的旧消息保留的头部字符数 */
const KEEP_HEAD_CHARS = 300;

export interface CompressionResult {
  messages: AgentMessage[];
  stats: {
    triggered: boolean;
    originalChars: number;
    compressedChars: number;
    squashedMessages: number;
  };
}

/**
 * 历史压缩（transformContext 实现，取代猫神 ChatSquash + 小总结 hack）：
 * - 尾部 keepFullTurns 轮保留全文；
 * - 更早的消息：有 <summary> 只留摘要，无摘要保留头部截断；
 * - 压缩块合并为单条 assistant 消息（|用户| / |游戏剧情| 轮次标记，<|sep|> 分隔）。
 * 只影响送上游的上下文；UI 与 JSONL 落库永远全文。
 */
export function compressHistory(messages: AgentMessage[], config: CompressionConfig, budgetChars: number): CompressionResult {
  const isHistory = (m: AgentMessage) => m.role === "user" || m.role === "assistant";
  const leading = messages.filter((m) => !isHistory(m));
  const history = messages.filter(isHistory) as Message[];

  const originalChars = history.reduce((sum, m) => sum + messageText(m).length, 0);
  if (!config.enabled || originalChars <= budgetChars) {
    return {
      messages,
      stats: { triggered: false, originalChars, compressedChars: originalChars, squashedMessages: 0 },
    };
  }

  const keepCount = Math.max(2, config.keepFullTurns * 2);
  // 尾部至少留 2 条；从头压缩
  const oldMessages = history.slice(0, Math.max(0, history.length - keepCount));
  const tail = history.slice(Math.max(0, history.length - keepCount));
  if (oldMessages.length === 0) {
    return {
      messages,
      stats: { triggered: false, originalChars, compressedChars: originalChars, squashedMessages: 0 },
    };
  }

  const parts: string[] = [];
  for (const message of oldMessages) {
    const raw = messageText(message);
    const summary = extractSummary(raw);
    const body = summary ?? raw.slice(0, KEEP_HEAD_CHARS) + (raw.length > KEEP_HEAD_CHARS ? "…" : "");
    parts.push(`${message.role === "user" ? USER_PREFIX : STORY_PREFIX}${body}`);
  }

  const squashed: Message = {
    role: "assistant",
    content: [{ type: "text", text: `【早期剧情已压缩（${parts.length} 条，近 ${config.keepFullTurns} 轮保留全文）】\n${parts.join(SEPARATOR)}` }],
    api: "openai-completions",
    provider: "pitavern",
    model: "compressed",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: oldMessages[0] && "timestamp" in oldMessages[0] ? (oldMessages[0].timestamp as number) : Date.now(),
  };

  const compressed = [...leading.slice(0, 1), squashed, ...leading.slice(1), ...tail] as AgentMessage[];
  const compressedChars = messageText(squashed).length + tail.reduce((sum, m) => sum + messageText(m).length, 0);
  return {
    messages: compressed,
    stats: { triggered: true, originalChars, compressedChars, squashedMessages: oldMessages.length },
  };
}

function messageText(message: Message): string {
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content)) {
    return message.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("");
  }
  return "";
}
