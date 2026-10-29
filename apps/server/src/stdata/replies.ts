import { createHash } from "node:crypto";
import type { BranchPointDto, ReplyChoicesDto } from "@pitavern/shared";
import type { StChatLine } from "./types.ts";

export const STATE_KEYS = ["variables", "projection", "timedWorldInfo", "_pitavernEnforcement"] as const;
export type RecallState = { turn: number; usedThisTurn: number; cooldownUntilTurn: number };
export interface ReplyVersion {
  /** 持久化的候选 ID；旧存档没有时由完整路径派生稳定 ID。 */
  branchId?: string;
  messages: StChatLine[];
  state?: Record<string, unknown>;
  enforcement?: RecallState;
  /**
   * 该候选分支之后的原始 JSONL 行（含换行前的空行）。只有该候选不在当前活动路径上时才写入；
   * 原样保存是为了让系统注释、损坏行和嵌套分支在来回切换时都不丢失。
   */
  continuation?: string[];
}
export interface ReplyVersions { selected: number; versions: ReplyVersion[] }

/** Single-message candidates also use ST's native swipes for portable JSONL exports. */
export function selectedMessages(catalog: ReplyVersions): StChatLine[] {
  const messages = structuredClone(catalog.versions[catalog.selected].messages);
  if (messages.length === 1 && catalog.versions.every((version) => version.messages.length === 1)) {
    messages[0].swipes = catalog.versions.map((version) => version.messages[0].mes);
    messages[0].swipe_id = catalog.selected;
    messages[0].swipe_info = catalog.versions.map(({ messages: [message] }) => ({
      ...(message.swipe_info?.[message.swipe_id ?? 0] ?? {}), extra: structuredClone(message.extra ?? {}),
    }));
  }
  return messages;
}

export function stateFields(metadata: Record<string, unknown>): Record<string, unknown> {
  return structuredClone(Object.fromEntries(STATE_KEYS.filter((key) => Object.hasOwn(metadata, key)).map((key) => [key, metadata[key]])));
}

export function restoreState(metadata: Record<string, unknown>, state?: Record<string, unknown>): Record<string, unknown> {
  const next = structuredClone(metadata);
  for (const key of STATE_KEYS) {
    if (state && Object.hasOwn(state, key)) next[key] = structuredClone(state[key]);
    else if (state || key !== "variables") delete next[key];
  }
  return next;
}

export function validEnforcement(value: unknown): value is RecallState {
  const v = value as RecallState;
  return Boolean(v && typeof v === "object" && [v.turn, v.usedThisTurn, v.cooldownUntilTurn].every((n) => Number.isInteger(n) && n >= 0));
}

export function validReplyCatalog(value: unknown): value is ReplyVersions {
  const saved = value as ReplyVersions | undefined;
  return Boolean(saved && Array.isArray(saved.versions) && saved.versions.length > 0 &&
    Number.isInteger(saved.selected) && saved.selected >= 0 && saved.selected < saved.versions.length &&
    saved.versions.every((v) => v && Array.isArray(v.messages) && v.messages.every((m) =>
      m && typeof m.mes === "string" && typeof m.name === "string" && !m.is_user && !m.is_system)));
}

/** 一条用户消息之后、下一条用户消息之前的助手/系统行。 */
function currentReplies(lines: StChatLine[], userIndex: number): StChatLine[] {
  let end = lines.length;
  for (let index = userIndex + 1; index < lines.length; index++) {
    if (lines[index].is_user && !lines[index].is_system) { end = index; break; }
  }
  return lines.slice(userIndex + 1, end).filter((line) => !line.is_user && !line.is_system);
}

function lineId(line: StChatLine, index: number): string {
  return typeof line.extra?.messageId === "string" ? line.extra.messageId : "line-" + index;
}

/**
 * 分支路径使用的消息 ID。旧 JSONL 没有 messageId 时不能用局部数组下标，
 * 否则 continuation 子源与完整文件里的 line-N 会指到不同回合；改用内容哈希。
 */
export function branchMessageId(line: StChatLine): string {
  if (typeof line.extra?.messageId === "string") return line.extra.messageId;
  return "legacy-" + createHash("sha256").update(JSON.stringify(line)).digest("hex").slice(0, 20);
}

function previewText(text: string, limit = 90): string {
  return text.replace(/\s+/g, " ").trim().slice(0, limit);
}

function previewLine(lines: StChatLine[]): string {
  const line = lines.find((message) => message.mes.trim()) ?? lines[0];
  return line ? previewText(line.mes) : "";
}

function savedCatalog(line: StChatLine): ReplyVersions | undefined {
  const saved = line.extra?._pitavernReplies;
  return validReplyCatalog(saved) ? structuredClone(saved) : undefined;
}

/**
 * 某个用户回合的候选回复目录。当前选中的版本始终以文件里的实际正文为准，
 * 这样外部编辑或旧版 swipes 导入后依然可以正确切换。
 */
export function turnReplies(lines: StChatLine[], metadata: Record<string, unknown>, userIndex: number): {
  userIndex: number; choices?: ReplyChoicesDto; catalog: ReplyVersions;
} {
  const user = lines[userIndex];
  const current = user ? currentReplies(lines, userIndex) : [];
  let catalog: ReplyVersions = { selected: 0, versions: [] };
  if (!user) return { userIndex, catalog };
  const saved = user.extra?._pitavernReplies as ReplyVersions | undefined;
  if (validReplyCatalog(saved)) {
    catalog = structuredClone(saved);
  } else if (current.length === 1 && Array.isArray(current[0].swipes) && current[0].swipes.length > 1 && current[0].swipes.every((s) => typeof s === "string")) {
    const line = current[0];
    const selected = Number.isInteger(line.swipe_id) && line.swipe_id! >= 0 && line.swipe_id! < line.swipes!.length ? line.swipe_id! : 0;
    catalog = { selected, versions: line.swipes!.map((text, index) => {
      const extra = { ...line.extra };
      delete extra.summary; delete extra.thinking; delete extra.protocol;
      return { messages: [{ ...structuredClone(line), mes: text, swipe_id: index, extra: { ...extra, ...line.swipe_info?.[index]?.extra } }] };
    }) };
  } else if (current.length) catalog = { selected: 0, versions: [{ messages: structuredClone(current) }] };
  if (current.length && catalog.versions.length) {
    catalog.versions[catalog.selected] = { ...catalog.versions[catalog.selected], messages: structuredClone(current), state: stateFields(metadata) };
  }
  return {
    userIndex, catalog,
    choices: {
      userMessageId: lineId(user, userIndex),
      selected: catalog.selected, count: catalog.versions.length,
    },
  };
}

export function replyChoices(lines: StChatLine[]): ReplyChoicesDto | undefined {
  const userIndex = lines.findLastIndex((line) => line.is_user && !line.is_system && line.mes.trim());
  const user = lines[userIndex];
  if (!user) return;
  const saved = user.extra?._pitavernReplies;
  const current = currentReplies(lines, userIndex);
  const swipes = current.length === 1 && current[0].swipes?.every((s) => typeof s === "string") ? current[0].swipes : undefined;
  const selected = swipes && Number.isInteger(current[0].swipe_id) && current[0].swipe_id! >= 0 && current[0].swipe_id! < swipes.length ? current[0].swipe_id! : 0;
  return {
    userMessageId: lineId(user, userIndex),
    selected: validReplyCatalog(saved) ? saved.selected : selected,
    count: validReplyCatalog(saved) ? saved.versions.length : swipes?.length || (current.length ? 1 : 0),
  };
}

/** Only the latest user turn is used for regeneration/retry decisions. */
export function lastReplies(lines: StChatLine[], metadata: Record<string, unknown>): {
  userIndex: number; choices?: ReplyChoicesDto; catalog: ReplyVersions;
} {
  const userIndex = lines.findLastIndex((line) => line.is_user && !line.is_system && line.mes.trim());
  return turnReplies(lines, metadata, userIndex);
}


export interface ParsedChatSource {
  source: string;
  raw: string[];
  records: { line: StChatLine; rawIndex: number }[];
  header: Record<string, unknown>;
  hasHeader: boolean;
}

/** 解析任意 JSONL 源；与 ChatStore.revision 使用相同规则，但不触碰磁盘。 */
export function parseChatSource(source: string): ParsedChatSource {
  const raw = source.split("\n");
  const records: { line: StChatLine; rawIndex: number }[] = [];
  let header: Record<string, unknown> = {};
  let hasHeader = false;
  raw.forEach((text, rawIndex) => {
    try {
      const obj = JSON.parse(text);
      if (obj && typeof obj.mes === "string" && typeof obj.name === "string") records.push({ line: obj, rawIndex });
      else if (rawIndex === 0 && obj && typeof obj === "object" && !Array.isArray(obj)) { header = obj; hasHeader = true; }
    } catch { /* Preserve unparseable lines verbatim. */ }
  });
  return { source, raw, records, header, hasHeader };
}

/**
 * 在内存中切换一个历史回合的候选；返回新的 JSONL 源，不写盘。
 * 多步跨层切换可以重复调用，最后只原子替换一次文件。
 */
export function selectReplySource(source: string, userMessageId: string, selected: number): string {
  const rev = parseChatSource(source);
  const metadata = (rev.header.chat_metadata ?? {}) as Record<string, unknown>;
  const lines = rev.records.map((record) => record.line);
  const userIndex = rev.records.findIndex(({ line }, index) => line.is_user && !line.is_system
    && (messageIdOf(line, index) === userMessageId || branchMessageId(line) === userMessageId));
  if (userIndex < 0) throw new Error("找不到对应的用户回合，请刷新后重试");
  const { catalog } = turnReplies(lines, metadata, userIndex);
  if (!Number.isInteger(selected) || selected < 0 || selected >= catalog.versions.length) throw new Error("候选回复不存在");
  if (selected === catalog.selected) return source;
  const userRecord = rev.records[userIndex];
  const nextUserPosition = rev.records.findIndex((record, index) => index > userIndex && record.line.is_user && !record.line.is_system);
  const turnEnd = nextUserPosition >= 0 ? nextUserPosition : rev.records.length;
  const turnEndRaw = nextUserPosition >= 0 ? rev.records[nextUserPosition].rawIndex : rev.raw.length;
  const replies = rev.records.slice(userIndex + 1, turnEnd).filter(({ line }) => !line.is_user && !line.is_system);
  const lastReply = replies.at(-1);
  // 离开当前候选前，把它后面的所有行（后续回合、系统注释、损坏行）原样收好。
  const continuation = lastReply ? rev.raw.slice(lastReply.rawIndex + 1).filter((line) => line.trim() !== "") : [];
  const current = catalog.versions[catalog.selected];
  catalog.versions[catalog.selected] = { ...current, messages: structuredClone(replies.map(({ line }) => line)), state: stateFields(metadata),
    ...(continuation.length ? { continuation } : { continuation: undefined }) };
  const fileCatalog = structuredClone(catalog);
  fileCatalog.selected = selected;
  // 即将生效的候选不再需要旧 continuation（写入文件后它就是活动路径）；先取出待恢复的原始行。
  const target = fileCatalog.versions[selected];
  const continuationRaw = (target.continuation ?? []).filter((line) => line.trim() !== "");
  target.continuation = undefined;
  const replyRaws = new Set(replies.map(({ rawIndex }) => rawIndex));
  const extras: string[] = [];
  for (let rawIndex = userRecord.rawIndex + 1; rawIndex < turnEndRaw; rawIndex++) {
    const raw = rev.raw[rawIndex];
    if (!replyRaws.has(rawIndex) && raw?.trim()) extras.push(raw);
  }
  const userLine = structuredClone(userRecord.line);
  userLine.extra = { ...userLine.extra, _pitavernReplies: fileCatalog };
  rev.header.chat_metadata = restoreState(metadata, target.state);
  const prefix = rev.raw.slice(0, userRecord.rawIndex);
  if (rev.hasHeader) prefix[0] = JSON.stringify(rev.header);
  else prefix.unshift(JSON.stringify(rev.header));
  return [
    ...prefix, JSON.stringify(userLine), ...extras,
    ...selectedMessages(fileCatalog).map((line) => JSON.stringify(line)), ...continuationRaw,
  ].join("\n").replace(/\n+$/, "") + "\n";
}

function messageIdOf(line: StChatLine, index: number): string {
  return typeof line.extra?.messageId === "string" ? line.extra.messageId : "line-" + index;
}

/**
 * 沿当前文件（活动路径）列出所有拥有多个候选的回合。
 * 更早回合的后续剧情保存在对应候选的 continuation 中；这里只统计当前路径上的分叉点。
 */
export function branchPoints(lines: StChatLine[]): BranchPointDto[] {
  const points: BranchPointDto[] = [];
  let turn = 0;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (!line.is_user || line.is_system || !line.mes.trim()) continue;
    turn += 1;
    const current = currentReplies(lines, index);
    const saved = savedCatalog(line);
    let previews: string[];
    let continuations: boolean[];
    let selected: number;
    if (saved) {
      selected = saved.selected;
      previews = saved.versions.map((version) => previewLine(version.messages));
      continuations = saved.versions.map((version, versionIndex) =>
        versionIndex !== selected && Boolean(version.continuation?.some((raw) => raw.trim())));
      if (current.length) previews[selected] = previewLine(current);
    } else if (current.length === 1 && Array.isArray(current[0].swipes) && current[0].swipes.length > 1 && current[0].swipes.every((s) => typeof s === "string")) {
      const swipes = current[0].swipes;
      selected = Number.isInteger(current[0].swipe_id) && current[0].swipe_id! >= 0 && current[0].swipe_id! < swipes.length ? current[0].swipe_id! : 0;
      previews = swipes.map((text) => previewText(text));
      continuations = swipes.map(() => false);
    } else {
      continue;
    }
    if (previews.length < 2) continue;
    points.push({
      userMessageId: lineId(line, index), turn, userPreview: previewText(line.mes), selected,
      count: previews.length,
      candidates: previews.map((preview, candidateIndex) => ({
        index: candidateIndex, preview, hasContinuation: continuations[candidateIndex] ?? false,
      })),
    });
  }
  return points;
}
