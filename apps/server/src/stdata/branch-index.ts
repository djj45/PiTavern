import { createHash } from "node:crypto";
import type { BranchIndexDto, BranchPathStepDto, BranchTreeNodeDto } from "@pitavern/shared";
import { parseChatSource, turnReplies } from "./replies.ts";
import type { StChatLine } from "./types.ts";

const MAX_NODES = 4000;
const MAX_DEPTH = 40;

function previewText(text: string, limit = 140): string {
  return text.replace(/\s+/g, " ").trim().slice(0, limit);
}

function countUserTurns(lines: StChatLine[]): number {
  return lines.filter((line) => line.is_user && !line.is_system && line.mes.trim()).length;
}

function lastStoryText(lines: StChatLine[]): string {
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index];
    if (!line.is_system && line.mes.trim()) return previewText(line.mes, 600);
  }
  return "";
}

function lineId(line: StChatLine, index: number): string {
  return typeof line.extra?.messageId === "string" ? line.extra.messageId : "line-" + index;
}

function parseRawLines(raw?: string[]): StChatLine[] {
  if (!raw?.length) return [];
  return parseChatSource(raw.join("\n")).records.map((record) => record.line);
}

function firstBranch(lines: StChatLine[], metadata: Record<string, unknown>, turnOffset: number) {
  let turn = turnOffset;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (!line.is_user || line.is_system || !line.mes.trim()) continue;
    turn += 1;
    const { catalog } = turnReplies(lines, metadata, index);
    if (catalog.versions.length > 1) return { userIndex: index, userLine: line, turn, catalog };
  }
  return undefined;
}

function pathId(steps: BranchPathStepDto[]): string {
  return "b_" + createHash("sha256").update(JSON.stringify(steps)).digest("hex").slice(0, 16);
}

function metadataMap(value: unknown): Record<string, Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, Record<string, unknown>>;
}

interface WalkContext {
  metadata: Record<string, unknown>;
  meta: Record<string, Record<string, unknown>>;
  path: BranchPathStepDto[];
  pathIds: string[];
  pathLabels: string[];
  parentId?: string;
  depth: number;
  turnOffset: number;
  active: boolean;
}

interface WalkState {
  count: number;
  truncated: boolean;
  activePath: string[];
}

function buildChildren(lines: StChatLine[], ctx: WalkContext, state: WalkState): BranchTreeNodeDto[] {
  if (state.count >= MAX_NODES || ctx.depth >= MAX_DEPTH) { state.truncated = true; return []; }
  const found = firstBranch(lines, ctx.metadata, ctx.turnOffset);
  if (!found) return [];
  const { userIndex, userLine, turn, catalog } = found;
  const actualSuffix = lines.slice(userIndex + 1);
  const userPreview = previewText(userLine.mes, 100);
  const nodes: BranchTreeNodeDto[] = [];
  for (let index = 0; index < catalog.versions.length; index++) {
    if (state.count >= MAX_NODES) { state.truncated = true; break; }
    const version = catalog.versions[index];
    const activeCandidate = ctx.active && index === catalog.selected;
    const step: BranchPathStepDto = { userMessageId: lineId(userLine, userIndex), selected: index };
    const path = [...ctx.path, step];
    const id = pathId(path);
    const assistantPreview = previewText(version.messages.find((message) => !message.is_user && !message.is_system)?.mes ?? "", 100);
    const baseName = userPreview && userPreview !== "继续" ? userPreview : assistantPreview || "空回复";
    const title = `第 ${turn} 轮 · ${previewText(baseName, 32)}`;
    const meta = ctx.meta[id] ?? {};
    const labels = [...ctx.pathLabels, typeof meta.name === "string" && meta.name.trim() ? meta.name.trim() : title];
    const routeLines = activeCandidate
      ? actualSuffix
      : [...version.messages, ...parseRawLines(version.continuation)];
    const childCtx: WalkContext = {
      metadata: ctx.metadata,
      meta: ctx.meta,
      path,
      pathIds: [...ctx.pathIds, id],
      pathLabels: labels,
      parentId: id,
      depth: ctx.depth + 1,
      turnOffset: turn,
      active: activeCandidate,
    };
    state.count += 1;
    if (activeCandidate) state.activePath.push(id);
    const children = buildChildren(routeLines, childCtx, state);
    const descendantCount = children.reduce((sum, child) => sum + 1 + child.descendantCount, 0);
    const node: BranchTreeNodeDto = {
      id,
      branchId: version.branchId ?? id,
      parentId: ctx.parentId,
      depth: ctx.depth,
      turn,
      title,
      ...(typeof meta.name === "string" && meta.name.trim() ? { name: meta.name.trim() } : {}),
      ...(typeof meta.note === "string" && meta.note.trim() ? { note: meta.note.trim() } : {}),
      userPreview,
      assistantPreview,
      preview: lastStoryText(routeLines) || assistantPreview || userPreview,
      pathText: labels.join(" › "),
      path,
      pathIds: [...ctx.pathIds, id],
      pathLabels: labels,
      childCount: children.length,
      descendantCount,
      totalTurns: turn + countUserTurns(routeLines),
      linearTurns: countUserTurns(routeLines),
      isActive: activeCandidate,
      isCurrent: false,
      favorite: meta.favorite === true,
      ...(meta.archived === true ? { archived: true } : {}),
      ...(typeof meta.visitedAt === "string" ? { visitedAt: meta.visitedAt } : {}),
      children,
    };
    nodes.push(node);
  }
  return nodes;
}

function markCurrent(nodes: BranchTreeNodeDto[], currentNodeId: string | undefined): void {
  for (const node of nodes) {
    if (node.id === currentNodeId) node.isCurrent = true;
    markCurrent(node.children, currentNodeId);
  }
}

export function buildBranchIndex(source: string, revision: string): BranchIndexDto {
  const parsed = parseChatSource(source);
  const metadata = (parsed.header.chat_metadata ?? {}) as Record<string, unknown>;
  const meta = metadataMap(metadata._pitavernBranchMeta);
  const state: WalkState = { count: 0, truncated: false, activePath: [] };
  const nodes = buildChildren(parsed.records.map((record) => record.line), {
    metadata, meta, path: [], pathIds: [], pathLabels: [], depth: 0, turnOffset: 0, active: true,
  }, state);
  const currentNodeId = state.activePath.at(-1);
  markCurrent(nodes, currentNodeId);
  return {
    revision,
    nodes,
    total: state.count,
    truncated: state.truncated,
    ...(currentNodeId ? { currentNodeId } : {}),
    activePath: state.activePath,
  };
}

export function findBranchNode(nodes: BranchTreeNodeDto[], id: string): BranchTreeNodeDto | undefined {
  for (const node of nodes) {
    if (node.id === id) return node;
    const nested = findBranchNode(node.children, id);
    if (nested) return nested;
  }
  return undefined;
}
