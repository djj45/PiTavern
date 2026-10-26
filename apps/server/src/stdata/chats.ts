import fs from "node:fs";
import path from "node:path";
import type { StChatLine } from "./types.ts";

export interface ChatMeta {
  /** 相对 stDataDir 的路径，作为 chatId */
  id: string;
  file: string;
  character: string;
  messageCount: number;
  lastMessage: string;
  updatedAt: string;
}

/** ST 的聊天文件名格式：2026-10-26@20h30m00s.jsonl */
function stChatFileName(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const d = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const t = `${pad(date.getHours())}h${pad(date.getMinutes())}m${pad(date.getSeconds())}s`;
  return `${d}@${t}.jsonl`;
}

/** ST 只对路径分隔符等少数字符做处理，这里保持一致以兼容真实 ST 数据目录 */
function characterDirName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, "_").trim() || "_";
}

function formatSendDate(date = new Date()): string {
  return date.toISOString();
}

export class ChatStore {
  constructor(private readonly stDataDir: string) {}

  private characterChatsDir(character: string): string {
    return path.join(this.stDataDir, "chats", characterDirName(character));
  }

  /** 把相对路径限制在 stDataDir 内，防目录穿越；非法返回 null */
  resolveChatFile(chatId: string): string | null {
    const file = path.resolve(this.stDataDir, chatId);
    const root = path.resolve(this.stDataDir);
    if (file !== root && !file.startsWith(root + path.sep)) return null;
    return file;
  }

  listChats(character?: string): ChatMeta[] {
    const chatsRoot = path.join(this.stDataDir, "chats");
    if (!fs.existsSync(chatsRoot)) return [];
    const dirs = character
      ? [this.characterChatsDir(character)]
      : fs.readdirSync(chatsRoot).map((d) => path.join(chatsRoot, d));
    const metas: ChatMeta[] = [];
    for (const dir of dirs) {
      if (!fs.existsSync(dir)) continue;
      for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort()) {
        const meta = this.statChat(path.join(dir, file));
        if (meta) metas.push(meta);
      }
    }
    return metas.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  statChat(file: string): ChatMeta | null {
    let lines: StChatLine[];
    try {
      lines = this.readLines(file);
    } catch {
      return null;
    }
    if (lines.length === 0) return null;
    const relPath = path.relative(this.stDataDir, file).split(path.sep).join("/");
    const last = lines[lines.length - 1];
    return {
      id: relPath,
      file,
      character: lines[0]?.name ?? path.basename(path.dirname(file)),
      messageCount: lines.length,
      lastMessage: (last.mes ?? "").slice(0, 80),
      updatedAt: new Date(fs.statSync(file).mtimeMs).toISOString(),
    };
  }

  readLines(file: string): StChatLine[] {
    const raw = fs.readFileSync(file, "utf8");
    const lines: StChatLine[] = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const obj = JSON.parse(trimmed);
        if (typeof obj?.mes === "string" && typeof obj?.name === "string") {
          lines.push({
            name: obj.name,
            is_user: Boolean(obj.is_user),
            is_system: Boolean(obj.is_system),
            send_date: typeof obj.send_date === "string" ? obj.send_date : "",
            mes: obj.mes,
            extra: obj.extra,
          });
        }
      } catch {
        // 跳过损坏行，保持与 ST 宽松读取行为一致
      }
    }
    return lines;
  }

  readChat(chatId: string): StChatLine[] | null {
    const file = this.resolveChatFile(chatId);
    if (!file || !fs.existsSync(file)) return null;
    return this.readLines(file);
  }

  /**
   * ST 约定：JSONL 首行是头对象 {user_name, character_name, chat_metadata}（无 mes 字段）。
   * 变量等工具数据存放在 chat_metadata.variables。
   */
  readMetadata(chatId: string): Record<string, unknown> {
    const file = this.resolveChatFile(chatId);
    if (!file || !fs.existsSync(file)) return {};
    const first = fs.readFileSync(file, "utf8").split("\n", 1)[0]?.trim();
    if (!first) return {};
    try {
      const obj = JSON.parse(first);
      if (obj && typeof obj === "object" && typeof obj.mes !== "string") {
        return (obj.chat_metadata as Record<string, unknown>) ?? {};
      }
    } catch {
      // 无头或损坏 → 空元数据
    }
    return {};
  }

  /** 更新首行 chat_metadata（原位重写，保留其余消息行） */
  writeMetadata(chatId: string, metadata: Record<string, unknown>): void {
    const file = this.resolveChatFile(chatId);
    if (!file || !fs.existsSync(file)) throw new Error(`聊天文件不存在: ${chatId}`);
    const raw = fs.readFileSync(file, "utf8");
    const lines = raw.split("\n");
    let header: Record<string, unknown>;
    const first = lines[0]?.trim();
    if (first) {
      try {
        const obj = JSON.parse(first);
        if (obj && typeof obj === "object" && typeof obj.mes !== "string") {
          header = obj;
          lines.shift();
        } else {
          header = {};
        }
      } catch {
        header = {};
      }
    } else {
      header = {};
    }
    header.chat_metadata = { ...(header.chat_metadata as object), ...metadata };
    fs.writeFileSync(file, [JSON.stringify(header), ...lines.filter((l) => l.trim().length > 0)].join("\n") + "\n", "utf8");
  }

  appendMessage(chatId: string, line: Omit<StChatLine, "send_date"> & { send_date?: string }): void {
    const file = this.resolveChatFile(chatId);
    if (!file || !fs.existsSync(file)) throw new Error(`聊天文件不存在: ${chatId}`);
    const full: StChatLine = { ...line, send_date: line.send_date ?? formatSendDate() };
    fs.appendFileSync(file, `${JSON.stringify(full)}\n`, "utf8");
  }

  createChat(
    character: string,
    greeting: (Omit<StChatLine, "send_date"> & { send_date?: string }) | null,
    userName = "User",
  ): ChatMeta {
    const dir = this.characterChatsDir(character);
    fs.mkdirSync(dir, { recursive: true });
    let file = path.join(dir, stChatFileName());
    // 同秒内重复建卡时避让
    for (let i = 0; fs.existsSync(file); i++) {
      file = path.join(dir, stChatFileName(new Date(Date.now() + (i + 1) * 1000)));
    }
    const header = JSON.stringify({
      user_name: userName,
      character_name: character,
      chat_metadata: {},
    });
    const content = greeting ? `${header}\n${JSON.stringify(greeting)}\n` : `${header}\n`;
    fs.writeFileSync(file, content, "utf8");
    return this.statChat(file)!;
  }

  deleteChat(chatId: string): boolean {
    const file = this.resolveChatFile(chatId);
    if (!file || !fs.existsSync(file)) return false;
    fs.rmSync(file);
    return true;
  }
}
