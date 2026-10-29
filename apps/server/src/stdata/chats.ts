import { readGroup } from "./groups.ts";
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { AuthorNoteDto, ChatBackupDto, ChatBackupPreviewDto, ChatMessageDto, ChatPageDto } from "@pitavern/shared";
import type { StChatLine } from "./types.ts";
import { lastReplies, restoreState, selectedMessages, stateFields, type ReplyVersions } from "./replies.ts";
import { validateAuthorNote } from "../context/author-note.ts";

export interface ChatMeta {
  group?: import("@pitavern/shared").GroupChatDto;
  id: string;
  file: string;
  character: string;
  messageCount: number;
  lastMessage: string;
  updatedAt: string;
}

export interface ChatDocument {
  character: string;
  metadata: Record<string, unknown>;
  lines: StChatLine[];
}

interface CachedDocument {
  fingerprint: string;
  document: ChatDocument;
  messages?: ChatMessageDto[];
}

function fingerprint(stat: fs.Stats): string {
  return `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}:${stat.ino}`;
}

function stChatFileName(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}@${pad(date.getHours())}h${pad(date.getMinutes())}m${pad(date.getSeconds())}s.jsonl`;
}

function characterDirName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, "_").trim() || "_";
}

export function chatMessages(lines: StChatLine[]): ChatMessageDto[] {
  return lines.flatMap((line, i) => !line.is_system && (line.mes.trim() || line.extra?.thinking) ? [{
    id: typeof line.extra?.messageId === "string" ? line.extra.messageId : `line-${i}`,
    role: line.is_user ? "user" as const : "assistant" as const,
    name: line.name,
    text: line.mes,
    sendDate: line.send_date,
    ...(typeof line.extra?.thinking === "string" ? { thinking: line.extra.thinking } : {}),
  }] : []);
}

export class ChatStore {
  private readonly summaries = new Map<string, { fingerprint: string; meta: ChatMeta }>();
  // 列表只保留轻量摘要；正文限制为最近访问的 8 个文件。
  private readonly documents = new Map<string, CachedDocument>();

  constructor(private readonly stDataDir: string) {}

  private characterChatsDir(character: string): string {
    return path.join(this.stDataDir, "chats", characterDirName(character));
  }

  resolveChatFile(chatId: string): string | null {
    const file = path.resolve(this.stDataDir, chatId);
    const root = path.resolve(this.stDataDir);
    if (file !== root && !file.startsWith(root + path.sep)) return null;
    return file;
  }

  private remember(file: string, document: ChatDocument, stat: fs.Stats): void {
    this.documents.delete(file);
    this.documents.set(file, { fingerprint: fingerprint(stat), document });
    while (this.documents.size > 8) this.documents.delete(this.documents.keys().next().value!);
    this.summaries.set(file, {
      fingerprint: fingerprint(stat),
      meta: {
        id: path.relative(this.stDataDir, file).split(path.sep).join("/"),
        file,
        character: document.character,
        group: readGroup(document.metadata),
        messageCount: document.lines.length,
        lastMessage: document.lines.at(-1)?.mes.slice(0, 80) ?? "",
        updatedAt: new Date(stat.mtimeMs).toISOString(),
      },
    });
  }

  private readFile(file: string, stat = fs.statSync(file)): ChatDocument {
    const cached = this.documents.get(file);
    if (cached?.fingerprint === fingerprint(stat)) {
      this.documents.delete(file);
      this.documents.set(file, cached);
      return cached.document;
    }
    const raw = fs.readFileSync(file, "utf8");
    const lines: StChatLine[] = [];
    let header: Record<string, unknown> = {};
    for (const [index, line] of raw.split("\n").entries()) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        if (typeof obj?.mes === "string" && typeof obj?.name === "string") {
          lines.push({
            ...obj, name: obj.name, is_user: Boolean(obj.is_user), is_system: Boolean(obj.is_system),
            send_date: typeof obj.send_date === "string" ? obj.send_date : "",
            mes: obj.mes, extra: obj.extra,
          });
        } else if (index === 0 && obj && typeof obj === "object") {
          header = obj;
        }
      } catch {
        // 与 ST 一样跳过损坏行，不影响其他消息读取。
      }
    }
    const document: ChatDocument = {
      character: typeof header.character_name === "string" && header.character_name
        ? header.character_name
        : lines.find((line) => !line.is_user && !line.is_system)?.name ?? path.basename(path.dirname(file)),
      metadata: header.chat_metadata && typeof header.chat_metadata === "object"
        ? header.chat_metadata as Record<string, unknown> : {},
      lines,
    };
    this.remember(file, document, stat);
    return document;
  }

  listChats(character?: string): ChatMeta[] {
    const root = path.join(this.stDataDir, "chats");
    if (!fs.existsSync(root)) return [];
    const dirs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => path.join(root, d.name));
    const metas: ChatMeta[] = [];
    for (const dir of dirs) {
      if (!fs.existsSync(dir)) continue;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
        const meta = this.statChat(path.join(dir, entry.name));
        if (meta && (!character || meta.character === character || meta.group?.members.includes(character))) metas.push(meta);
      }
    }
    return metas.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  statChat(file: string): ChatMeta | null {
    try {
      const stat = fs.statSync(file);
      if (!stat.isFile()) return null;
      if (this.summaries.get(file)?.fingerprint !== fingerprint(stat)) this.readFile(file, stat);
      return this.summaries.get(file)?.meta ?? null;
    } catch {
      this.documents.delete(file);
      this.summaries.delete(file);
      return null;
    }
  }

  readLines(file: string): StChatLine[] {
    return this.readFile(file).lines;
  }

  readDocument(chatId: string): ChatDocument | null {
    const file = this.resolveChatFile(chatId);
    if (!file || !fs.existsSync(file)) return null;
    return this.readFile(file);
  }

  readChat(chatId: string): StChatLine[] | null {
    return this.readDocument(chatId)?.lines ?? null;
  }

  readMetadata(chatId: string): Record<string, unknown> {
    return this.readDocument(chatId)?.metadata ?? {};
  }

  revisionId(chatId: string): string {
    const file = this.resolveChatFile(chatId);
    if (!file || !fs.existsSync(file)) throw new Error("聊天不存在");
    return createHash("sha256").update(fingerprint(fs.statSync(file))).digest("hex");
  }

  page(chatId: string, before?: number, expectedRevision?: string, limit = 80): ChatPageDto {
    const document = this.readDocument(chatId);
    if (!document) throw new Error("聊天不存在");
    const revision = this.revisionId(chatId);
    if (expectedRevision && revision !== expectedRevision) throw new Error("聊天已变化，请重新同步后加载历史");
    const cached = this.documents.get(this.resolveChatFile(chatId)!)!;
    const messages = cached.messages ??= chatMessages(document.lines);
    const end = before ?? messages.length;
    if (!Number.isInteger(end) || end < 0 || end > messages.length) throw new Error("历史页位置无效");
    const start = Math.max(0, end - Math.min(200, Math.max(1, limit)));
    return { messages: messages.slice(start, end), total: messages.length, before: start > 0 ? start : null, revision };
  }

  private backupDir(chatId: string): string {
    return path.join(this.stDataDir, ".pitavern", "backups", createHash("sha256").update(chatId).digest("hex"));
  }

  backups(chatId: string, before?: string): { backups: ChatBackupDto[]; before: string | null } {
    if (!this.readDocument(chatId)) throw new Error("聊天不存在");
    const dir = this.backupDir(chatId);
    const names = fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => /^\d+-[\da-f-]+\.jsonl$/.test(name)).sort().reverse() : [];
    const filtered = before ? names.filter((name) => name < before) : names;
    const batch = filtered.slice(0, 30);
    return { backups: batch.map((id) => ({ id, createdAt: new Date(Number(id.split("-")[0])).toISOString(), bytes: fs.statSync(path.join(dir, id)).size })),
      before: filtered.length > batch.length ? batch.at(-1)! : null };
  }

  private backupFile(chatId: string, backupId: string): string {
    if (!/^\d+-[\da-f-]+\.jsonl$/.test(backupId)) throw new Error("备份标识无效");
    const file = path.join(this.backupDir(chatId), backupId);
    if (!fs.existsSync(file) || !fs.lstatSync(file).isFile()) throw new Error("备份不存在");
    return file;
  }

  previewBackup(chatId: string, backupId: string): ChatBackupPreviewDto {
    const revision = this.revisionId(chatId);
    const file = this.backupFile(chatId, backupId);
    const lines: StChatLine[] = [];
    for (const raw of fs.readFileSync(file, "utf8").split("\n")) {
      try { const line = JSON.parse(raw); if (typeof line?.mes === "string" && typeof line?.name === "string") lines.push(line); }
      catch { /* Match the normal reader; restore still preserves all raw lines. */ }
    }
    const messages = chatMessages(lines);
    return { backup: { id: backupId, createdAt: new Date(Number(backupId.split("-")[0])).toISOString(), bytes: fs.statSync(file).size },
      messages: messages.slice(-40), total: messages.length, revision };
  }

  restoreBackup(chatId: string, backupId: string, expectedRevision: string): void {
    if (this.revisionId(chatId) !== expectedRevision) throw new Error("聊天已变化，请重新预览备份后恢复");
    const rev = this.revision(chatId);
    const source = fs.readFileSync(this.backupFile(chatId, backupId), "utf8");
    this.replaceSource(chatId, rev.source, source);
  }

  writeMetadata(chatId: string, metadata: Record<string, unknown>): void {
    const file = this.resolveChatFile(chatId);
    if (!file || !fs.existsSync(file)) throw new Error(`聊天文件不存在: ${chatId}`);
    const source = fs.readFileSync(file, "utf8");
    const lines = source.split("\n");
    let header: Record<string, unknown> = {};
    try {
      const first = JSON.parse(lines[0] ?? "");
      if (first && typeof first === "object" && typeof first.mes !== "string") {
        header = first;
        lines.shift();
      }
    } catch { /* 无头文件需要补头 */ }
    header.chat_metadata = { ...(header.chat_metadata as object), ...metadata };
    this.replaceSource(chatId, source, [JSON.stringify(header), ...lines].join("\n"), false);
    this.documents.delete(file);
    this.summaries.delete(file);
  }

  appendMessage(chatId: string, line: Omit<StChatLine, "send_date"> & { send_date?: string }): StChatLine {
    const file = this.resolveChatFile(chatId);
    if (!file || !fs.existsSync(file)) throw new Error(`聊天文件不存在: ${chatId}`);
    const document = this.readFile(file);
    const full: StChatLine = {
      ...line, send_date: line.send_date ?? new Date().toISOString(),
      extra: { ...line.extra, messageId: line.extra?.messageId ?? randomUUID() },
    };
    const descriptor = fs.openSync(file, "r");
    let separator = "";
    try {
      const size = fs.fstatSync(descriptor).size;
      const last = Buffer.alloc(1);
      if (size > 0) { fs.readSync(descriptor, last, 0, 1, size - 1); if (last[0] !== 10) separator = "\n"; }
    } finally { fs.closeSync(descriptor); }
    fs.appendFileSync(file, separator + JSON.stringify(full) + "\n", "utf8");
    this.remember(file, { ...document, lines: [...document.lines, full] }, fs.statSync(file));
    return full;
  }

  createChat(character: string, greeting: (Omit<StChatLine, "send_date"> & { send_date?: string }) | null, userName = "User", metadata: Record<string, unknown> = {}): ChatMeta {
    const dir = this.characterChatsDir(character);
    fs.mkdirSync(dir, { recursive: true });
    let file = path.join(dir, stChatFileName());
    for (let i = 0; fs.existsSync(file); i++) file = path.join(dir, stChatFileName(new Date(Date.now() + (i + 1) * 1000)));
    const header = JSON.stringify({ user_name: userName, character_name: character, chat_metadata: metadata });
    const first = greeting ? { ...greeting, send_date: greeting.send_date ?? new Date().toISOString() } : null;
    fs.writeFileSync(file, first ? `${header}\n${JSON.stringify(first)}\n` : `${header}\n`, "utf8");
    const meta = this.statChat(file);
    if (!meta) throw new Error("无法读取新建的聊天");
    return meta;
  }

  /** Compare against the captured source before replacing it; never overwrite an external edit. */
  private replaceSource(chatId: string, expected: string, next: string, backup = true): void {
    const file = this.resolveChatFile(chatId);
    if (!file || fs.readFileSync(file, "utf8") !== expected) throw new Error("聊天已被其他窗口或程序修改，请刷新后重试");
    if (next === expected) return;
    if (backup) {
      const dir = this.backupDir(chatId);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, Date.now() + "-" + randomUUID() + ".jsonl"), expected, { flag: "wx", mode: 0o600 });
    }
    const temporary = file + "." + randomUUID() + ".tmp";
    try {
      fs.writeFileSync(temporary, next, { flag: "wx", mode: fs.statSync(file).mode });
      if (fs.readFileSync(file, "utf8") !== expected) throw new Error("聊天已被其他程序修改，请刷新后重试");
      fs.renameSync(temporary, file);
    } finally {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
    this.documents.delete(file);
    this.summaries.delete(file);
  }

  /** Read raw lines so unknown ST fields, alternate replies and damaged lines survive edits. */
  private revision(chatId: string) {
    const file = this.resolveChatFile(chatId);
    if (!file || !fs.existsSync(file)) throw new Error("聊天不存在");
    const source = fs.readFileSync(file, "utf8");
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

  /** Preserve raw unknown/damaged records and commit a whole script in one replacement. */
  prepareScript(chatId: string, expectedRevision: string) {
    if (this.revisionId(chatId) !== expectedRevision) throw new Error("聊天已变化，请同步后重新运行脚本");
    const rev = this.revision(chatId);
    const lines = rev.records.map((record) => structuredClone(record.line));
    const origins = new Map(lines.map((line, index) => [line, rev.records[index].rawIndex]));
    const metadata = structuredClone(rev.header.chat_metadata as Record<string, unknown> ?? {});
    const beforeVariables = JSON.stringify(metadata.variables);
    return { lines, metadata, commit: () => {
      const next = [...rev.raw.slice(0, rev.hasHeader ? 1 : 0)];
      let cursor = rev.hasHeader ? 1 : 0;
      const changed = lines.length !== rev.records.length || JSON.stringify(metadata.variables) !== beforeVariables;
      for (const line of lines) {
        const original = origins.get(line);
        if (original !== undefined) {
          while (cursor < original) next.push(rev.raw[cursor++]);
          cursor = original + 1;
          if (changed && line.extra) { delete line.extra._pitavernReplies; delete line.extra._pitavernBeforeTurn; }
          next.push(changed ? JSON.stringify(line) : rev.raw[original]);
        } else next.push(JSON.stringify({ ...line, extra: { ...line.extra, messageId: randomUUID() } }));
      }
      next.push(...rev.raw.slice(cursor));
      if (changed) { delete metadata.projection; delete metadata.timedWorldInfo; delete metadata._pitavernEnforcement; }
      rev.header.chat_metadata = metadata;
      if (rev.hasHeader) next[0] = JSON.stringify(rev.header); else next.unshift(JSON.stringify(rev.header));
      const result = next.join("\n");
      this.replaceSource(chatId, rev.source, result.endsWith("\n") ? result : result + "\n");
    } };
  }

  saveAuthorNote(chatId: string, note: AuthorNoteDto, expectedRevision: string): void {
    const validated = validateAuthorNote(note);
    if (this.revisionId(chatId) !== expectedRevision) throw new Error("聊天已变化，请重新载入作者注释后再保存");
    const rev = this.revision(chatId);
    const metadata = { ...(rev.header.chat_metadata as Record<string, unknown> ?? {}),
      note_prompt: validated.text, note_interval: validated.interval, note_depth: validated.depth,
      note_position: validated.position, note_role: { system: 0, user: 1, assistant: 2 }[validated.role] };
    rev.header.chat_metadata = metadata;
    if (rev.hasHeader) rev.raw[0] = JSON.stringify(rev.header);
    else rev.raw.unshift(JSON.stringify(rev.header));
    this.replaceSource(chatId, rev.source, rev.raw.join("\n"));
  }

  editMessage(chatId: string, messageId: string, text: string, expectedText: string): void {
    if (!text.trim() || text.length > 1_000_000) throw new Error("消息不能为空且不能超过 100 万字符");
    const rev = this.revision(chatId);
    const index = rev.records.findIndex(({ line }, i) => (typeof line.extra?.messageId === "string" ? line.extra.messageId : "line-" + i) === messageId);
    const record = rev.records[index];
    if (!record || record.line.is_system) throw new Error("消息不存在，请刷新后重试");
    if (record.line.mes !== expectedText) throw new Error("消息已被修改，请刷新后重试");
    if (record.line.mes === text) return;
    const line = record.line;
    line.mes = text;
    line.extra = { ...line.extra, messageId: typeof line.extra?.messageId === "string" ? line.extra.messageId : randomUUID() };
    delete line.extra.summary;
    delete line.extra.thinking;
    delete line.extra.protocol;
    // Keep the currently selected ST swipe in agreement with mes.
    if (Array.isArray(line.swipes) && Number.isInteger(line.swipe_id) && line.swipe_id! >= 0 && line.swipe_id! < line.swipes.length) {
      line.swipes[line.swipe_id!] = text;
      const info = line.swipe_info?.[line.swipe_id!];
      if (info?.extra) { delete info.extra.summary; delete info.extra.thinking; }
    }
    rev.raw[record.rawIndex] = JSON.stringify(line);
    // A later turn's checkpoint was calculated from the old text and is no longer valid.
    for (const next of rev.records.slice(index + 1)) {
      if (next.line.extra?._pitavernBeforeTurn) {
        delete next.line.extra._pitavernBeforeTurn;
        rev.raw[next.rawIndex] = JSON.stringify(next.line);
      }
    }
    // Versions derived from edited history no longer have trustworthy state checkpoints.
    for (const [position, next] of rev.records.entries()) {
      if (!next.line.extra?._pitavernReplies) continue;
      const nextUser = rev.records.findIndex((entry, i) => i > position && entry.line.is_user && !entry.line.is_system);
      if (index < position || (index >= position && (nextUser < 0 || index < nextUser))) {
        const catalog = next.line.extra._pitavernReplies as ReplyVersions;
        if (Array.isArray(catalog.versions)) for (const version of catalog.versions) {
          if (version && typeof version === "object") { delete version.state; delete version.enforcement; }
        }
        rev.raw[next.rawIndex] = JSON.stringify(next.line);
      }
    }
    const metadata = { ...(rev.header.chat_metadata as Record<string, unknown> ?? {}) };
    delete metadata.projection;
    delete metadata.timedWorldInfo;
    delete metadata._pitavernEnforcement;
    rev.header.chat_metadata = metadata;
    if (rev.hasHeader) rev.raw[0] = JSON.stringify(rev.header);
    else rev.raw.unshift(JSON.stringify(rev.header));
    this.replaceSource(chatId, rev.source, rev.raw.join("\n"));
  }

  /** Stage the last user turn in memory. The old answer stays on disk until commit. */
  prepareRegeneration(chatId: string, messageId: string, expectedText: string, keepAlternatives = true) {
    const rev = this.revision(chatId);
    const lines = rev.records.map((r) => r.line);
    const latest = chatMessages(lines).at(-1);
    if (!latest || latest.id !== messageId || latest.text !== expectedText) throw new Error("最后一条消息已变化，请刷新后重试");
    const userIndex = lines.findLastIndex((line) => line.is_user && !line.is_system && line.mes.trim());
    if (userIndex < 0) throw new Error("请先发送一条消息，再重新生成回复");
    const document = this.readDocument(chatId)!;
    const { catalog } = lastReplies(lines, document.metadata);
    const metadata = structuredClone(document.metadata);
    const checkpoint = lines[userIndex].extra?._pitavernBeforeTurn as { metadata?: Record<string, unknown> } | undefined;
    for (const key of ["variables", "projection", "timedWorldInfo"]) {
      if (checkpoint?.metadata && Object.hasOwn(checkpoint.metadata, key)) metadata[key] = structuredClone(checkpoint.metadata[key]);
      else if (checkpoint?.metadata || key !== "variables") delete metadata[key];
    }
    // Replace assistant replies only; preserve system notes and unrecognized/raw lines in that turn.
    const removed = new Set(rev.records.slice(userIndex + 1).filter(({ line }) => !line.is_user && !line.is_system).map(({ rawIndex }) => rawIndex));
    const prefix = rev.raw.filter((_line, rawIndex) => !removed.has(rawIndex));
    while (prefix.at(-1) === "") prefix.pop();
    return {
      history: lines.slice(0, userIndex),
      user: lines[userIndex],
      metadata,
      commit: (messages: StChatLine[], nextMetadata: Record<string, unknown>) => {
        const header = { ...rev.header, chat_metadata: nextMetadata };
        const raw = [...prefix];
        let selected = messages;
        if (keepAlternatives && catalog.versions.length) {
          catalog.versions.push({ messages: structuredClone(messages), state: stateFields(nextMetadata) });
          catalog.selected = catalog.versions.length - 1;
          const user = structuredClone(lines[userIndex]);
          user.extra = { ...user.extra, _pitavernReplies: catalog };
          // All removed records follow this user, so its raw offset remains unchanged.
          raw[rev.records[userIndex].rawIndex] = JSON.stringify(user);
          selected = selectedMessages(catalog);
        }
        if (rev.hasHeader) raw[0] = JSON.stringify(header);
        else raw.unshift(JSON.stringify(header));
        this.replaceSource(chatId, rev.source, [...raw, ...selected.map((line) => JSON.stringify(line))].join("\n") + "\n", keepAlternatives);
      },
    };
  }

  selectReply(chatId: string, userMessageId: string, selected: number, expectedRevision: string): void {
    if (this.revisionId(chatId) !== expectedRevision) throw new Error("聊天已变化，请刷新后切换候选回复");
    const rev = this.revision(chatId);
    const metadata = (rev.header.chat_metadata ?? {}) as Record<string, unknown>;
    const { userIndex, choices, catalog } = lastReplies(rev.records.map((record) => record.line), metadata);
    if (!choices || choices.userMessageId !== userMessageId) throw new Error("仅支持切换最后一轮的候选回复");
    if (!Number.isInteger(selected) || selected < 0 || selected >= catalog.versions.length) throw new Error("候选回复不存在");
    if (selected === catalog.selected) return;
    catalog.selected = selected;
    const version = catalog.versions[selected];
    const user = rev.records[userIndex];
    user.line.extra = { ...user.line.extra, _pitavernReplies: catalog };
    rev.raw[user.rawIndex] = JSON.stringify(user.line);
    const removed = new Set(rev.records.slice(userIndex + 1).filter(({ line }) => !line.is_user && !line.is_system).map(({ rawIndex }) => rawIndex));
    const raw = rev.raw.filter((_line, index) => !removed.has(index));
    while (raw.at(-1) === "") raw.pop();
    rev.header.chat_metadata = restoreState(metadata, version.state);
    if (rev.hasHeader) raw[0] = JSON.stringify(rev.header);
    else raw.unshift(JSON.stringify(rev.header));
    this.replaceSource(chatId, rev.source, [...raw, ...selectedMessages(catalog).map((line) => JSON.stringify(line))].join("\n") + "\n");
  }

  deleteChat(chatId: string): boolean {
    const file = this.resolveChatFile(chatId);
    if (!file || !fs.existsSync(file)) return false;
    fs.rmSync(file);
    this.documents.delete(file);
    this.summaries.delete(file);
    return true;
  }
}
