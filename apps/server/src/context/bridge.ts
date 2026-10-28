import type { Message } from "@earendil-works/pi-ai";
import type { StChatLine, CharacterCard } from "../stdata/types.ts";
import type { StPreset } from "./preset.ts";
import { resolveOrder } from "./preset.ts";
import type { WiEntry, WiScanResult } from "./worldinfo.ts";
import { scanWorldInfo } from "./worldinfo.ts";
import { substituteMacros, type MacroEnv } from "./macros.ts";
import { applyRegex, RegexPlacement, type RegexScript } from "./regex.ts";
import type { WorldInfoDecisionDto } from "@pitavern/shared";
import { readAuthorNote } from "./author-note.ts";

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
  useGroupScoring?: boolean;
  minActivations?: number;
  minActivationsDepthMax?: number;
  budgetTokens?: number;
  countTokens?: (content: string) => number;
  vectorMatches?: ReadonlySet<string>;
  /** 兼容旧调用方；预算统一由 Agent 压缩层处理。 */
  maxHistoryChars?: number;
  /** 计时效果状态（sticky/cooldown；可变对象，扫描内更新，调用方持久化） */
  timed?: import("./worldinfo.ts").TimedEffectsState;
  /** 当前消息总数（计时效果时间轴） */
  messageCount?: number;
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
  variables?: Record<string, unknown>;
  /** ST chat_metadata.note_* author note settings, when present. */
  metadata?: Record<string, unknown>;
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
  worldInfo: WorldInfoDecisionDto[];
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
    const text = applyRegex(substituteMacros(line.mes, env), scripts, { placement, depth, env });
    return { role: (line.is_user ? "user" : "assistant") as Piece["role"], text };
  });
}

/** 深度注入：depth 0 = 最新消息之后。返回注入后的列表 */
function injectAtDepth(history: Piece[], injections: { depth: number; role: "system" | "user" | "assistant"; text: string }[]): Piece[] {
  const result: Piece[] = [];
  // All depths refer to the original history, not a list shifted by earlier injections.
  for (let index = 0; index <= history.length; index++) {
    for (const inj of injections) {
      if (Math.max(0, history.length - Math.max(0, inj.depth)) === index) result.push({ role: inj.role, text: inj.text });
    }
    if (index < history.length) result.push(history[index]);
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
    variables: input.variables ?? {},
    lastUserMessage: [...chatLines].reverse().find((l) => l.is_user)?.mes,
  };

  // 世界书：内容先过宏与 WORLD_INFO 正则再入桶（扫描缓冲同样用宏替换后的历史）
  // 扫描需要看到 setvar 后的 getvar 文本，但预览不得修改本轮实际变量。
  const previewEnv = { ...env, variables: structuredClone(env.variables ?? {}) };
  const wi: WiScanResult = scanWorldInfo(worldEntries, historyPieces(chatLines, [], previewEnv).map((p) => p.text), {
    ...options,
    scanDepth: options.scanDepth,
    recursionSteps: options.recursionSteps,
    caseSensitive: options.caseSensitive,
    matchWholeWords: options.matchWholeWords,
    estimateContent: (content, entry) => applyRegex(substituteMacros(content, { ...previewEnv, variables: structuredClone(previewEnv.variables) }),
      regexScripts, { placement: RegexPlacement.WORLD_INFO, depth: entry.position === 4 ? entry.depth : null, env: previewEnv }),
    transformContent: (content, entry) => {
      const substituted = substituteMacros(content, env);
      return applyRegex(substituted, regexScripts, { placement: RegexPlacement.WORLD_INFO, depth: entry.position === 4 ? entry.depth : null, env });
    },
    ...(options.timed ? { timed: options.timed } : {}),
    ...(options.messageCount !== undefined ? { messageCount: options.messageCount } : {}),
  });
  // Outlet 内容只在扫描完成后提供。插入已处理的文本，不重复执行其中的写变量宏。
  const usedOutlets = new Set<string>();
  env.outlets = new Map([...wi.outlets].map(([name, texts]) => [name, texts.join("\n")]));
  env.onOutlet = (name) => { usedOutlets.add(name); };

  const promptsById = new Map(preset.prompts.map((p) => [p.identifier, p]));
  const order = resolveOrder(preset);
  const personalityFormat = preset.personality_format || "{{personality}}";
  const scenarioFormat = preset.scenario_format || "{{scenario}}";

  // 绝对深度注入（预设条目 + 世界书 atDepth）
  const absoluteInjections: { depth: number; role: "system" | "user" | "assistant"; text: string }[] = [];
  for (const inj of wi.atDepth) absoluteInjections.push({ depth: inj.depth, role: inj.role, text: inj.content });

  const authorNote = readAuthorNote(input.metadata ?? {});
  const noteInterval = authorNote.interval;
  const userCount = chatLines.filter((line) => line.is_user && !line.is_system).length;
  const noteEnabled = noteInterval > 0 && (noteInterval === 1 || (userCount > 0 && userCount % noteInterval === 0));
  const noteText = noteEnabled ? [
    ...wi.noteBefore,
    substituteMacros(authorNote.text, env),
    ...wi.noteAfter,
  ].filter(Boolean).join("\n") : "";
  const noteRole = authorNote.role;
  const notePosition = authorNote.position;
  if (noteText && notePosition === 1) absoluteInjections.push({
    depth: authorNote.depth, role: noteRole, text: noteText,
  });

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
          ? personalityFormat.replace(/\{\{personality\}\}/gi, () => card.personality) || null
          : null;
        break;
      case "scenario":
        text = card.scenario ? scenarioFormat.replace(/\{\{scenario\}\}/gi, () => card.scenario) || null : null;
        break;
      case "personaDescription":
        text = persona.description || null;
        break;
      case "dialogueExamples":
        text = [...wi.examplesBefore, substituteMacros(card.mesExample, env), ...wi.examplesAfter].filter(Boolean).join("\n") || null;
        break;
      default:
        text = null;
    }
    if (text) out.push({ role: "system", text: marker === "worldInfoBefore" || marker === "worldInfoAfter" || marker === "dialogueExamples" ? text : substituteMacros(text, env) });
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

  // 保留旧轮全文供统一压缩层提取摘要，不在组装阶段提前截断。
  let history = historyPieces(chatLines, regexScripts, env);
  history = injectAtDepth(history, absoluteInjections);

  // ST 语义：chatHistory 在 order 中出现的位置之前是 head、之后是 tail。
  // 猫神等预设把全部条目放在 chatHistory 之前，尾部条目自然进 tail。
  const note: Piece[] = noteText && (notePosition === 0 || notePosition === 2) ? [{ role: noteRole, text: noteText }] : [];
  const pieces = [...(notePosition === 2 ? note : []), ...head, ...(notePosition === 0 ? note : []), ...history, ...tail];
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

  const activeMarkers = new Set(order.filter((item) => item.enabled && promptsById.get(item.identifier)?.marker).map((item) => item.identifier));
  const worldInfo = wi.decisions.map((decision, index) => {
    if (decision.status !== "included") return decision;
    const position = worldEntries[index].position;
    if (position === 7) return usedOutlets.has(worldEntries[index].outletName!)
      ? { ...decision, reason: `Outlet ${worldEntries[index].outletName} 已引用` }
      : { ...decision, status: "skipped" as const, reason: `Outlet ${worldEntries[index].outletName} 未被提示词引用` };
    const missingMarker = (position === 0 && !activeMarkers.has("worldInfoBefore")) ||
      (position === 1 && !activeMarkers.has("worldInfoAfter")) ||
      ((position === 5 || position === 6) && !activeMarkers.has("dialogueExamples"));
    if (missingMarker) return { ...decision, status: "skipped" as const, reason: "预设未启用对应的插入位置" };
    if ((position === 2 || position === 3) && (!noteEnabled || ![0, 1, 2].includes(notePosition))) {
      return { ...decision, status: "skipped" as const, reason: "本轮未插入作者注释" };
    }
    return decision;
  });

  return {
    messages: toMessages(pieces),
    sampling,
    worldInfo,
    stats: {
      promptEntries,
      systemChars: pieces.filter((p) => p.role === "system").reduce((s, p) => s + p.text.length, 0),
      historyMessages: history.length,
      wiActivated: wi.activated.length,
      absoluteInjections: absoluteInjections.length,
    },
  };
}
