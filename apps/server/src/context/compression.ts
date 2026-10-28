import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { extractSummary } from "../agent/protocol/game-content.ts";

export interface CompressionConfig {
  enabled: boolean;
  /** 按用户发言划分轮次，工具调用不额外占一轮。 */
  keepFullTurns: number;
}

export interface CompressionResult {
  messages: AgentMessage[];
  stats: {
    triggered: boolean;
    originalChars: number;
    compressedChars: number;
    squashedMessages: number;
    squashedTurns: number;
    overBudget: boolean;
  };
}

/** 包含系统提示、工具声明/参数/结果的保守字符估算，并非模型 tokenizer。 */
export function contextChars(messages: AgentMessage[]): number {
  return messages.reduce((total, message) => {
    const { role, content, ...rest } = message as Message & Record<string, unknown>;
    return total + JSON.stringify({
      role, content, sections: rest.sections, toolsAdded: rest.toolsAdded,
      toolsRemoved: rest.toolsRemoved, toolCallId: rest.toolCallId, toolName: rest.toolName,
    }).length;
  }, 0);
}

export function inputBudgetChars(contextWindow: number, maxTokens: number): number {
  // 输出预留和 10% 余量在两种上下文模式中使用同一个预算。
  return Math.max(1, Math.floor((contextWindow - maxTokens) * 1.5 * 0.9));
}

const isConversation = (message: AgentMessage) =>
  message.role === "user" || message.role === "assistant" || message.role === "toolResult";

function completeToolGroups(messages: AgentMessage[]): boolean {
  const pending = new Set<string>();
  for (const message of messages) {
    if (message.role === "assistant") {
      for (const block of message.content) if (block.type === "toolCall") pending.add(block.id);
    } else if (message.role === "toolResult") {
      if (!pending.delete(message.toolCallId)) return false;
    }
  }
  return pending.size === 0;
}

function messageText(message: Message): string {
  if (typeof message.content === "string") return message.content;
  return message.content.filter((c): c is { type: "text"; text: string } => c.type === "text").map((c) => c.text).join("");
}

function squash(messages: AgentMessage[], keepFullTurns: number): Message {
  const parts = messages.flatMap((message) => {
    const raw = messageText(message);
    if (!raw) return [];
    const summary = extractSummary(raw);
    const body = summary ?? raw.slice(0, 300) + (raw.length > 300 ? "…" : "");
    const prefix = message.role === "user" ? "|用户|" : message.role === "toolResult" ? "|工具|" : "|游戏剧情|";
    return [`${prefix}${body}`];
  });
  return {
    role: "assistant",
    content: [{ type: "text", text: `【早期剧情已压缩（${messages.length} 条，近 ${keepFullTurns} 轮保留全文）】\n${parts.join("<|sep|>")}` }],
    api: "openai-completions", provider: "pitavern", model: "compressed",
    usage: {
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop", timestamp: "timestamp" in messages[0] ? messages[0].timestamp as number : Date.now(),
  };
}

/** 原位替换旧轮次，保留系统消息的位置和当前轮完整的工具调用链。 */
export function compressHistory(messages: AgentMessage[], config: CompressionConfig, budget: number,
  measure: (messages: AgentMessage[]) => number = contextChars): CompressionResult {
  const originalChars = contextChars(messages);
  const userStarts = messages.flatMap((message, index) => message.role === "user" ? [index] : []);
  const keepFullTurns = Math.max(1, Math.floor(config.keepFullTurns));
  const tailStart = userStarts.length > keepFullTurns ? userStarts[userStarts.length - keepFullTurns] : 0;
  const output: AgentMessage[] = [];
  let squashedMessages = 0;
  let squashedTurns = 0;
  if (config.enabled && measure(messages) > budget && tailStart > 0) {
    for (let i = 0; i < tailStart;) {
      if (!isConversation(messages[i])) {
        output.push(messages[i++]);
        continue;
      }
      const start = i;
      while (i < tailStart && isConversation(messages[i])) i++;
      const block = messages.slice(start, i);
      // 系统消息可能位于工具调用之间：这种块保持原样，不能遗留孤立的结果。
      if (completeToolGroups(block)) {
        const compacted = squash(block, keepFullTurns);
        if (measure([compacted]) < measure(block)) {
          output.push(compacted);
          squashedMessages += block.length;
          squashedTurns += block.filter((message) => message.role === "user").length;
          continue;
        }
      }
      output.push(...block);
    }
    output.push(...messages.slice(tailStart));
  }
  const result = squashedMessages ? output : messages;
  const compressedChars = contextChars(result);
  return {
    messages: result,
    stats: {
      triggered: squashedMessages > 0, originalChars, compressedChars, squashedMessages, squashedTurns,
      overBudget: measure(result) > budget,
    },
  };
}
