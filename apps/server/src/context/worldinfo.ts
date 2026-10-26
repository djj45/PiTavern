/**
 * ST 世界书扫描引擎（对照 public/scripts/world-info.js 的 M2 子集）。
 * 实现：常驻条目、主键匹配（正则/全词/子串 + 大小写选项）、二级键逻辑、
 * 递归扫描（excludeRecursion/preventRecursion/delayUntilRecursion）、概率门、
 * position 分桶（before/after/atDepth）。
 * 未实现（M4+）：sticky/cooldown/delay 计时效果、min activations、token 预算、向量条目。
 */

/** worlds/*.json 与卡内 character_book 归一化后的统一条目 */
export interface WiEntry {
  uid: string;
  key: string[];
  keysecondary: string[];
  content: string;
  constant: boolean;
  disabled: boolean;
  selective: boolean;
  /** 0=AND_ANY 1=NOT_ALL 2=NOT_ANY 3=AND_ALL */
  selectiveLogic: number;
  order: number;
  /** 0=before 1=after 2=ANTop 3=ANBottom 4=atDepth 5=EMTop 6=EMBottom */
  position: number;
  depth: number;
  role: "system" | "user" | "assistant";
  /** 0-100，100=必触发 */
  probability: number;
  caseSensitive?: boolean;
  matchWholeWords?: boolean;
  scanDepth?: number;
  excludeRecursion?: boolean;
  preventRecursion?: boolean;
  /** true=第 1 层递归起可用，数字=第 N 层起 */
  delayUntilRecursion?: boolean | number;
  /** 条目来源（去重/调试用） */
  world: string;
}

export interface WiScanOptions {
  /** 扫描最近 N 条消息（ST world_info_depth，默认 2） */
  scanDepth: number;
  /** 递归步数（ST world_info_max_recursion_steps，默认 0=关） */
  recursionSteps: number;
  caseSensitive: boolean;
  matchWholeWords: boolean;
  /** 内容经此函数转出（提示词层正则 WORLD_INFO placement 的挂点） */
  transformContent?: (content: string, entry: WiEntry) => string;
}

export interface WiDepthInjection {
  depth: number;
  role: "system" | "user" | "assistant";
  content: string;
}

export interface WiScanResult {
  /** position=0 条目，按 order 升序拼接 */
  before: string[];
  /** position=1/2/3/5/6 条目（AN/EM 类近似并入 after） */
  after: string[];
  /** position=4 的深度注入 */
  atDepth: WiDepthInjection[];
  activated: WiEntry[];
}

/** worlds/*.json 原始格式 { entries: { [uid]: {...} } } */
export function normalizeWorldFile(json: unknown, worldName: string): WiEntry[] {
  const entries = (json as { entries?: Record<string, Record<string, unknown>> })?.entries;
  if (!entries || typeof entries !== "object") return [];
  return Object.entries(entries).map(([uid, raw]) => normalizeEntry(uid, raw, worldName));
}

/** V2/V3 卡内 character_book（字段名与 world 文件不同） */
export function normalizeCardBook(book: unknown, worldName: string): WiEntry[] {
  const rawEntries = (book as { entries?: unknown[] })?.entries;
  if (!Array.isArray(rawEntries)) return [];
  return rawEntries.map((raw, index) => {
    const e = raw as Record<string, unknown>;
    const ext = (e.extensions as Record<string, unknown>) ?? {};
    const position =
      typeof ext.position === "number"
        ? ext.position
        : e.position === "after_char"
          ? 1
          : 0; /* before_char */
    return normalizeEntry(
      String(e.id ?? index),
      {
        key: e.keys,
        keysecondary: e.secondary_keys,
        content: e.content,
        constant: e.constant,
        disable: e.enabled === false,
        selective: e.selective,
        selectiveLogic: ext.selectiveLogic ?? e.selective_logic,
        order: e.insertion_order ?? ext.order,
        position,
        depth: ext.depth,
        role: ext.role,
        probability: ext.probability ?? e.probability,
        caseSensitive: ext.caseSensitive,
        matchWholeWords: ext.matchWholeWords,
        scanDepth: ext.scanDepth,
        excludeRecursion: ext.excludeRecursion,
        preventRecursion: ext.preventRecursion,
        delayed: e.delayed ?? ext.delayUntilRecursion,
        extensions: ext,
      },
      worldName,
    );
  });
}

function normalizeEntry(uid: string, raw: Record<string, unknown>, world: string): WiEntry {
  return {
    uid,
    world,
    key: Array.isArray(raw.key) ? raw.key.filter((k): k is string => typeof k === "string" && k.length > 0) : [],
    keysecondary: Array.isArray(raw.keysecondary)
      ? raw.keysecondary.filter((k): k is string => typeof k === "string" && k.length > 0)
      : [],
    content: typeof raw.content === "string" ? raw.content : "",
    constant: raw.constant === true,
    disabled: raw.disable === true || raw.disabled === true,
    selective: raw.selective !== false,
    selectiveLogic: typeof raw.selectiveLogic === "number" ? raw.selectiveLogic : 0,
    order: typeof raw.order === "number" ? raw.order : 100,
    position: typeof raw.position === "number" ? raw.position : 0,
    depth: typeof raw.depth === "number" ? raw.depth : 4,
    role: raw.role === "user" || raw.role === "assistant" ? raw.role : "system",
    probability: typeof raw.probability === "number" ? raw.probability : 100,
    caseSensitive: raw.caseSensitive === true,
    matchWholeWords: typeof raw.matchWholeWords === "boolean" ? raw.matchWholeWords : undefined,
    scanDepth: typeof raw.scanDepth === "number" ? raw.scanDepth : undefined,
    excludeRecursion: raw.excludeRecursion === true,
    preventRecursion: raw.preventRecursion === true,
    delayUntilRecursion: (raw.delayUntilRecursion ?? (raw as { delayed?: unknown }).delayed) as boolean | number | undefined,
  };
}

/** ST 语义：/pattern/flags 形式的键是正则 */
function parseKeyRegex(needle: string): RegExp | null {
  const match = /^\/(.+)\/([a-z]*)$/s.exec(needle);
  if (!match) return null;
  try {
    return new RegExp(match[1], match[2]);
  } catch {
    return null;
  }
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 对照 WorldInfoBuffer.matchKeys */
function matchKeys(haystack: string, needle: string, entry: WiEntry, opts: WiScanOptions): boolean {
  const keyRegex = parseKeyRegex(needle);
  if (keyRegex) return keyRegex.test(haystack);
  const caseSensitive = entry.caseSensitive ?? opts.caseSensitive;
  const hay = caseSensitive ? haystack : haystack.toLowerCase();
  const key = caseSensitive ? needle : needle.toLowerCase();
  const matchWholeWords = entry.matchWholeWords ?? opts.matchWholeWords;
  if (!matchWholeWords) return hay.includes(key);
  // 单词键用自定义边界（含标点）；多词键直接子串
  if (/\s/.test(key.trim())) return hay.includes(key);
  return new RegExp(`(?:^|\\W)(${escapeRegex(key)})(?:$|\\W)`).test(hay);
}

function secondaryLogicPasses(entry: WiEntry, haystack: string, opts: WiScanOptions): boolean {
  const logic = entry.selectiveLogic;
  let hasAny = false;
  let hasAll = true;
  for (const secondary of entry.keysecondary) {
    const matched = matchKeys(haystack, secondary, entry, opts);
    if (matched) hasAny = true;
    if (!matched) hasAll = false;
    if (logic === 0 && matched) return true; // AND_ANY
    if (logic === 1 && !matched) return true; // NOT_ALL
  }
  if (logic === 2 && !hasAny) return true; // NOT_ANY
  if (logic === 3 && hasAll && entry.keysecondary.length > 0) return true; // AND_ALL
  return false;
}

/** 递归延迟层级（true=1） */
function recursionDelayLevel(entry: WiEntry): number {
  if (entry.delayUntilRecursion === undefined || entry.delayUntilRecursion === false) return 0;
  if (entry.delayUntilRecursion === true) return 1;
  return Math.max(1, entry.delayUntilRecursion);
}

/**
 * 扫描入口。recentMessages 为从旧到新的消息文本（正则后的）。
 * 返回按 order 升序分桶后的结果。
 */
export function scanWorldInfo(entries: WiEntry[], recentMessages: string[], opts: WiScanOptions): WiScanResult {
  const enabled = entries.filter((e) => !e.disabled && e.content.trim().length > 0 && (e.key.length > 0 || e.constant));
  const activated = new Set<WiEntry>();
  const activatedContents: string[] = [];

  // 深度缓冲：scanDepth 条消息 + 递归内容（对照 WorldInfoBuffer.get）
  const chatBuffer = recentMessages.slice(-Math.max(1, opts.scanDepth)).join("\n");
  let recurseBuffer = "";

  const maxSteps = Math.max(1, opts.recursionSteps + 1); // +1: 首轮正常扫描
  for (let step = 0; step < maxSteps; step++) {
    const haystack = step === 0 ? chatBuffer : chatBuffer + "\n" + recurseBuffer;
    let newActivations = 0;

    for (const entry of enabled) {
      if (activated.has(entry)) continue;
      // 递归延迟：第 N 层递归起才可被激活（首轮为 step 0）
      if (step < recursionDelayLevel(entry)) continue;

      if (entry.constant) {
        activated.add(entry);
        newActivations++;
        continue;
      }
      if (entry.excludeRecursion && step > 0) continue;

      const scanText = entry.scanDepth
        ? recentMessages.slice(-entry.scanDepth).join("\n") + (step > 0 ? "\n" + recurseBuffer : "")
        : haystack;
      const primary = entry.key.some((k) => k.trim() && matchKeys(scanText, k.trim(), entry, opts));
      if (!primary) continue;

      if (entry.keysecondary.length > 0 && !secondaryLogicPasses(entry, scanText, opts)) continue;
      if (entry.probability < 100 && Math.random() * 100 >= entry.probability) continue;

      activated.add(entry);
      newActivations++;
    }

    if (newActivations === 0) break;
    // 新激活内容进入递归缓冲（preventRecursion 的不进）
    for (const entry of activated) {
      if (!entry.preventRecursion && !activatedContents.includes(entry.content)) {
        activatedContents.push(entry.content);
      }
    }
    recurseBuffer = activatedContents.join("\n");
  }

  // order 升序（对照 ST sortFn + unshift 的最终效果）
  const sorted = [...activated].sort((a, b) => a.order - b.order);
  const before: string[] = [];
  const after: string[] = [];
  const atDepth: WiDepthInjection[] = [];
  for (const entry of sorted) {
    const content = opts.transformContent ? opts.transformContent(entry.content, entry) : entry.content;
    if (!content) continue;
    switch (entry.position) {
      case 0:
        before.push(content);
        break;
      case 4:
        atDepth.push({ depth: entry.depth, role: entry.role, content });
        break;
      default:
        // 1=after；2/3 AN 顶/底、5/6 EM 顶/底近似并入 after（M2 简化）
        after.push(content);
        break;
    }
  }
  return { before, after, atDepth, activated: sorted };
}
