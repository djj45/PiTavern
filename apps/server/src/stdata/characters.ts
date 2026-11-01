import fs from "node:fs";
import path from "node:path";
import { parseCardFromPng } from "./png.ts";
import { importedAvatar } from "./card-import.ts";
import { normalizeCard, type CharacterCard } from "./types.ts";

export interface CharacterStoreEntry {
  card: CharacterCard;
  /** 角色卡文件绝对路径（管理/保存时作为稳定文件标识，不写入 CharacterCard）。 */
  file: string;
}

interface CacheEntry {
  card: CharacterCard;
  mtimeMs: number;
}

/** characters/ 目录扫描器，按文件 mtime 缓存解析结果 */
export class CharacterStore {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(private readonly charactersDir: string) {}

  invalidate(): void { this.cache.clear(); }

  /** 列出全部有效角色卡及绝对文件路径；保留原有 listCharacters 行为供调用方使用。 */
  listEntries(): CharacterStoreEntry[] {
    if (!fs.existsSync(this.charactersDir)) return [];
    const entries: CharacterStoreEntry[] = [];
    for (const name of fs.readdirSync(this.charactersDir).sort()) {
      const entry = this.loadOne(path.resolve(this.charactersDir, name));
      if (entry) entries.push(entry);
    }
    return entries;
  }

  listCharacters(): CharacterCard[] {
    return this.listEntries().map((entry) => entry.card);
  }

  getEntry(name: string): CharacterStoreEntry | undefined {
    return this.listEntries().find((entry) => entry.card.name === name);
  }

  getCharacter(name: string): CharacterCard | undefined {
    return this.getEntry(name)?.card;
  }

  private loadOne(file: string): CharacterStoreEntry | undefined {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return undefined;
    const cached = this.cache.get(file);
    if (cached && cached.mtimeMs === stat.mtimeMs) return { card: cached.card, file };

    let parsed: { spec: string; data: unknown } | null = null;
    let avatarFile = "";
    if (file.toLowerCase().endsWith(".png")) {
      parsed = parseCardFromPng(fs.readFileSync(file));
      avatarFile = file;
    } else if (file.toLowerCase().endsWith(".json")) {
      try {
        const json = JSON.parse(fs.readFileSync(file, "utf8"));
        const spec = typeof json?.spec === "string" ? json.spec : "chara_card_v2";
        parsed = { spec, data: json?.data && typeof json.data === "object" ? json.data : json };
      } catch {
        parsed = null;
      }
    }
    if (!parsed || typeof (parsed.data as { name?: unknown })?.name !== "string") return undefined;

    const card = normalizeCard(parsed.spec, parsed.data as Record<string, unknown>, avatarFile);
    if (!card.avatarFile) card.avatarFile = importedAvatar(path.dirname(this.charactersDir), card.extensions);
    this.cache.set(file, { card, mtimeMs: stat.mtimeMs });
    return { card, file };
  }
}
