import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type {
  ChatImportIssueCode,
  ChatImportIssueDto,
  ChatImportPreviewDto,
  ChatImportResultDto,
  ChatImportWorldPreviewDto,
} from "@pitavern/shared";
import { WORLD_STATE_KEY, WORLD_TEMPLATES_KEY } from "@pitavern/shared/world";
import { WorldState, WorldValidationError, parseWorldSnapshot } from "../world/index.ts";
import { worldTemplateName } from "../world/catalog.ts";
import { readGroup } from "./groups.ts";
import { atomicWrite } from "./files.ts";
import type { CharacterStore } from "./characters.ts";
import type { ChatStore } from "./chats.ts";
import type { StChatLine } from "./types.ts";
import { branchPoints } from "./replies.ts";
import { buildBranchIndex } from "./branch-index.ts";

/** Upload / service limits are part of the public import contract (docs/CHAT_IMPORT.md). */
export const CHAT_IMPORT_MAX_BYTES = 32 * 1024 * 1024;
export const CHAT_IMPORT_MAX_LINES = 200_000;
export const CHAT_IMPORT_MAX_JSON_DEPTH = 512;
export const CHAT_IMPORT_MAX_BRANCH_DEPTH = 64;
export const CHAT_IMPORT_MAX_BRANCH_NODES = 10_000;
export const CHAT_IMPORT_MAX_ISSUES = 50;

type JsonObject = Record<string, unknown>;

interface WorldReference {
  value: unknown;
  line?: number;
  path: string;
}

interface ParseState {
  errors: ChatImportIssueDto[];
  issueCount: number;
  warnings: string[];
  warningSet: Set<string>;
  snapshots: WorldReference[];
  nodeCount: number;
  nodeLimitExceeded: boolean;
  hiddenMessages: number;
  hiddenContinuations: number;
  userNames: Set<string>;
  assistantNames: Set<string>;
  group?: { name: string; members: string[] };
  headerMetadata: JsonObject;
  headerTitle?: string;
  detectedCharacter?: string;
}

export interface ChatImportRecord {
  line: StChatLine;
  rawIndex: number;
}

export interface ParsedChatImport {
  sha256: string;
  bytes: number;
  source: string;
  /** 保留原始行（CRLF 已归一化为 LF）；导入时只替换头部。 */
  raw: string[];
  header: JsonObject;
  hasHeader: boolean;
  headerIndex: number | null;
  metadata: JsonObject;
  records: ChatImportRecord[];
  preview: ChatImportPreviewDto;
}

function isPlainObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function previewText(value: string, limit = 120): string {
  return value.replace(/\s+/g, " ").trim().slice(0, limit);
}

function safeFileName(raw: string): string {
  const base = raw.replace(/\\/g, "/").split("/").pop() ?? "";
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 200);
  return cleaned || "chat.jsonl";
}

function issue(state: ParseState, code: ChatImportIssueCode, message: string, line?: number, fieldPath?: string): void {
  state.issueCount += 1;
  if (state.errors.length >= CHAT_IMPORT_MAX_ISSUES) return;
  state.errors.push({
    code,
    ...(line !== undefined ? { line } : {}),
    ...(fieldPath ? { path: fieldPath } : {}),
    message,
  });
}

function warn(state: ParseState, message: string): void {
  if (state.warningSet.has(message)) return;
  state.warningSet.add(message);
  state.warnings.push(message);
}

interface InspectResult {
  /** 首个超深字段路径；没有超深时为空。 */
  depthPath?: string;
  /** 不允许作为对象键的字段（当前只有 __proto__）。 */
  unsafeKey?: string;
}

/** 迭代遍历，避免恶意深嵌套在 JSON.parse 之后继续递归耗尽调用栈。 */
function inspectJson(value: unknown, fieldPath: string): InspectResult {
  const stack: Array<{ value: unknown; depth: number; path: string }> = [{ value, depth: 1, path: fieldPath }];
  while (stack.length) {
    const current = stack.pop()!;
    if (current.depth > CHAT_IMPORT_MAX_JSON_DEPTH) return { depthPath: current.path || "根" };
    if (Array.isArray(current.value)) {
      for (let index = current.value.length - 1; index >= 0; index--) {
        stack.push({ value: current.value[index], depth: current.depth + 1, path: current.path + "[" + index + "]" });
      }
    } else if (isPlainObject(current.value)) {
      for (const key of Object.keys(current.value)) {
        if (key === "__proto__") return { unsafeKey: current.path ? current.path + "." + key : key };
        stack.push({ value: current.value[key], depth: current.depth + 1, path: current.path ? current.path + "." + key : key });
      }
    }
  }
  return {};
}

function worldErrorText(error: unknown): string {
  if (error instanceof WorldValidationError) {
    const detail = error.issues.slice(0, 3).map((entry) => (entry.path ? entry.path + ": " : "") + entry.message).join("；");
    return detail ? error.message + "（" + detail + "）" : error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

function addWorldReference(state: ParseState, value: unknown, line: number | undefined, fieldPath: string): void {
  if (value === undefined) return;
  state.snapshots.push({ value, line, path: fieldPath });
}

function validateEnforcement(value: unknown, line: number, fieldPath: string, state: ParseState): void {
  if (!isPlainObject(value)) {
    issue(state, "structure", fieldPath + " 必须是对象", line, fieldPath);
    return;
  }
  for (const key of ["turn", "usedThisTurn", "cooldownUntilTurn"]) {
    const number = value[key];
    if (!Number.isInteger(number) || (number as number) < 0) {
      issue(state, "structure", fieldPath + "." + key + " 必须是非负整数", line, fieldPath + "." + key);
    }
  }
}

function validateBeforeTurn(value: unknown, line: number, fieldPath: string, state: ParseState): void {
  if (!isPlainObject(value)) {
    issue(state, "structure", fieldPath + " 必须是对象", line, fieldPath);
    return;
  }
  if (value.metadata !== undefined) {
    if (!isPlainObject(value.metadata)) {
      issue(state, "structure", fieldPath + ".metadata 必须是对象", line, fieldPath + ".metadata");
    } else if (Object.hasOwn(value.metadata, WORLD_STATE_KEY)) {
      addWorldReference(state, value.metadata[WORLD_STATE_KEY], line, fieldPath + ".metadata." + WORLD_STATE_KEY);
    }
  }
}

interface MessageOptions {
  /** 候选回复的即时消息：不允许 user/system。 */
  candidate?: boolean;
  /** 计入隐藏消息数。 */
  hidden?: boolean;
}

/** 消息 extra 与 swipe_info[].extra 共用同一套扩展字段校验（含世界快照与嵌套候选）。 */
function validateExtra(extra: unknown, line: number, fieldPath: string, state: ParseState, branchDepth: number): void {
  if (!isPlainObject(extra)) {
    issue(state, "structure", fieldPath + " 必须是对象", line, fieldPath);
    return;
  }
  if (extra.messageId !== undefined && (typeof extra.messageId !== "string" || !extra.messageId.trim())) {
    issue(state, "structure", fieldPath + ".messageId 必须是非空字符串", line, fieldPath + ".messageId");
  }
  for (const key of ["thinking", "summary"]) {
    if (extra[key] !== undefined && typeof extra[key] !== "string") {
      issue(state, "structure", fieldPath + "." + key + " 必须是字符串", line, fieldPath + "." + key);
    }
  }
  if (extra._pitavernBeforeTurn !== undefined) {
    validateBeforeTurn(extra._pitavernBeforeTurn, line, fieldPath + "._pitavernBeforeTurn", state);
  }
  if (extra._pitavernReplies !== undefined) {
    validateReplies(extra._pitavernReplies, line, fieldPath + "._pitavernReplies", state, branchDepth);
  }
}

function validateMessage(
  value: unknown,
  line: number,
  fieldPath: string,
  state: ParseState,
  branchDepth: number,
  options: MessageOptions = {},
): void {
  if (!isPlainObject(value)) {
    issue(state, "structure", fieldPath + " 必须是聊天消息对象", line, fieldPath);
    return;
  }
  const name = value.name;
  if (typeof name !== "string" || !name.trim()) {
    issue(state, "structure", fieldPath + ".name 必须是非空字符串", line, fieldPath + ".name");
  } else if (value.is_system !== true) {
    (value.is_user === true ? state.userNames : state.assistantNames).add(name);
  }
  if (typeof value.mes !== "string") {
    issue(state, "structure", fieldPath + ".mes 必须是字符串", line, fieldPath + ".mes");
  }
  for (const key of ["is_user", "is_system"]) {
    if (value[key] !== undefined && typeof value[key] !== "boolean") {
      issue(state, "structure", fieldPath + "." + key + " 必须是布尔值", line, fieldPath + "." + key);
    }
  }
  if (options.candidate && (value.is_user === true || value.is_system === true)) {
    issue(state, "structure", fieldPath + " 候选回复不能是用户或系统消息", line, fieldPath);
  }
  if (value.send_date !== undefined && typeof value.send_date !== "string") {
    issue(state, "structure", fieldPath + ".send_date 必须是字符串", line, fieldPath + ".send_date");
  }
  if (value.swipes !== undefined) {
    if (!Array.isArray(value.swipes) || value.swipes.some((swipe) => typeof swipe !== "string")) {
      issue(state, "structure", fieldPath + ".swipes 必须是字符串数组", line, fieldPath + ".swipes");
    } else if (value.swipes.length > CHAT_IMPORT_MAX_BRANCH_NODES) {
      issue(state, "limit", fieldPath + ".swipes 候选数超过 " + CHAT_IMPORT_MAX_BRANCH_NODES, line, fieldPath + ".swipes");
    }
  }
  if (value.swipe_id !== undefined) {
    if (!Number.isInteger(value.swipe_id) || (value.swipe_id as number) < 0) {
      issue(state, "structure", fieldPath + ".swipe_id 必须是非负整数", line, fieldPath + ".swipe_id");
    } else if (Array.isArray(value.swipes) && (value.swipe_id as number) >= value.swipes.length) {
      issue(state, "structure", fieldPath + ".swipe_id 超出 swipes 范围", line, fieldPath + ".swipe_id");
    }
  }
  if (value.swipe_info !== undefined) {
    if (!Array.isArray(value.swipe_info)) {
      issue(state, "structure", fieldPath + ".swipe_info 必须是对象数组", line, fieldPath + ".swipe_info");
    } else {
      for (let index = 0; index < value.swipe_info.length; index++) {
        const entry = value.swipe_info[index];
        const entryPath = fieldPath + ".swipe_info[" + index + "]";
        if (!isPlainObject(entry)) {
          issue(state, "structure", entryPath + " 必须是对象", line, entryPath);
        } else if (entry.extra !== undefined) {
          validateExtra(entry.extra, line, entryPath + ".extra", state, branchDepth);
        }
      }
    }
  }

  if (value.extra !== undefined) validateExtra(value.extra, line, fieldPath + ".extra", state, branchDepth);
  if (options.hidden) state.hiddenMessages += 1;
}

function addCandidateNodes(state: ParseState, count: number, line: number, fieldPath: string): void {
  if (count <= 0) return;
  state.nodeCount += count;
  if (state.nodeCount > CHAT_IMPORT_MAX_BRANCH_NODES && !state.nodeLimitExceeded) {
    state.nodeLimitExceeded = true;
    issue(state, "limit", "分支候选总数超过 " + CHAT_IMPORT_MAX_BRANCH_NODES, line, fieldPath);
  }
}

function validateReplies(value: unknown, line: number, fieldPath: string, state: ParseState, depth: number): void {
  if (depth >= CHAT_IMPORT_MAX_BRANCH_DEPTH) {
    issue(state, "limit", fieldPath + " 分支嵌套超过 " + CHAT_IMPORT_MAX_BRANCH_DEPTH + " 层", line, fieldPath);
    return;
  }
  if (!isPlainObject(value)) {
    issue(state, "structure", fieldPath + " 必须是候选目录对象", line, fieldPath);
    return;
  }
  const versions = value.versions;
  if (!Array.isArray(versions) || versions.length === 0) {
    issue(state, "structure", fieldPath + ".versions 必须是非空数组", line, fieldPath + ".versions");
    return;
  }
  if (versions.length > CHAT_IMPORT_MAX_BRANCH_NODES) {
    issue(state, "limit", fieldPath + ".versions 超过 " + CHAT_IMPORT_MAX_BRANCH_NODES + " 个候选", line, fieldPath + ".versions");
    return;
  }
  if (!Number.isInteger(value.selected) || (value.selected as number) < 0 || (value.selected as number) >= versions.length) {
    issue(state, "structure", fieldPath + ".selected 必须指向存在的候选", line, fieldPath + ".selected");
  }
  for (let index = 0; index < versions.length; index++) {
    addCandidateNodes(state, 1, line, fieldPath);
    if (state.nodeLimitExceeded) return;
    const version = versions[index];
    const versionPath = fieldPath + ".versions[" + index + "]";
    if (!isPlainObject(version)) {
      issue(state, "structure", versionPath + " 必须是对象", line, versionPath);
      continue;
    }
    if (version.branchId !== undefined && (typeof version.branchId !== "string" || !version.branchId.trim())) {
      issue(state, "structure", versionPath + ".branchId 必须是非空字符串", line, versionPath + ".branchId");
    }
    if (version.statePruned !== undefined && typeof version.statePruned !== "boolean") {
      issue(state, "structure", versionPath + ".statePruned 必须是布尔值", line, versionPath + ".statePruned");
    }
    if (version.enforcement !== undefined) validateEnforcement(version.enforcement, line, versionPath + ".enforcement", state);
    if (!Array.isArray(version.messages) || version.messages.length === 0) {
      issue(state, "structure", versionPath + ".messages 必须是非空数组", line, versionPath + ".messages");
    } else {
      for (let messageIndex = 0; messageIndex < version.messages.length; messageIndex++) {
        validateMessage(version.messages[messageIndex], line, versionPath + ".messages[" + messageIndex + "]", state, depth + 1, { candidate: true, hidden: true });
      }
    }
    if (version.state !== undefined) {
      if (!isPlainObject(version.state)) {
        issue(state, "structure", versionPath + ".state 必须是对象", line, versionPath + ".state");
      } else if (Object.hasOwn(version.state, WORLD_STATE_KEY)) {
        addWorldReference(state, version.state[WORLD_STATE_KEY], line, versionPath + ".state." + WORLD_STATE_KEY);
      }
    }
    if (version.continuation !== undefined) {
      if (!Array.isArray(version.continuation)) {
        issue(state, "structure", versionPath + ".continuation 必须是字符串数组", line, versionPath + ".continuation");
      } else {
        let seen = false;
        const continuationEntries: CandidateSequenceEntry[] = [];
        for (let rawIndex = 0; rawIndex < version.continuation.length; rawIndex++) {
          const raw = version.continuation[rawIndex];
          const continuationPath = versionPath + ".continuation[" + rawIndex + "]";
          if (typeof raw !== "string" || !raw.trim()) {
            issue(state, "structure", continuationPath + " 必须是非空 JSONL 文本", line, continuationPath);
            continue;
          }
          seen = true;
          let nested: unknown;
          try {
            nested = JSON.parse(raw);
          } catch {
            issue(state, "json", continuationPath + " 不是有效 JSON", line, continuationPath);
            continue;
          }
          const inspected = inspectJson(nested, continuationPath);
          if (inspected.depthPath) {
            issue(state, "depth", continuationPath + " 嵌套超过 " + CHAT_IMPORT_MAX_JSON_DEPTH + " 层", line, continuationPath);
            continue;
          }
          if (inspected.unsafeKey) {
            issue(state, "unsafe", continuationPath + " 含不允许的字段名 __proto__", line, continuationPath);
            continue;
          }
          if (!isPlainObject(nested) || typeof nested.mes !== "string" || typeof nested.name !== "string") {
            issue(state, "structure", continuationPath + " 不是聊天消息对象", line, continuationPath);
            continue;
          }
          // 隐藏 continuation 是切换后的完整后续，允许包含用户消息。
          validateMessage(nested, line, continuationPath, state, depth + 1, { hidden: true });
          continuationEntries.push({ line: nested as unknown as StChatLine, lineNumber: line, fieldPath: continuationPath });
        }
        countNativeSwipeCandidates(continuationEntries, state);
        if (seen) state.hiddenContinuations += 1;
      }
    }
  }
}

function validateHeader(value: JsonObject, line: number, state: ParseState): void {
  // 原版 groups/ 与 JSON 聊天导出是单个对象 + messages 数组，不是逐行 JSONL；避免被当成空聊天头导入。
  if (Array.isArray(value.messages) || Array.isArray(value.chat)) {
    issue(state, "structure", "检测到 JSON 聊天/群组对象；仅支持逐行 JSONL 聊天记录", line, Array.isArray(value.messages) ? "messages" : "chat");
  }
  if (value.character_name !== undefined && typeof value.character_name !== "string") {
    issue(state, "structure", "头.character_name 必须是字符串", line, "character_name");
  }
  if (value.user_name !== undefined && typeof value.user_name !== "string") {
    issue(state, "structure", "头.user_name 必须是字符串", line, "user_name");
  }
  if (value.chat_metadata !== undefined && !isPlainObject(value.chat_metadata)) {
    issue(state, "structure", "头.chat_metadata 必须是对象", line, "chat_metadata");
    return;
  }
  const metadata = isPlainObject(value.chat_metadata) ? value.chat_metadata : {};
  state.headerMetadata = metadata;
  if (typeof metadata._pitavernTitle === "string" && metadata._pitavernTitle.trim()) {
    state.headerTitle = metadata._pitavernTitle.trim().slice(0, 100);
  }
  if (Object.hasOwn(metadata, WORLD_STATE_KEY)) {
    addWorldReference(state, metadata[WORLD_STATE_KEY], line, "chat_metadata." + WORLD_STATE_KEY);
  }
  if (Object.hasOwn(metadata, WORLD_TEMPLATES_KEY) && !isPlainObject(metadata[WORLD_TEMPLATES_KEY])) {
    issue(state, "metadata", "chat_metadata." + WORLD_TEMPLATES_KEY + " 必须是模板对象", line, "chat_metadata." + WORLD_TEMPLATES_KEY);
  }
  try {
    const group = readGroup(metadata);
    if (group) state.group = group;
  } catch (error) {
    issue(state, "metadata", "chat_metadata._pitavernGroup 无效：" + (error instanceof Error ? error.message : String(error)), line, "chat_metadata._pitavernGroup");
  }
}

function buildWorldPreview(state: ParseState, templates: unknown): ChatImportWorldPreviewDto | undefined {
  if (!state.snapshots.length) return undefined;
  const reasons = new Set<string>();
  const templateHashes = new Set<string>();
  const templateIds = new Set<string>();
  const templateNames = new Set<string>();
  const versions = new Set<string>();
  let snapshots = 0;
  for (const reference of state.snapshots) {
    let snapshot;
    try {
      snapshot = parseWorldSnapshot(reference.value);
    } catch (error) {
      issue(state, "world", reference.path + ": 世界快照结构损坏：" + worldErrorText(error), reference.line, reference.path);
      continue;
    }
    snapshots += 1;
    templateHashes.add(snapshot.templateHash);
    let world;
    try {
      world = new WorldState(snapshot, templates);
    } catch (error) {
      issue(state, "world", reference.path + ": 世界快照无法读取：" + worldErrorText(error), reference.line, reference.path);
      continue;
    }
    if (world.capability.mode !== "enabled") reasons.add(world.capability.reason ?? "世界只读");
    const template = world.template;
    if (template) {
      templateIds.add(template.templateId);
      templateNames.add(worldTemplateName(template.templateId));
      versions.add(template.templateVersion + "/" + template.rulesVersion);
    }
  }
  if (!snapshots) return undefined;
  const templateVersionRules = [...versions];
  const parsedVersions = templateVersionRules.length === 1 ? templateVersionRules[0].split("/").map(Number) : undefined;
  const reason = reasons.size ? [...reasons].slice(0, 3).join("；") : undefined;
  if (reason) warn(state, "世界模板缺失/版本未知，导入后世界为只读：" + reason);
  return {
    snapshots,
    templates: templateHashes.size,
    templateIds: [...templateIds],
    templateNames: [...templateNames],
    ...(parsedVersions ? { templateVersion: parsedVersions[0], rulesVersion: parsedVersions[1] } : {}),
    capability: reasons.size ? "read-only" : "enabled",
    ...(reason ? { reason } : {}),
  };
}

interface CandidateSequenceEntry {
  line: StChatLine;
  lineNumber: number;
  fieldPath: string;
}

/**
 * 原生 swipes 与 _pitavernReplies 共用 10000 节点预算。
 * 同一用户回合已有候选目录时，swipes 是该目录活动候选的副本，不重复计数；
 * 活动路径与隐藏 continuation 都使用这一套规则，避免切换分支后才发现超限。
 */
function countNativeSwipeCandidates(entries: CandidateSequenceEntry[], state: ParseState): void {
  if (state.nodeLimitExceeded) return;
  let turnHasCatalog = false;
  for (const entry of entries) {
    const line = entry.line;
    if (line.is_system === true) continue;
    if (line.is_user === true) {
      turnHasCatalog = isPlainObject(line.extra) && Object.hasOwn(line.extra, "_pitavernReplies");
      continue;
    }
    if (!Array.isArray(line.swipes) || line.swipes.length <= 1) continue;
    if (line.swipes.length > CHAT_IMPORT_MAX_BRANCH_NODES) continue;
    const ownCatalog = isPlainObject(line.extra) && Object.hasOwn(line.extra, "_pitavernReplies");
    if (turnHasCatalog || ownCatalog) continue;
    addCandidateNodes(state, line.swipes.length, entry.lineNumber, entry.fieldPath + ".swipes");
  }
}

/** 严格解析单文件 JSONL；与 ChatStore 的宽容读取不同，任何结构损坏都进入 errors。 */
export function parseChatImportFile(input: Buffer | Uint8Array, fileNameRaw: string, options: { knownCharacters?: readonly string[] } = {}): ParsedChatImport {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input);
  const sha256 = createHash("sha256").update(buffer).digest("hex");
  const fileName = safeFileName(fileNameRaw);
  const known = new Set(options.knownCharacters ?? []);
  const state: ParseState = {
    errors: [], issueCount: 0, warnings: [], warningSet: new Set(), snapshots: [],
    nodeCount: 0, nodeLimitExceeded: false, hiddenMessages: 0, hiddenContinuations: 0,
    userNames: new Set(), assistantNames: new Set(), headerMetadata: {},
  };
  const buildResult = (source: string, raw: string[], header: JsonObject, hasHeader: boolean, headerIndex: number | null, records: ChatImportRecord[], world?: ChatImportWorldPreviewDto): ParsedChatImport => {
    const active = records.map((record) => record.line);
    const users = active.filter((entry) => entry.is_system !== true && entry.is_user === true).length;
    const systems = active.filter((entry) => entry.is_system === true).length;
    const assistants = active.length - users - systems;
    let points: ReturnType<typeof branchPoints> = [];
    let hiddenBranches = 0;
    let candidates = 0;
    if (!state.errors.length) {
      try {
        points = branchPoints(active);
        candidates = points.reduce((sum, point) => sum + point.count, 0);
      } catch (error) {
        warn(state, "分支目录无法计算：" + (error instanceof Error ? error.message : String(error)));
      }
      try {
        const index = buildBranchIndex(source, "import-preview");
        hiddenBranches = Math.max(0, index.total - index.activePath.length);
        candidates = Math.max(candidates, index.total);
      } catch (error) {
        warn(state, "分支索引无法生成：" + (error instanceof Error ? error.message : String(error)));
      }
      candidates = Math.max(candidates, state.nodeCount);
    }
    const first = active.find((entry) => entry.is_system !== true && typeof entry.mes === "string" && entry.mes.trim());
    const last = active.findLast((entry) => entry.is_system !== true && typeof entry.mes === "string" && entry.mes.trim());
    const headerCharacter = typeof header.character_name === "string" ? header.character_name.trim() : "";
    if (headerCharacter) state.assistantNames.add(headerCharacter);
    if (typeof header.user_name === "string" && header.user_name.trim()) state.userNames.add(header.user_name.trim());
    const detectedCharacter = headerCharacter || [...state.assistantNames][0] || null;
    const characterKnown = Boolean(detectedCharacter && known.has(detectedCharacter));
    const group = state.group && {
      name: state.group.name,
      members: [...state.group.members],
      missingMembers: state.group.members.filter((member) => !known.has(member)),
    };
    const suggestedCharacter = detectedCharacter && known.has(detectedCharacter)
      ? detectedCharacter
      : state.group?.members.find((member) => known.has(member)) ?? null;
    if (!hasHeader) warn(state, "文件没有聊天头，导入时会补建 user_name/character_name 头。");
    if (detectedCharacter && !characterKnown) warn(state, "文件中的角色「" + detectedCharacter + "」不在资料库，请选择关联角色。");
    if (group?.missingMembers.length) warn(state, "群聊成员缺少角色卡：" + group.missingMembers.join("、") + "；补齐前群聊无法正常生成。");
    const fileBase = fileName.replace(/\.[^.]*$/, "").trim();
    const suggestedTitle = (state.headerTitle || fileBase || detectedCharacter || "导入的聊天").slice(0, 100);
    const preview: ChatImportPreviewDto = {
      sha256, bytes: buffer.length, lines: raw.length - (raw.at(-1) === "" ? 1 : 0), fileName,
      valid: state.issueCount === 0, issueCount: state.issueCount, errors: state.errors, warnings: state.warnings,
      hasHeader,
      detectedCharacter,
      suggestedCharacter,
      characterKnown,
      userNames: [...state.userNames],
      assistantNames: [...state.assistantNames],
      ...(group ? { group } : {}),
      messages: active.length, userMessages: users, assistantMessages: assistants, systemMessages: systems,
      hiddenMessages: state.hiddenMessages,
      branchPoints: points.length,
      candidates,
      hiddenContinuations: state.hiddenContinuations,
      hiddenBranches,
      firstPreview: first ? previewText(first.mes) : "",
      lastPreview: last ? previewText(last.mes) : "",
      ...(world ? { world } : {}),
      suggestedTitle: suggestedTitle || "导入的聊天",
    };
    return { sha256, bytes: buffer.length, source, raw, header, hasHeader, headerIndex, metadata: state.headerMetadata, records, preview };
  };

  if (!buffer.length) {
    issue(state, "size", "文件为空");
    return buildResult("", [], {}, false, null, []);
  }
  if (buffer.length > CHAT_IMPORT_MAX_BYTES) {
    issue(state, "size", "文件超过 " + Math.round(CHAT_IMPORT_MAX_BYTES / 1024 / 1024) + " MiB 限制");
    return buildResult("", [], {}, false, null, []);
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    issue(state, "encoding", "文件不是有效的 UTF-8 文本");
    return buildResult("", [], {}, false, null, []);
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  if (text.includes("\u0000")) {
    issue(state, "encoding", "文件包含 NUL 字符");
    return buildResult("", [], {}, false, null, []);
  }
  text = text.replace(/\r\n/g, "\n");
  const raw = text.split("\n");
  const physicalLines = raw.length - (raw.at(-1) === "" ? 1 : 0);
  if (physicalLines > CHAT_IMPORT_MAX_LINES) {
    issue(state, "limit", "文件超过 " + CHAT_IMPORT_MAX_LINES + " 行限制");
    return buildResult(text, raw, {}, false, null, []);
  }

  let header: JsonObject = {};
  let hasHeader = false;
  let headerIndex: number | null = null;
  let firstContent = true;
  let blankLines = 0;
  const records: ChatImportRecord[] = [];
  for (let index = 0; index < raw.length; index++) {
    const textLine = raw[index];
    const line = index + 1;
    if (!textLine.trim()) { blankLines += 1; continue; }
    let value: unknown;
    try {
      value = JSON.parse(textLine);
    } catch {
      issue(state, "json", "第 " + line + " 行不是有效 JSON", line);
      firstContent = false;
      continue;
    }
    const inspected = inspectJson(value, "");
    if (inspected.depthPath) {
      issue(state, "depth", "第 " + line + " 行 JSON 嵌套超过 " + CHAT_IMPORT_MAX_JSON_DEPTH + " 层", line, inspected.depthPath);
      firstContent = false;
      continue;
    }
    if (inspected.unsafeKey) {
      issue(state, "unsafe", "第 " + line + " 行含不允许的字段名 __proto__", line, inspected.unsafeKey);
      firstContent = false;
      continue;
    }
    if (firstContent) {
      firstContent = false;
      if (!isPlainObject(value)) {
        issue(state, "structure", "第 " + line + " 行必须是聊天头或消息对象", line);
        continue;
      }
      const messageLike = Object.hasOwn(value, "mes") || Object.hasOwn(value, "is_user")
        || Object.hasOwn(value, "is_system") || Object.hasOwn(value, "swipes") || Object.hasOwn(value, "swipe_id")
        || (typeof value.name === "string" && !Object.hasOwn(value, "chat_metadata") && !Object.hasOwn(value, "user_name") && !Object.hasOwn(value, "character_name"));
      if (messageLike) {
        validateMessage(value, line, "line[" + line + "]", state, 0);
        records.push({ line: value as unknown as StChatLine, rawIndex: index });
      } else {
        hasHeader = true;
        headerIndex = index;
        header = value;
        validateHeader(value, line, state);
      }
      continue;
    }
    if (!isPlainObject(value)) {
      issue(state, "structure", "第 " + line + " 行必须是聊天消息对象", line);
      continue;
    }
    validateMessage(value, line, "line[" + line + "]", state, 0);
    records.push({ line: value as unknown as StChatLine, rawIndex: index });
  }

  if (!hasHeader && !records.length && !state.issueCount) issue(state, "structure", "文件没有可导入的头或消息");
  if (!state.issueCount) {
    countNativeSwipeCandidates(records.map((record) => ({
      line: record.line, lineNumber: record.rawIndex + 1, fieldPath: "line[" + (record.rawIndex + 1) + "]",
    })), state);
  }
  const trailingBlank = raw.length > 1 && raw.at(-1) === "" ? 1 : 0;
  if (blankLines > trailingBlank) warn(state, "文件包含 " + (blankLines - trailingBlank) + " 个空行，已忽略。");
  const world = buildWorldPreview(state, state.headerMetadata[WORLD_TEMPLATES_KEY]);
  return buildResult(text, raw, header, hasHeader, headerIndex, records, world);
}

interface ChatImportManifestEntry {
  chatId: string;
  title: string;
  fileName: string;
  importedAt: string;
}

interface ChatImportManifest {
  version: 1;
  imports: Record<string, ChatImportManifestEntry>;
}

export interface ChatImportErrorOptions {
  code?: "invalid" | "duplicate" | "conflict";
  issues?: ChatImportIssueDto[];
  duplicate?: { chatId: string; title: string };
}

export class ChatImportError extends Error {
  readonly code: "invalid" | "duplicate" | "conflict";
  readonly issues: ChatImportIssueDto[];
  readonly duplicate?: { chatId: string; title: string };

  constructor(message: string, options: ChatImportErrorOptions = {}) {
    super(message);
    this.name = "ChatImportError";
    this.code = options.code ?? "invalid";
    this.issues = options.issues ?? [];
    this.duplicate = options.duplicate;
  }
}

export interface ChatImportInput {
  fileName: string;
  character: string;
  expectedSha256?: string;
  title?: string;
}

/** 预览/导入共用同一解析器；本类只负责重复索引、角色关联和原子落盘。 */
export class ChatImportService {
  private readonly manifestPath: string;

  constructor(
    private readonly stDataDir: string,
    private readonly chats: ChatStore,
    private readonly characters: CharacterStore,
  ) {
    this.manifestPath = path.join(stDataDir, ".pitavern", "chat-imports", "index.json");
  }

  private knownCharacters(): string[] {
    return this.characters.listCharacters().map((card) => card.name);
  }

  private readManifest(): { manifest: ChatImportManifest; broken: boolean } {
    const empty: ChatImportManifest = { version: 1, imports: {} };
    if (!fs.existsSync(this.manifestPath)) return { manifest: empty, broken: false };
    try {
      const value: unknown = JSON.parse(fs.readFileSync(this.manifestPath, "utf8"));
      if (!isPlainObject(value) || value.version !== 1 || !isPlainObject(value.imports)) throw new Error("格式错误");
      const imports: Record<string, ChatImportManifestEntry> = Object.create(null);
      for (const [hash, raw] of Object.entries(value.imports)) {
        if (!/^[a-f0-9]{64}$/.test(hash) || !isPlainObject(raw)) continue;
        if (typeof raw.chatId !== "string" || typeof raw.title !== "string" || typeof raw.fileName !== "string" || typeof raw.importedAt !== "string") continue;
        imports[hash] = { chatId: raw.chatId, title: raw.title, fileName: raw.fileName, importedAt: raw.importedAt };
      }
      return { manifest: { version: 1, imports }, broken: false };
    } catch {
      return { manifest: empty, broken: true };
    }
  }

  private duplicateFor(manifest: ChatImportManifest, sha256: string): { chatId: string; title: string } | undefined {
    const entry = manifest.imports[sha256];
    if (!entry) return undefined;
    try {
      const file = this.chats.resolveChatFile(entry.chatId);
      if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) return undefined;
      const meta = this.chats.statChat(file);
      return { chatId: entry.chatId, title: meta?.displayName || entry.title || entry.chatId };
    } catch {
      // 索引条目过期或文件正在变化时按未导入处理，绝不误报重复。
      return undefined;
    }
  }

  private existingTitles(): Set<string> {
    const titles = new Set<string>();
    for (const chat of this.chats.listChats()) titles.add((chat.displayName?.trim() || chat.id.split("/").pop() || chat.id).slice(0, 100));
    return titles;
  }

  private uniqueTitle(input: string): string {
    const cleaned = input.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 100) || "导入的聊天";
    const existing = this.existingTitles();
    if (!existing.has(cleaned)) return cleaned;
    for (let index = 2; index < 1000; index++) {
      const suffix = " (" + index + ")";
      const candidate = cleaned.slice(0, Math.max(1, 100 - suffix.length)).trimEnd() + suffix;
      if (!existing.has(candidate)) return candidate;
    }
    return (cleaned.slice(0, 90) + " " + Date.now()).slice(0, 100);
  }

  preview(input: Buffer | Uint8Array, fileName: string): ChatImportPreviewDto {
    const parsed = parseChatImportFile(input, fileName, { knownCharacters: this.knownCharacters() });
    const { manifest, broken } = this.readManifest();
    const duplicate = this.duplicateFor(manifest, parsed.sha256);
    const suggestedTitle = this.uniqueTitle(parsed.preview.suggestedTitle);
    const warnings = [...parsed.preview.warnings];
    if (broken) warnings.push("导入索引损坏，旧重复记录已忽略；下一次成功导入会重建索引。");
    if (suggestedTitle !== parsed.preview.suggestedTitle) warnings.push("同名聊天已存在，导入标题将使用「" + suggestedTitle + "」。");
    return {
      ...parsed.preview,
      suggestedTitle,
      warnings,
      ...(duplicate ? { duplicate } : {}),
    };
  }

  import(input: Buffer | Uint8Array, options: ChatImportInput): ChatImportResultDto {
    const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input);
    const sha256 = createHash("sha256").update(buffer).digest("hex");
    if (options.expectedSha256 && options.expectedSha256 !== sha256) {
      throw new ChatImportError("文件在预览后发生变化，请重新选择并预览", { code: "conflict" });
    }
    const known = this.knownCharacters();
    const parsed = parseChatImportFile(buffer, options.fileName, { knownCharacters: known });
    if (!parsed.preview.valid) {
      throw new ChatImportError("聊天文件校验失败，未写入任何数据", { issues: parsed.preview.errors });
    }
    const { manifest, broken } = this.readManifest();
    const duplicate = this.duplicateFor(manifest, sha256);
    if (duplicate) {
      throw new ChatImportError("该文件已经导入为「" + duplicate.title + "」；不会覆盖已有聊天", { code: "duplicate", duplicate });
    }
    const character = options.character.trim();
    if (!known.includes(character)) throw new ChatImportError("关联角色不存在，请刷新角色列表后重新选择");
    const requestedTitle = (options.title ?? "").trim() || parsed.preview.suggestedTitle;
    const title = this.uniqueTitle(requestedTitle);
    const source = buildImportedSource(parsed, character, title, sha256);
    const checked = parseChatImportFile(Buffer.from(source, "utf8"), options.fileName, { knownCharacters: known });
    if (!checked.preview.valid) {
      throw new ChatImportError("导入后的聊天无法通过校验，未写入任何数据", { issues: checked.preview.errors });
    }
    const meta = this.chats.importChat(character, source);
    try {
      if (broken && fs.existsSync(this.manifestPath)) {
        try { fs.renameSync(this.manifestPath, this.manifestPath + ".broken-" + Date.now()); } catch { /* 保留损坏索引不影响导入索引重建。 */ }
      }
      const manifestNext: ChatImportManifest = {
        version: 1,
        imports: { ...(broken ? {} : manifest.imports), [sha256]: {
          chatId: meta.id, title, fileName: parsed.preview.fileName, importedAt: new Date().toISOString(),
        } },
      };
      atomicWrite(this.manifestPath, JSON.stringify(manifestNext, null, 2) + "\n");
    } catch (error) {
      try { this.chats.deleteChat(meta.id); } catch { /* 清理失败留给用户手动删除。 */ }
      throw new ChatImportError("导入索引写入失败，已撤销新聊天：" + (error instanceof Error ? error.message : String(error)));
    }
    const warnings = [...parsed.preview.warnings];
    if (title !== requestedTitle) warnings.push("标题与已有聊天重名，已自动使用「" + title + "」。");
    return { id: meta.id, title, character, warnings };
  }
}

/** 只改写头：关联角色、唯一标题、导入来源；消息行与隐藏 continuation 原样保留。 */
function buildImportedSource(parsed: ParsedChatImport, character: string, title: string, sha256: string): string {
  const header = parsed.hasHeader ? structuredClone(parsed.header) : {};
  const metadata = isPlainObject(header.chat_metadata) ? structuredClone(header.chat_metadata) : {};
  metadata._pitavernTitle = title;
  metadata._pitavernImport = {
    sha256,
    fileName: parsed.preview.fileName,
    importedAt: new Date().toISOString(),
  };
  header.chat_metadata = metadata;
  header.character_name = character;
  if (!parsed.hasHeader && typeof header.user_name !== "string") header.user_name = "User";
  const lines = [...parsed.raw];
  if (parsed.hasHeader && parsed.headerIndex !== null) {
    const headerLine = JSON.stringify(header);
    if (parsed.headerIndex === 0) lines[0] = headerLine;
    else {
      // ChatStore 只把物理第 1 行当作头；先移除头前的空行，再放到第一行。
      lines.splice(parsed.headerIndex, 1);
      lines.unshift(headerLine);
    }
  } else lines.unshift(JSON.stringify(header));
  while (lines.length && lines.at(-1) === "") lines.pop();
  return lines.join("\n") + "\n";
}
