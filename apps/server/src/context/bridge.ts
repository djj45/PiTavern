import type { Message } from "@earendil-works/pi-ai";
import type { StChatLine, CharacterCard } from "../stdata/types.ts";
import type { StPreset } from "./preset.ts";
import { resolveOrder } from "./preset.ts";
import type { WiEntry, WiScanResult } from "./worldinfo.ts";
import { scanWorldInfo } from "./worldinfo.ts";
import { substituteMacros, type MacroEnv } from "./macros.ts";
import { applyRegex, RegexPlacement, type RegexScript } from "./regex.ts";

const ZERO_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

export interface BridgeOptions {
  scanDepth: number;
  recursionSteps: number;
  caseSensitive: boolean;
  matchWholeWords: boolean;
  /** 历史部分的粗略字符预算（M4 的 token 级压缩会取代它） */
  maxHistoryChars: number;
}

export interface BridgeInput {
  preset: StPreset;
  card: CharacterCard;
  persona: { name: string; description: string };
  /** 全量历史（含本轮尾部的用户消息，正则前原文） */
  chatLines: StChatLine[];
  /** 合并后的世界书条目（全局世界 + 卡内书） */
  worldEntries: WiEntry[];
  /** 预设携带的 regex_scripts */
  regexScripts: RegexScript[];
  options: BridgeOptions;
}

export interface BridgeSampling {
  temperature?: number;
  maxTokens?: number;
  samplingParams?: Record<string, number>;
}

export interface AssembledContext {
  /** 组装好的完整消息列表（首条应为 system；末条为本轮用户消息） */
  messages: Message[];
  sampling: BridgeSampling;
  stats: {
    promptEntries: number;
    systemChars: number;
    historyMessages: number;
    wiActivated: number;
    absoluteInjections: number;
  };
}

/** 单条提示词/历史项的中间表示 */
interface Piece {
  role: "system" | "user" | "assistant";
  text: string;
}

/** 把 ST 行映射成提示词侧消息（宏替换 + 角色正则与深度门控；ST 同样对历史消息做宏替换） */
function historyPieces(lines: StChatLine[], scripts: RegexScript[], env: MacroEnv): Piece[] {
  const usable = lines.filter((l) => !l.is_system && l.mes.trim().length > 0);
  return usable.map((line, index) => {
    const depth = usable.length - 1 - index; // 0=最新
    const placement = line.is_user ? RegexPlacement.USER_INPUT : RegexPlacement.AI_OUTPUT;
    const text = applyRegex(substituteMacros(line.mes, env), scripts, { placement, depth });
    return { role: (line.is_user ? "user" : "assistant") as Piece["role"], text };
  });
}

/** 深度注入：depth 0 = 最新消息之后。返回注入后的列表 */
function injectAtDepth(history: Piece[], injections: { depth: number; role: "system" | "user" | "assistant"; text: string }[]): Piece[] {
  const result = [...history];
  // 同 depth 按声明顺序插入；大 depth 先插避免索引漂移
  const sorted = [...injections].sort((a, b) => b.depth - a.depth);
  for (const inj of sorted) {
    const index = Math.max(0, result.length - inj.depth);
    result.splice(index, 0, { role: inj.role, text: inj.text });
  }
  return result;
}

function toMessages(pieces: Piece[]): Message[] {
  const now = Date.now();
  return pieces.map<Message>((p, i) => {
    if (p.role === "user") {
      return { role: "user", content: p.text, timestamp: now + i };
    }
    if (p.role === "system") {
      return { role: "system", content: p.text, timestamp: now + i };
    }
    return {
      role: "assistant",
      content: [{ type: "text", text: p.text }],
      api: "openai-completions",
      provider: "pitavern",
      model: "imported",
      usage: ZERO_USAGE,
      stopReason: "stop",
      timestamp: now + i,
    };
  });
}

/**
 * 桥接组装器：复刻 ST Chat Completion 的 populateChatCompletion 核心语义。
 * prompt_order 顺序遍历 → marker 填充 / 普通条目按 role 输出 / 绝对深度条目
 * 注入历史 → 世界书 before/after/atDepth 注入 → 宏替换（两级：条目内容与键）。
 */
export function assembleBridgeContext(input: BridgeInput): AssembledContext {
  const { preset, card, persona, chatLines, worldEntries, regexScripts, options } = input;

  const env: MacroEnv = {
    char: card.name,
    user: persona.name,
    personaDescription: persona.description,
    variables: {},
    lastUserMessage: [...chatLines].reverse().find((l) => l.is_user)?.mes,
  };

  // 世界书：内容先过宏与 WORLD_INFO 正则再入桶（扫描缓冲同样用宏替换后的历史）
  const wi: WiScanResult = scanWorldInfo(worldEntries, historyPieces(chatLines, [], env).map((p) => p.text), {
    scanDepth: options.scanDepth,
    recursionSteps: options.recursionSteps,
    caseSensitive: options.caseSensitive,
    matchWholeWords: options.matchWholeWords,
    transformContent: (content) => {
      const substituted = substituteMacros(content, env);
      return applyRegex(substituted, regexScripts, { placement: RegexPlacement.WORLD_INFO, depth: null });
    },
  });

  const promptsById = new Map(preset.prompts.map((p) => [p.identifier, p]));
  const order = resolveOrder(preset);
  const personalityFormat = preset.personality_format || "{{personality}}";
  const scenarioFormat = preset.scenario_format || "{{scenario}}";

  // 绝对深度注入（预设条目 + 世界书 atDepth）
  const absoluteInjections: { depth: number; role: "system" | "user" | "assistant"; text: string }[] = [];
  for (const inj of wi.atDepth) absoluteInjections.push({ depth: inj.depth, role: inj.role, text: inj.content });

  const head: Piece[] = []; // chatHistory 之前的条目
  const tail: Piece[] = []; // chatHistory 之后的条目
  let promptEntries = 0;

  const emitMarker = (marker: string, out: Piece[]): string | null => {
    let text: string | null = null;
    switch (marker) {
      case "worldInfoBefore":
        text = wi.before.join("\n") || null;
        break;
      case "worldInfoAfter":
        text = wi.after.join("\n") || null;
        break;
      case "charDescription":
        text = card.description || null;
        break;
      case "charPersonality":
        text = card.personality
          ? substituteMacros(personalityFormat.replace(/\{\{personality\}\}/gi, card.personality), env) || null
          : null;
        break;
      case "scenario":
        text = card.scenario ? substituteMacros(scenarioFormat.replace(/\{\{scenario\}\}/gi, card.scenario), env) || null : null;
        break;
      case "personaDescription":
        text = persona.description || null;
        break;
      case "dialogueExamples":
        text = card.mesExample ? substituteMacros(card.mesExample, env) || null : null;
        break;
      default:
        text = null;
    }
    if (text) out.push({ role: "system", text });
    return text;
  };

  let sawHistory = false;
  for (const item of order) {
    if (!item.enabled) continue;
    const prompt = promptsById.get(item.identifier);
    if (!prompt) continue;

    if (prompt.marker) {
      if (item.identifier === "chatHistory") {
        sawHistory = true;
        continue;
      }
      if (item.identifier === "dialogueExamples") {
        emitMarker("dialogueExamples", sawHistory ? tail : head);
        promptEntries++;
        continue;
      }
      emitMarker(item.identifier, sawHistory ? tail : head);
      promptEntries++;
      continue;
    }

    const content = substituteMacros(prompt.content ?? "", env);
    if (!content.trim()) continue;
    promptEntries++;

    // 绝对深度注入：不占位，插入历史
    if (prompt.injection_position === 1) {
      absoluteInjections.push({ depth: prompt.injection_depth ?? 4, role: prompt.role, text: content });
      continue;
    }
    (sawHistory ? tail : head).push({ role: prompt.role, text: content });
  }

  // 历史：全量行 → 宏+正则 → 深度注入 → 预算裁剪（从旧端截断）
  let history = historyPieces(chatLines, regexScripts, env);
  const historyChars = history.reduce((sum, p) => sum + p.text.length, 0);
  if (historyChars > options.maxHistoryChars) {
    let kept = 0;
    const cut = [...history].reverse().findIndex((p) => {
      kept += p.text.length;
      return kept > options.maxHistoryChars;
    });
    history = cut === -1 ? history : history.slice(history.length - Math.max(1, cut));
  }
  history = injectAtDepth(history, absoluteInjections);

  // ST 语义：chatHistory 在 order 中出现的位置之前是 head、之后是 tail。
  // 猫神等预设把全部条目放在 chatHistory 之前，尾部条目自然进 tail。
  const pieces = [...head, ...history, ...tail];
  // 首条必须 system（pi Agent 以 system 消息开头重放提示词）
  if (pieces.length === 0 || pieces[0].role !== "system") {
    pieces.unshift({ role: "system", text: `You are ${card.name}.` });
  }

  const sampling: BridgeSampling = {};
  if (typeof preset.temperature === "number") sampling.temperature = preset.temperature;
  if (typeof preset.openai_max_tokens === "number") sampling.maxTokens = preset.openai_max_tokens;
  const sp: Record<string, number> = {};
  for (const key of ["top_p", "top_k", "min_p", "frequency_penalty", "presence_penalty", "repetition_penalty"] as const) {
    const value = preset[key];
    if (typeof value === "number") sp[key] = value;
  }
  if (Object.keys(sp).length > 0) sampling.samplingParams = sp;

  return {
    messages: toMessages(pieces),
    sampling,
    stats: {
      promptEntries,
      systemChars: pieces.filter((p) => p.role === "system").reduce((s, p) => s + p.text.length, 0),
      historyMessages: history.length,
      wiActivated: wi.activated.length,
      absoluteInjections: absoluteInjections.length,
    },
  };
}
