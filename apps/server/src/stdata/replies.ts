import type { ReplyChoicesDto } from "@pitavern/shared";
import type { StChatLine } from "./types.ts";

export const STATE_KEYS = ["variables", "projection", "timedWorldInfo", "_pitavernEnforcement"] as const;
export type RecallState = { turn: number; usedThisTurn: number; cooldownUntilTurn: number };
export interface ReplyVersion {
  messages: StChatLine[];
  state?: Record<string, unknown>;
  enforcement?: RecallState;
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
  if (!value || typeof value !== "object") return false;
  const v = value as RecallState;
  return [v.turn, v.usedThisTurn, v.cooldownUntilTurn].every((n) => Number.isInteger(n) && n >= 0);
}

function validCatalog(value: unknown): value is ReplyVersions {
  const saved = value as ReplyVersions | undefined;
  return Boolean(saved && Array.isArray(saved.versions) && saved.versions.length > 0 &&
    Number.isInteger(saved.selected) && saved.selected >= 0 && saved.selected < saved.versions.length &&
    saved.versions.every((v) => v && Array.isArray(v.messages) && v.messages.every((m) =>
      m && typeof m.mes === "string" && typeof m.name === "string" && !m.is_user && !m.is_system)));
}

export function replyChoices(lines: StChatLine[]): ReplyChoicesDto | undefined {
  const userIndex = lines.findLastIndex((line) => line.is_user && !line.is_system && line.mes.trim());
  const user = lines[userIndex];
  if (!user) return;
  const saved = user.extra?._pitavernReplies;
  const current = lines.slice(userIndex + 1).filter((line) => !line.is_user && !line.is_system);
  const swipes = current.length === 1 && current[0].swipes?.every((s) => typeof s === "string") ? current[0].swipes : undefined;
  const selected = swipes && Number.isInteger(current[0].swipe_id) && current[0].swipe_id! >= 0 && current[0].swipe_id! < swipes.length ? current[0].swipe_id! : 0;
  return {
    userMessageId: typeof user.extra?.messageId === "string" ? user.extra.messageId : `line-${userIndex}`,
    selected: validCatalog(saved) ? saved.selected : selected,
    count: validCatalog(saved) ? saved.versions.length : swipes?.length || (current.length ? 1 : 0),
  };
}

/** Only the latest user turn is selectable: later turns must never inherit a different reply's state. */
export function lastReplies(lines: StChatLine[], metadata: Record<string, unknown>): {
  userIndex: number; choices?: ReplyChoicesDto; catalog: ReplyVersions;
} {
  const userIndex = lines.findLastIndex((line) => line.is_user && !line.is_system && line.mes.trim());
  const user = lines[userIndex];
  const current = lines.slice(userIndex + 1).filter((line) => !line.is_user && !line.is_system);
  let catalog: ReplyVersions = { selected: 0, versions: [] };
  if (!user) return { userIndex, catalog };
  const saved = user.extra?._pitavernReplies as ReplyVersions | undefined;
  if (validCatalog(saved)) {
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
      userMessageId: typeof user.extra?.messageId === "string" ? user.extra.messageId : `line-${userIndex}`,
      selected: catalog.selected, count: catalog.versions.length,
    },
  };
}
