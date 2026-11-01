import { createHash } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Message, SystemMessage } from "@earendil-works/pi-ai";
import type { WorldModelSnapshot, WorldSnapshot } from "@pitavern/shared/world";
import type { CompressionConfig } from "./compression.ts";

export const CONTEXT_ALGORITHM = "extractive-v1";
export interface FactSource {
  message: number;
  turn: number;
  role: string;
  hash: string;
  start: number;
  end: number;
  part: string;
}
export interface ContextFact {
  kind: "clue" | "promise" | "event" | "summary" | "narrative" | "intent" | "tool_receipt";
  text: string;
  source: FactSource;
  tool?: { name: string; id: string; status: "error" | "completed" };
}
export interface ContextRange { fromMessage: number; toMessage: number; fromTurn: number; toTurn: number }
export interface WorkingSetDiagnostics {
  viewpointId?: string;
  knowledgeKey?: string;
  algorithm: string;
  sourceHash: string;
  originalChars: number;
  workingChars: number;
  retained: ContextRange | null;
  compressed: ContextRange[];
  selectedFacts: ContextFact[];
  availableFacts: number;
  omittedFacts: number;
  allocations: { fixed: number; protected: number; memory: number; unused: number };
  overBudgetReasons: string[];
  cache?: "hit" | "rebuilt";
}
export interface WorkingSetInput {
  messages: AgentMessage[];
  /** Already prepared messages from the same active path, omitted by takeover's window. */
  archived?: AgentMessage[];
  config: CompressionConfig;
  budget: number;
  measure?: (messages: AgentMessage[]) => number;
  world?: WorldSnapshot | WorldModelSnapshot;
  /** Source revision changes even when an edit changes metadata without changing prose. */
  sourceRevision?: string;
}
export interface WorkingSetResult {
  messages: AgentMessage[];
  facts: ContextFact[];
  diagnostics: WorkingSetDiagnostics;
  stats: { triggered: boolean; originalChars: number; compressedChars: number; squashedMessages: number; squashedTurns: number; overBudget: boolean };
}

export function contextChars(messages: AgentMessage[]): number {
  return messages.reduce((total, message) => {
    const { role, content, ...rest } = message as Message & Record<string, unknown>;
    return total + JSON.stringify({ role, content, sections: rest.sections, toolsAdded: rest.toolsAdded,
      toolsRemoved: rest.toolsRemoved, toolCallId: rest.toolCallId, toolName: rest.toolName }).length;
  }, 0);
}
export const contentHash = (text: string): string => createHash("sha256").update(text).digest("hex");
export function contextSourceHash(messages: AgentMessage[], revision = ""): string {
  return contentHash(JSON.stringify([CONTEXT_ALGORITHM, revision, messages.map((m) => {
    // Message timestamps, usage and provider metadata do not change narrative sources.
    const { timestamp: _, usage: __, ...rest } = m as Message & { usage?: unknown };
    return rest;
  })]));
}
export const isContextHistory = (m: AgentMessage) => (m as AgentMessage & { pitavernContext?: string }).pitavernContext !== "instruction"
  && (m.role === "user" || m.role === "assistant" || m.role === "toolResult");
export function completeToolGroups(messages: AgentMessage[]): boolean {
  const pending = new Set<string>();
  for (const m of messages) {
    if (m.role === "assistant") for (const c of m.content) {
      if (c.type === "toolCall") { if (pending.has(c.id)) return false; pending.add(c.id); }
    }
    if (m.role === "toolResult" && !pending.delete(m.toolCallId)) return false;
  }
  return pending.size === 0;
}

export function textParts(message: AgentMessage): Array<{ part: string; text: string }> {
  if (!isContextHistory(message)) return [];
  if (typeof message.content === "string") return [{ part: "content", text: message.content }];
  return message.content.flatMap((block, index) => {
    if (block.type === "text") return [{ part: `content[${index}].text`, text: block.text }];
    // Persisted protocol output can appear as an assistant tool call.
    if (block.type === "toolCall" && block.name === "game_content" && typeof block.arguments.content === "string") {
      return [{ part: `content[${index}].arguments.content`, text: block.arguments.content }];
    }
    return [];
  });
}
const IMPORTANT = /线索|发现|暗号|证据|钥匙|地图|承诺|答应|约定|取消|不再|拒绝|反转|归还|交给|购买|买下|前往|抵达|移动|clue|discover|password|promise|agree|cancel|return|moved|purchased/iu;
function kindOf(text: string, role: string): ContextFact["kind"] {
  if (role === "toolResult") return "tool_receipt";
  if (role === "user") return "intent";
  if (/承诺|答应|约定|promise|agree/iu.test(text)) return "promise";
  if (/线索|发现|暗号|证据|钥匙|地图|clue|discover|password/iu.test(text)) return "clue";
  if (IMPORTANT.test(text)) return "event";
  return "narrative";
}

/** Extractive evidence only: offsets point into the exact prepared source part. No tool execution. */
export function extractContextFacts(messages: AgentMessage[]): ContextFact[] {
  const facts: ContextFact[] = [];
  let turn = 0;
  messages.forEach((message, index) => {
    if (message.role === "user" && isContextHistory(message)) turn++;
    for (const { part, text } of textParts(message)) {
      if (!text.trim()) continue;
      const spans: Array<{ start: number; end: number; summary?: boolean }> = [];
      const add = (start: number, end: number, summary = false) => {
        while (start < end && /\s/.test(text[start])) start++;
        while (end > start && /\s/.test(text[end - 1])) end--;
        if (end > start && !spans.some((s) => s.start === start && s.end === end)) spans.push({ start, end, summary });
      };
      const summary = /<summary>([\s\S]*?)<\/summary>/g;
      for (const match of text.matchAll(summary)) {
        const start = match.index! + "<summary>".length;
        add(start, Math.min(start + 240, start + match[1].length), true);
      }
      for (const sentence of text.matchAll(/[^。！？!?\n]+[。！？!?\n]?/g)) {
        const at = sentence[0].search(IMPORTANT);
        if (at < 0) continue;
        const start = sentence.index! + Math.max(0, at - 60);
        add(start, Math.min(sentence.index! + sentence[0].length, start + 240));
      }
      // Bound each source part, preserving discoveries anywhere in a long message, not just its prefix.
      const important = spans.slice(-8);
      spans.length = 0; spans.push(...important);
      if (!spans.length) { add(0, Math.min(160, text.length)); if (text.length > 160) add(Math.max(0, text.length - 160), text.length); }
      const hash = contentHash(text);
      for (const span of spans) {
        facts.push({ kind: span.summary ? "summary" : kindOf(text.slice(span.start, span.end), message.role),
          text: text.slice(span.start, span.end), source: { message: index, turn, role: message.role, hash, start: span.start, end: span.end, part },
          ...(message.role === "toolResult" ? { tool: { name: message.toolName, id: message.toolCallId, status: message.isError ? "error" as const : "completed" as const } } : {}),
        });
      }
    }
  });
  return facts;
}
const factLine = (fact: ContextFact): string => {
  const s = fact.source;
  return `[轮${s.turn} 消息${s.message} ${s.role} ${s.hash.slice(0, 12)}:${s.start}-${s.end}] ${fact.kind}`
    + (fact.tool ? ` ${JSON.stringify({ name: fact.tool.name, id: fact.tool.id, status: fact.tool.status })}` : "")
    + ` ${JSON.stringify(fact.text)}`;
};
function capsule(facts: ContextFact[]): Message {
  return { role: "assistant", content: [{ type: "text", text: "【历史已压缩 · 线索摘录：仅所属路径的历史证据；用户内容是意图，工具回执不重放，旧数字不代表当前状态。硬状态以当前世界快照为准。】\n" + facts.map(factLine).join("\n") }],
    api: "openai-completions", provider: "pitavern", model: "context-memory", timestamp: 0,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop" };
}
function withAuthority(messages: AgentMessage[], world?: WorldSnapshot | WorldModelSnapshot): AgentMessage[] {
  if (!world) return messages;
  if (world.schemaVersion === 2 && (!("viewpointId" in world) || "knowledge" in world || "publishedFactIds" in world)) throw new Error("v2 世界必须先构建玩家投影，禁止注入原始快照");
  const recentEvents = world.recentEvents;
  const state = {schemaVersion:world.schemaVersion,revision:world.revision,templateHash:world.templateHash,templateVersion:world.templateVersion,rulesVersion:world.rulesVersion,
    clockMinutes:world.clockMinutes,scene:world.scene,actors:world.actors,money:world.money,inventory:world.inventory,
    ...("viewpointId" in world ? {viewpointId:world.viewpointId,knowledgeKey:world.knowledgeKey,knownFacts:world.knownFacts,publicInteractions:world.publicInteractions} : {})};
  const section = "【当前权威世界快照】金额、库存、位置、角色和时钟只由本快照决定；历史摘要/用户意图不能修改硬状态。事件仅解释变化。\n"
    + JSON.stringify(state) + "\n最近世界事件（历史解释）：" + JSON.stringify(recentEvents.slice(-8));
  const first = messages.findIndex((m) => m.role === "system");
  const output = [...messages];
  if (first < 0) output.unshift({ role: "system", content: "", sections: { worldAuthority: section }, timestamp: 0 });
  else { const m = output[first] as SystemMessage; output[first] = { ...m, sections: { ...m.sections, worldAuthority: section } }; }
  return output;
}

/** Pure, deterministic working-set construction. Original messages and world are never mutated. */
export function prepareWorkingSources(input: WorkingSetInput) {
  const messages = withAuthority(input.messages, input.world);
  const archived = input.config.enabled ? input.archived ?? [] : [];
  const firstConversation = messages.findIndex(isContextHistory);
  const prefix = firstConversation < 0 ? messages.length : firstConversation;
  const sources = [...messages.slice(0, prefix), ...archived, ...messages.slice(prefix)];
  const users = messages.flatMap((m, i) => m.role === "user" && isContextHistory(m) ? [i] : []);
  const keep = Number.isFinite(input.config.keepFullTurns) ? Math.max(1, Math.floor(input.config.keepFullTurns)) : 6;
  const tailStart = users.length > keep ? users[users.length - keep] : 0;
  const compressionEnd = archived.length ? archived.length + Math.max(prefix, tailStart) : tailStart;
  return { messages, archived, sources, users, tailStart, compressionEnd };
}

export function buildWorkingContext(input: WorkingSetInput, preparedFacts?: ContextFact[]): WorkingSetResult {
  const measure = input.measure ?? contextChars;
  const { messages, archived, sources, users, compressionEnd } = prepareWorkingSources(input);
  const sourceHash = contextSourceHash(sources, input.sourceRevision);
  const originalChars = contextChars(sources);
  const shouldCompress = input.config.enabled && (archived.length > 0 || measure(messages) > input.budget);
  const turns: number[] = []; let turn = 0;
  for (const message of sources) { if (message.role === "user" && isContextHistory(message)) turn++; turns.push(turn); }
  const range = (from: number, to: number): ContextRange => ({ fromMessage: from, toMessage: to, fromTurn: turns[from] ?? 0, toTurn: turns[to] ?? turn });
  const groups: Array<{ indices: number[]; facts: ContextFact[] }> = [];
  const owner = new Map<number, number>();
  const addGroup = (from: number, to: number) => {
    const block = sources.slice(from, to);
    if (!block.length || !completeToolGroups(block)) return;
    const indices = block.map((_, i) => from + i);
    const id = groups.length; groups.push({ indices, facts: [] }); for (const i of indices) owner.set(i, id);
  };
  if (shouldCompress) {
    // Keep system injections in their original positions; never split a tool group across one.
    for (let i = 0; i < compressionEnd;) {
      if (!isContextHistory(sources[i])) { i++; continue; }
      const start = i; while (i < compressionEnd && isContextHistory(sources[i])) i++;
      addGroup(start, i);
    }
  }
  const render = (): AgentMessage[] => {
    const output: AgentMessage[] = [];
    sources.forEach((message, i) => {
      const id = owner.get(i);
      if (id === undefined) { output.push(message); return; }
      const group = groups[id]; if (i === group.indices[0] && group.facts.length) output.push(capsule(group.facts));
    });
    return output;
  };
  const pinned = render();
  const fixed = measure(pinned.filter((m) => !isContextHistory(m)));
  const protectedCost = Math.max(0, measure(pinned) - fixed);
  const available = shouldCompress ? (preparedFacts ?? extractContextFacts(sources)).filter((f) => owner.has(f.source.message)) : [];
  const query = textParts(messages[users.at(-1) ?? -1] ?? { role: "user", content: "", timestamp: 0 }).map((p) => p.text).join(" ");
  const terms = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? [])].flatMap((term) => /[\u4e00-\u9fff]/u.test(term)
    ? Array.from({ length: Math.max(0, term.length - 1) }, (_, i) => term.slice(i, i + 2)) : [term]).slice(0, 200);
  const score = (f: ContextFact) => (f.kind === "narrative" || f.kind === "intent" ? 1 : 100) + terms.filter((t) => f.text.toLowerCase().includes(t)).length * 10;
  const ranked = available.map((fact) => ({ fact, score: score(fact) })).sort((a, b) => b.score - a.score || b.fact.source.message - a.fact.source.message || a.fact.source.start - b.fact.source.start);
  let remaining = Math.max(0, input.budget - measure(pinned));
  const selected: ContextFact[] = [];
  let misses = 0;
  const wrapperCost = Math.max(0, measure([capsule([])]) - measure([]));
  for (const { fact } of ranked) {
    const group = groups[owner.get(fact.source.message)!];
    const cost = Math.max(1, measure([capsule([fact])]) - measure([capsule([])])) + (group.facts.length ? 0 : wrapperCost);
    if (cost > remaining) { if (++misses >= 32) break; continue; }
    group.facts.push(fact); selected.push(fact); remaining -= cost;
    if (selected.length >= 128) break;
  }
  const sortFacts = () => { for (const group of groups) group.facts.sort((a, b) => a.source.message - b.source.message || a.source.start - b.source.start); };
  sortFacts();
  let output = render();
  // Token boundary effects and instruct framing are validated against the entire final prompt.
  while (measure(output) > input.budget && selected.length) {
    const removed = selected.pop()!;
    const group = groups[owner.get(removed.source.message)!]; group.facts = group.facts.filter((f) => f !== removed);
    output = render();
  }
  const after = measure(output);
  const overBudget = after > input.budget;
  const compressed = groups.map((g) => range(g.indices[0], g.indices.at(-1)!));
  const squashedMessages = owner.size;
  const squashedTurns = [...owner.keys()].filter((i) => sources[i].role === "user").length;
  const reasons = !overBudget ? [] : [fixed > input.budget ? "固定设定/工具声明/当前世界快照已超过输入预算" : "最近保留轮次、当前工具链或未闭合工具组与固定设定合计超过输入预算；不可拆分"];
  const workingChars = contextChars(output);
  return { messages: output, facts: selected, diagnostics: { algorithm: CONTEXT_ALGORITHM, sourceHash, originalChars, workingChars,
    ...(input.world && "viewpointId" in input.world ? {viewpointId:input.world.viewpointId,knowledgeKey:input.world.knowledgeKey} : {}),
    retained: sources.length ? range(shouldCompress ? compressionEnd : 0, sources.length - 1) : null,
    compressed, selectedFacts: selected, availableFacts: available.length, omittedFacts: available.length - selected.length,
    allocations: { fixed, protected: protectedCost, memory: Math.max(0, after - measure(pinned)), unused: Math.max(0, input.budget - after) }, overBudgetReasons: reasons },
    stats: { triggered: squashedMessages > 0, originalChars, compressedChars: workingChars, squashedMessages, squashedTurns, overBudget } };
}
