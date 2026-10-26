import fs from "node:fs";
import path from "node:path";
import { parseCardFromPng } from "./png.ts";
import { normalizeCard, type CharacterCard } from "./types.ts";

interface CacheEntry {
  card: CharacterCard;
  mtimeMs: number;
}

/** characters/ 目录扫描器，按文件 mtime 缓存解析结果 */
export class CharacterStore {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(private readonly charactersDir: string) {}

  listCharacters(): CharacterCard[] {
    if (!fs.existsSync(this.charactersDir)) return [];
    const cards: CharacterCard[] = [];
    for (const file of fs.readdirSync(this.charactersDir).sort()) {
      const card = this.loadOne(path.join(this.charactersDir, file));
      if (card) cards.push(card);
    }
    return cards;
  }

  getCharacter(name: string): CharacterCard | undefined {
    return this.listCharacters().find((c) => c.name === name);
  }

  private loadOne(file: string): CharacterCard | undefined {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return undefined;
    const cached = this.cache.get(file);
    if (cached && cached.mtimeMs === stat.mtimeMs) return cached.card;

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
    this.cache.set(file, { card, mtimeMs: stat.mtimeMs });
    return card;
  }
}
