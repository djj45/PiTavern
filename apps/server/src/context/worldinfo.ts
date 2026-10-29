import type { WorldInfoDecisionDto } from "@pitavern/shared";

/**
 * ST 世界书扫描引擎（对照 public/scripts/world-info.js 的 M2 子集）。
 * 实现：常驻条目、主键匹配（正则/全词/子串 + 大小写选项）、二级键逻辑、
 * 递归扫描（excludeRecursion/preventRecursion/delayUntilRecursion）、概率门、
 * position 分桶（before/after/atDepth）。
 * 还支持计时效果、最少激活数扩展扫描、估算预算与向量检索候选。
 */

/** worlds/*.json 与卡内 character_book 归一化后的统一条目 */
export interface WiEntry {
  uid: string;
  key: string[];
  keysecondary: string[];
  content: string;
  constant: boolean;
  vectorized?: boolean;
  disabled: boolean;
  selective: boolean;
  /** 0=AND_ANY 1=NOT_ALL 2=NOT_ANY 3=AND_ALL */
  selectiveLogic: number;
  order: number;
  /** 0=before 1=after 2=ANTop 3=ANBottom 4=atDepth 5=EMTop 6=EMBottom 7=outlet */
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
  /** 计时效果（单位：消息数）——激活后免关键词保活 N 条 */
  sticky?: number;
  /** 计时效果——期间关键词命中也不激活（sticky 结束时自动进入） */
  cooldown?: number;
  /** 计时效果——聊天前 N 条消息内压制 */
  delay?: number;
  /** 逗号分隔的 inclusion groups。 */
  group?: string;
  groupOverride?: boolean;
  groupWeight?: number;
  useGroupScoring?: boolean;
  outletName?: string;
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
  useGroupScoring?: boolean;
  minActivations?: number;
  minActivationsDepthMax?: number;
  budgetTokens?: number;
  /** 由异步向量检索层提供；扫描器统一应用计时效果、概率与预算。 */
  vectorMatches?: ReadonlySet<string>;
  estimateContent?: (content: string, entry: WiEntry) => string;
  countTokens?: (content: string) => number;
  /** 内容经此函数转出（提示词层正则 WORLD_INFO placement 的挂点） */
  transformContent?: (content: string, entry: WiEntry) => string;
  /** 当前消息总数（计时效果的时间轴；缺省用 recentMessages.length） */
  messageCount?: number;
  /** 计时效果状态（可变对象：扫描内更新，调用方负责持久化） */
  timed?: TimedEffectsState;
}

export interface WiDepthInjection {
  depth: number;
  role: "system" | "user" | "assistant";
  content: string;
}

export interface WiScanResult {
  /** position=0 条目，按 order 升序拼接 */
  before: string[];
  /** position=1 条目 */
  after: string[];
  noteBefore: string[];
  noteAfter: string[];
  examplesBefore: string[];
  examplesAfter: string[];
  /** position=4 的深度注入 */
  atDepth: WiDepthInjection[];
  outlets: Map<string, string[]>;
  activated: WiEntry[];
  decisions: WorldInfoDecisionDto[];
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
        vectorized: ext.vectorized ?? e.vectorized,
        disable: e.enabled === false,
        selective: e.selective,
        selectiveLogic: ext.selectiveLogic ?? e.selective_logic,
        order: e.insertion_order ?? ext.order,
        position,
        depth: ext.depth,
        role: ext.role,
        probability: ext.probability ?? e.probability,
        useProbability: ext.useProbability ?? e.useProbability,
        caseSensitive: e.case_sensitive ?? ext.case_sensitive ?? ext.caseSensitive,
        matchWholeWords: ext.match_whole_words ?? ext.matchWholeWords,
        scanDepth: ext.scan_depth ?? ext.scanDepth,
        excludeRecursion: ext.exclude_recursion ?? ext.excludeRecursion,
        preventRecursion: ext.prevent_recursion ?? ext.preventRecursion,
        delayed: e.delayed ?? ext.delay_until_recursion ?? ext.delayUntilRecursion,
        sticky: (e.sticky ?? ext.sticky) as number | undefined,
        cooldown: (e.cooldown ?? ext.cooldown) as number | undefined,
        delay: (e.delay ?? ext.delay) as number | undefined,
        group: ext.group ?? e.group,
        groupOverride: ext.group_override ?? ext.groupOverride,
        groupWeight: ext.group_weight ?? ext.groupWeight,
        useGroupScoring: ext.use_group_scoring ?? ext.useGroupScoring,
        outletName: ext.outlet_name ?? ext.outletName,
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
    vectorized: raw.vectorized === true,
    disabled: raw.disable === true || raw.disabled === true,
    selective: raw.selective !== false,
    selectiveLogic: typeof raw.selectiveLogic === "number" ? raw.selectiveLogic : 0,
    order: typeof raw.order === "number" ? raw.order : 100,
    position: typeof raw.position === "number" ? raw.position : 0,
    depth: typeof raw.depth === "number" ? raw.depth : 4,
    role: raw.role === 1 || raw.role === "user" ? "user" : raw.role === 2 || raw.role === "assistant" ? "assistant" : "system",
    probability: raw.useProbability === false ? 100 : typeof raw.probability === "number" ? Math.max(0, Math.min(100, raw.probability)) : 100,
    caseSensitive: typeof raw.caseSensitive === "boolean" ? raw.caseSensitive : undefined,
    matchWholeWords: typeof raw.matchWholeWords === "boolean" ? raw.matchWholeWords : undefined,
    scanDepth: typeof raw.scanDepth === "number" ? raw.scanDepth : undefined,
    excludeRecursion: raw.excludeRecursion === true,
    preventRecursion: raw.preventRecursion === true,
    delayUntilRecursion: (raw.delayUntilRecursion ?? (raw as { delayed?: unknown }).delayed) as boolean | number | undefined,
    sticky: typeof raw.sticky === "number" ? raw.sticky : undefined,
    cooldown: typeof raw.cooldown === "number" ? raw.cooldown : undefined,
    delay: typeof raw.delay === "number" ? raw.delay : undefined,
    group: typeof raw.group === "string" ? raw.group : "",
    groupOverride: raw.groupOverride === true,
    groupWeight: typeof raw.groupWeight === "number" && Number.isFinite(raw.groupWeight) ? Math.max(0, raw.groupWeight) : 100,
    useGroupScoring: typeof raw.useGroupScoring === "boolean" ? raw.useGroupScoring : undefined,
    outletName: typeof raw.outletName === "string" ? raw.outletName.trim() : "",
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

// ---------------------------------------------------------------- 计时效果

/** 持久化形态（chat_metadata.timedWorldInfo，对照 ST 的 WITimedEffect） */
export interface TimedEffectRecord {
  start: number;
  end: number;
  /** sticky 结束时转入的 cooldown（当轮立即生效） */
  protected?: boolean;
}

export interface TimedEffectsState {
  sticky: Record<string, TimedEffectRecord>;
  cooldown: Record<string, TimedEffectRecord>;
}

export function emptyTimedState(): TimedEffectsState {
  return { sticky: {}, cooldown: {} };
}

/** 从 chat_metadata.timedWorldInfo 恢复（形状校验，坏数据重置为空） */
export function normalizeTimedState(raw: unknown): TimedEffectsState {
  const source = (raw && typeof raw === "object" ? raw : {}) as {
    sticky?: unknown;
    cooldown?: unknown;
  };
  const revive = (value: unknown): Record<string, TimedEffectRecord> => {
    if (!value || typeof value !== "object") return {};
    const out: Record<string, TimedEffectRecord> = {};
    for (const [key, record] of Object.entries(value as Record<string, unknown>)) {
      const r = record as Partial<TimedEffectRecord>;
      if (typeof r.start === "number" && typeof r.end === "number") {
        out[key] = { start: r.start, end: r.end, ...(r.protected ? { protected: true } : {}) };
      }
    }
    return out;
  };
  return { sticky: revive(source.sticky), cooldown: revive(source.cooldown) };
}

interface TimedFlags {
  isSticky: boolean;
  isCooldown: boolean;
}

/**
 * 计时效果引擎（对照 WorldInfoTimedEffects）：
 * - 过期清理（end <= messageCount）；sticky 过期且有 cooldown → 立即进入 protected cooldown
 * - 返回各条目的 sticky/cooldown 生效标记
 * 单位统一为消息数。
 */
function timedFlagsFor(entries: WiEntry[], state: TimedEffectsState, messageCount: number): Map<WiEntry, TimedFlags> {
  const flags = new Map<WiEntry, TimedFlags>();
  for (const type of ["sticky", "cooldown"] as const) {
    for (const [key, record] of Object.entries(state[type])) {
      if (messageCount >= record.end) {
        delete state[type][key];
        if (type === "sticky") {
          const entry = entries.find((e) => `${e.world}/${e.uid}` === key);
          // sticky 到期 → 若配置了 cooldown 则从当前消息数起算（protected：当轮即生效）
          if (entry?.cooldown) {
            state.cooldown[key] = { start: messageCount, end: messageCount + entry.cooldown, protected: true };
          }
        }
        continue;
      }
      const entry = entries.find((e) => `${e.world}/${e.uid}` === key);
      if (!entry) continue;
      flags.set(entry, {
        isSticky: type === "sticky" || flags.get(entry)?.isSticky || false,
        isCooldown: type === "cooldown" || flags.get(entry)?.isCooldown || false,
      });
    }
  }
  return flags;
}

/** 激活完成后记录新 sticky/cooldown 区间（对照 setTimedEffects） */
function recordTimedEffects(activated: Set<WiEntry>, state: TimedEffectsState, messageCount: number): void {
  for (const entry of activated) {
    const key = `${entry.world}/${entry.uid}`;
    if (entry.sticky && !state.sticky[key]) {
      state.sticky[key] = { start: messageCount, end: messageCount + entry.sticky };
    }
    if (entry.cooldown && !state.cooldown[key]) {
      state.cooldown[key] = { start: messageCount, end: messageCount + entry.cooldown };
    }
  }
}

// ---------------------------------------------------------------- 扫描

function groupNames(entry: WiEntry): string[] {
  return [...new Set((entry.group ?? "").split(",").map((name) => name.trim()).filter(Boolean))];
}

function groupScore(entry: WiEntry, text: string, opts: WiScanOptions): number {
  if (!entry.key.length) return 0;
  const primary = entry.key.filter((key) => key.trim() && matchKeys(text, key.trim(), entry, opts)).length;
  const secondary = entry.keysecondary.filter((key) => key.trim() && matchKeys(text, key.trim(), entry, opts)).length;
  return primary + (entry.selectiveLogic === 0 || (entry.selectiveLogic === 3 && secondary === entry.keysecondary.length) ? secondary : 0);
}

/** 先分组，再做概率与预算检查；同一轮已入选的组在递归和扩展扫描中保持占用。 */
function selectGroups(matches: Map<WiEntry, string>, activated: Set<WiEntry>, flags: Map<WiEntry, TimedFlags> | null,
  opts: WiScanOptions, skip: (entry: WiEntry, reason: string) => void): Set<WiEntry> {
  const remaining = new Set(matches.keys());
  const groups = new Map<string, WiEntry[]>();
  for (const entry of remaining) for (const name of groupNames(entry)) {
    groups.set(name, [...(groups.get(name) ?? []), entry]);
  }
  const occupied = new Set([...activated].flatMap(groupNames));
  const remove = (entry: WiEntry, reason: string) => { if (remaining.delete(entry)) skip(entry, reason); };
  for (const [name, members] of groups) {
    let eligible = members.filter((entry) => remaining.has(entry));
    if (!eligible.length) continue;
    if (occupied.has(name)) {
      for (const entry of eligible) remove(entry, `分组 ${name} 已有入选条目`);
      continue;
    }
    const sticky = eligible.filter((entry) => flags?.get(entry)?.isSticky);
    if (sticky.length) {
      // ST 的计时效果保留组内所有仍有效的 sticky，不重新抽签。
      for (const entry of eligible) if (!sticky.includes(entry)) remove(entry, `分组 ${name} 的 sticky 条目优先`);
      continue;
    }
    if (opts.useGroupScoring || eligible.some((entry) => entry.useGroupScoring)) {
      const scores = new Map(eligible.map((entry) => [entry, groupScore(entry, matches.get(entry)!, opts)]));
      const max = Math.max(...scores.values());
      for (const entry of eligible) if ((entry.useGroupScoring ?? opts.useGroupScoring) && scores.get(entry)! < max) {
        remove(entry, `分组 ${name} 的关键词得分较低`);
      }
      eligible = eligible.filter((entry) => remaining.has(entry));
    }
    if (eligible.length <= 1) continue;
    const overrides = eligible.filter((entry) => entry.groupOverride).sort((a, b) => b.order - a.order);
    let winner = overrides[0];
    if (!winner) {
      const total = eligible.reduce((sum, entry) => sum + (entry.groupWeight ?? 100), 0);
      let roll = Math.random() * total;
      for (const entry of eligible) {
        roll -= entry.groupWeight ?? 100;
        if (roll < 0) { winner = entry; break; }
      }
    }
    for (const entry of eligible) if (entry !== winner) remove(entry, winner
      ? `分组 ${name} ${overrides.length ? "优先级" : "权重"}择一未入选` : `分组 ${name} 没有正权重条目`);
  }
  return remaining;
}

/**
 * 扫描入口。recentMessages 为从旧到新的消息文本（正则后的）。
 * 返回按 order 升序分桶后的结果。
 */
export function scanWorldInfo(entries: WiEntry[], recentMessages: string[], opts: WiScanOptions): WiScanResult {
  const decisions = new Map(entries.map((entry) => [entry, {
    uid: entry.uid, world: entry.world, label: entry.key.join("、").slice(0, 80) || entry.uid,
    status: "skipped", reason: entry.disabled ? "已禁用" : !entry.content.trim() ? "内容为空"
      : !entry.key.length && !entry.constant && !entry.vectorized ? "没有匹配键" : "关键词或向量未命中",
  } as WorldInfoDecisionDto]));
  const skip = (entry: WiEntry, reason: string) => { decisions.get(entry)!.reason = reason; };
  const enabled = entries.filter((e) => {
    if (e.position === 7 && !e.outletName) { skip(e, "Outlet 名称为空"); return false; }
    return !e.disabled && e.content.trim().length > 0 && (e.key.length > 0 || e.constant || e.vectorized);
  });
  const activated = new Set<WiEntry>();
  const rejected = new Set<WiEntry>();

  // 计时效果（可选）：sticky 保活 / cooldown 压制 / delay 压制
  const timed = opts.timed;
  const messageCount = opts.messageCount ?? recentMessages.length;
  const flags = timed ? timedFlagsFor(enabled, timed, messageCount) : null;

  // 深度缓冲：scanDepth 条消息 + 递归内容（对照 WorldInfoBuffer.get）
  const initialDepth = Math.max(0, Math.floor(opts.scanDepth));
  const depthLimit = Math.max(initialDepth, opts.minActivationsDepthMax && opts.minActivationsDepthMax > 0
    ? Math.min(recentMessages.length, opts.minActivationsDepthMax) : recentMessages.length);
  const minActivations = Math.max(0, opts.minActivations ?? 0);
  const budget = opts.budgetTokens && opts.budgetTokens > 0 ? opts.budgetTokens : Infinity;
  let spent = 0;
  let budgetExceeded = false;
  const candidates = [...enabled].sort((a, b) =>
    Number(flags?.get(b)?.isSticky ?? false) - Number(flags?.get(a)?.isSticky ?? false) ||
    Number(b.constant) - Number(a.constant) || a.order - b.order);
  const activate = (entry: WiEntry, guaranteed: boolean): boolean => {
    if (!guaranteed && entry.probability < 100 && Math.random() * 100 >= entry.probability) {
      skip(entry, "概率未通过");
      rejected.add(entry);
      return false;
    }
    const content = opts.estimateContent?.(entry.content, entry) ?? entry.content;
    const tokens = opts.countTokens?.(content) ?? Math.ceil(content.length / 1.5);
    decisions.get(entry)!.tokens = tokens;
    if (spent + tokens > budget) {
      skip(entry, "超出世界书预算");
      budgetExceeded = true;
      rejected.add(entry);
      return false;
    }
    spent += tokens;
    activated.add(entry);
    return true;
  };
  const maxSteps = Math.max(1, opts.recursionSteps + 1); // +1: 首轮正常扫描
  for (let depth = initialDepth; depth <= depthLimit; depth++) {
    const chatBuffer = depth === 0 ? "" : recentMessages.slice(-depth).join("\n");
    let recurseBuffer = [...activated].filter((e) => !e.preventRecursion).map((e) => e.content).join("\n");
    for (let step = 0; step < maxSteps; step++) {
      const haystack = step === 0 ? chatBuffer : chatBuffer + "\n" + recurseBuffer;
      let newActivations = 0;
      const matches = new Map<WiEntry, string>();

      for (const entry of candidates) {
        if (activated.has(entry) || rejected.has(entry)) continue;

        const flag = flags?.get(entry);
        const isSticky = flag?.isSticky ?? false;
        // delay：聊天前 N 条消息内压制
        if (entry.delay && messageCount < entry.delay && !isSticky) { skip(entry, "尚未达到延迟消息数"); continue; }
        // cooldown：期间关键词命中也不激活（sticky 保活豁免）
        if (flag?.isCooldown && !isSticky) { skip(entry, "冷却中"); continue; }

        // 递归延迟：第 N 层递归起才可被激活（首轮为 step 0；sticky 豁免）
        if (step < recursionDelayLevel(entry) && !isSticky) { skip(entry, "尚未达到递归层级"); continue; }

        const scanText = entry.scanDepth !== undefined
          ? (entry.scanDepth === 0 ? "" : recentMessages.slice(-entry.scanDepth).join("\n")) + (step > 0 ? "\n" + recurseBuffer : "")
          : haystack;
        if (entry.constant) {
          matches.set(entry, scanText);
          continue;
        }
        if (entry.excludeRecursion && step > 0 && !isSticky) { skip(entry, "不参与递归扫描"); continue; }

        // sticky 保活：无需关键词（对照 "activated because active sticky"）
        if (isSticky) {
          matches.set(entry, scanText);
          continue;
        }

        const primary = (entry.vectorized && opts.vectorMatches?.has(worldEntryKey(entry))) ||
          entry.key.some((k) => k.trim() && matchKeys(scanText, k.trim(), entry, opts));
        if (!primary) { skip(entry, "关键词或向量未命中"); continue; }

        if (entry.selective && entry.keysecondary.length > 0 && !secondaryLogicPasses(entry, scanText, opts)) {
          skip(entry, "二级关键词条件未通过"); continue;
        }
        matches.set(entry, scanText);
      }

      for (const entry of selectGroups(matches, activated, flags, opts, skip)) {
        if (activate(entry, flags?.get(entry)?.isSticky ?? false)) newActivations++;
      }

      if (newActivations === 0) break;
      // 新激活内容进入递归缓冲（preventRecursion 的不进）
      recurseBuffer = [...activated].filter((e) => !e.preventRecursion).map((e) => e.content).join("\n");
    }
    if (activated.size >= minActivations || budgetExceeded) break;
  }

  if (timed) recordTimedEffects(activated, timed, messageCount);

  // order 升序，sticky 优先（对照 ST 排序）
  const sorted = [...activated].sort((a, b) => {
    const stickyDiff =
      (flags?.get(b) && flags.get(b)!.isSticky ? 1 : 0) - (flags?.get(a) && flags.get(a)!.isSticky ? 1 : 0);
    return stickyDiff || a.order - b.order;
  });
  const before: string[] = [];
  const after: string[] = [];
  const noteBefore: string[] = [], noteAfter: string[] = [], examplesBefore: string[] = [], examplesAfter: string[] = [];
  const atDepth: WiDepthInjection[] = [];
  const outlets = new Map<string, string[]>();
  for (const entry of sorted) {
    const content = opts.transformContent ? opts.transformContent(entry.content, entry) : entry.content;
    const decision = decisions.get(entry)!;
    if (!content) { skip(entry, "替换后内容为空"); continue; }
    decision.status = "included";
    decision.reason = flags?.get(entry)?.isSticky ? "sticky 保活" : entry.constant ? "常驻条目"
      : entry.vectorized && opts.vectorMatches?.has(worldEntryKey(entry)) ? "向量命中" : "关键词命中";
    switch (entry.position) {
      case 0:
        before.push(content);
        break;
      case 4:
        atDepth.push({ depth: entry.depth, role: entry.role, content });
        break;
      case 1: after.push(content); break;
      case 2: noteBefore.push(content); break;
      case 3: noteAfter.push(content); break;
      case 5: examplesBefore.push(content); break;
      case 6: examplesAfter.push(content); break;
      case 7: {
        const name = entry.outletName!;
        outlets.set(name, [content, ...(outlets.get(name) ?? [])]);
        break;
      }
      default: decision.status = "skipped"; decision.reason = "尚不支持此注入位置"; break;
    }
  }
  return { before, after, noteBefore, noteAfter, examplesBefore, examplesAfter, atDepth, outlets, activated: sorted, decisions: [...decisions.values()] };
}

export function worldEntryKey(entry: WiEntry): string {
  return JSON.stringify([entry.world, entry.uid]);
}
