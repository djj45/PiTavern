import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { getCurrentSystemPrompt, getCurrentTools, toToolDeclaration } from "@earendil-works/pi-ai/utils/transcript";
import { Tiktoken } from "js-tiktoken/lite";
import cl100k from "js-tiktoken/ranks/cl100k_base";
import o200k from "js-tiktoken/ranks/o200k_base";
import type { ContextDiagnosticsDto, InstructTemplate, TokenizerSetting } from "@pitavern/shared";
import { renderInstruct } from "./instruct.ts";

const encoders = new Map<string, Tiktoken>();
export interface TokenCounter {
  name: string;
  kind: "tokenizer" | "estimate";
  count(text: string): number;
}

/** Unknown/custom model names deliberately fall back; aliases can select an encoding in settings. */
export function createTokenCounter(modelId: string, setting: TokenizerSetting = "auto"): TokenCounter {
  let encoding = setting;
  if (encoding === "auto") {
    const id = modelId.replace(/^openai\//, "");
    if (/^(gpt-4o|gpt-4\.1|gpt-5|o1|o3|o4)(-|$)/.test(id)) encoding = "o200k_base";
    else if (/^(gpt-4|gpt-3\.5-turbo)(-|$)/.test(id)) encoding = "cl100k_base";
    else encoding = "estimate";
  }
  if (encoding !== "cl100k_base" && encoding !== "o200k_base") {
    return { name: "字符 / UTF-8 估算", kind: "estimate",
      count: (text) => Math.max(Math.ceil(text.length / 1.5), Math.ceil(Buffer.byteLength(text, "utf8") / 3)) };
  }
  let encoder = encoders.get(encoding);
  if (!encoder) { encoder = new Tiktoken(encoding === "cl100k_base" ? cl100k : o200k); encoders.set(encoding, encoder); }
  const tokenizer = encoder;
  const cache = new Map<string, number>();
  return { name: encoding, kind: "tokenizer", count: (text) => {
    const found = cache.get(text);
    if (found !== undefined) return found;
    // Treat template-looking text as ordinary input, not an instruction to the tokenizer.
    const count = tokenizer.encode(text, [], []).length;
    if (text.length < 50_000) {
      if (cache.size >= 256) cache.delete(cache.keys().next().value!);
      cache.set(text, count);
    }
    return count;
  } };
}

export function inputBudget(contextWindow: number, maxTokens: number) {
  const remaining = Math.max(0, contextWindow - maxTokens);
  const safetyMargin = Math.ceil(remaining * 0.1);
  return { contextWindow, outputReserved: maxTokens, safetyMargin, inputBudget: Math.max(0, remaining - safetyMargin) };
}

export interface TokenMeasurement {
  total: number;
  breakdown: ContextDiagnosticsDto["breakdown"];
}

/** Count the replayed prompt and tool declarations once. API framing remains an estimate. */
export function measureContext(messages: AgentMessage[], counter: TokenCounter,
  text?: { template: InstructTemplate; names: { char: string; user: string } }): TokenMeasurement {
  const system = counter.count(getCurrentSystemPrompt(messages));
  const conversation = messages.filter((message) => message.role !== "system").reduce((total, message) => {
    const m = message as Message;
    if (typeof m.content === "string") return total + counter.count(m.content);
    return total + m.content.reduce((sum, block) => sum + counter.count(block.type === "text" ? block.text
      : block.type === "toolCall" ? JSON.stringify({ name: block.name, arguments: block.arguments })
      : block.type === "thinking" ? block.thinking : ""), 0)
      + (m.role === "toolResult" ? counter.count(m.toolCallId + m.toolName) : 0);
  }, 0);
  if (text) {
    const total = counter.count(renderInstruct(messages as Message[], text.template, text.names).prompt);
    const systemPart = Math.min(system, total);
    const conversationPart = Math.min(conversation, total - systemPart);
    return { total, breakdown: { system: systemPart, conversation: conversationPart, tools: 0,
      framing: total - systemPart - conversationPart } };
  }
  const declarations = getCurrentTools(messages).map(toToolDeclaration);
  const tools = declarations.length ? counter.count(JSON.stringify(declarations)) + 12 : 0;
  const framing = (messages.filter((message) => message.role !== "system").length + (system ? 1 : 0)) * 8 + 3;
  return { total: system + conversation + tools + framing, breakdown: { system, conversation, tools, framing } };
}
