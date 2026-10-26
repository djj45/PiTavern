import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { ChatMessageDto } from "@pitavern/shared";
import type { StChatLine } from "./types.ts";

export interface ChatMeta {
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
            name: obj.name, is_user: Boolean(obj.is_user), is_system: Boolean(obj.is_system),
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
    const dirs = character ? [this.characterChatsDir(character)]
      : fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => path.join(root, d.name));
    const metas: ChatMeta[] = [];
    for (const dir of dirs) {
      if (!fs.existsSync(dir)) continue;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
        const meta = this.statChat(path.join(dir, entry.name));
        if (meta) metas.push(meta);
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

  writeMetadata(chatId: string, metadata: Record<string, unknown>): void {
    const file = this.resolveChatFile(chatId);
    if (!file || !fs.existsSync(file)) throw new Error(`聊天文件不存在: ${chatId}`);
    const lines = fs.readFileSync(file, "utf8").split("\n");
    let header: Record<string, unknown> = {};
    try {
      const first = JSON.parse(lines[0] ?? "");
      if (first && typeof first === "object" && typeof first.mes !== "string") {
        header = first;
        lines.shift();
      }
    } catch { /* 无头文件需要补头 */ }
    header.chat_metadata = { ...(header.chat_metadata as object), ...metadata };
    fs.writeFileSync(file, [JSON.stringify(header), ...lines.filter((line) => line.trim())].join("\n") + "\n", "utf8");
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
    fs.appendFileSync(file, `${JSON.stringify(full)}\n`, "utf8");
    this.remember(file, { ...document, lines: [...document.lines, full] }, fs.statSync(file));
    return full;
  }

  createChat(character: string, greeting: (Omit<StChatLine, "send_date"> & { send_date?: string }) | null, userName = "User"): ChatMeta {
    const dir = this.characterChatsDir(character);
    fs.mkdirSync(dir, { recursive: true });
    let file = path.join(dir, stChatFileName());
    for (let i = 0; fs.existsSync(file); i++) file = path.join(dir, stChatFileName(new Date(Date.now() + (i + 1) * 1000)));
    const header = JSON.stringify({ user_name: userName, character_name: character, chat_metadata: {} });
    const first = greeting ? { ...greeting, send_date: greeting.send_date ?? new Date().toISOString() } : null;
    fs.writeFileSync(file, first ? `${header}\n${JSON.stringify(first)}\n` : `${header}\n`, "utf8");
    const meta = this.statChat(file);
    if (!meta) throw new Error("无法读取新建的聊天");
    return meta;
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
