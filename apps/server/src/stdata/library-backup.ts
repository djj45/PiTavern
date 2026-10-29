import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { Readable, Transform, type TransformCallback } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip, createGunzip } from "node:zlib";
import type { LibraryBackupPreviewDto } from "@pitavern/shared";
import type { TavernConfig } from "../config.ts";
import { saveConfig, seedDataDirs } from "../config.ts";
import { object } from "./files.ts";

const ROOTS = ["characters", "chats", "worlds", "OpenAI Settings", "skills", ".pitavern"];
const MAX_FILE = 32 * 1024 * 1024;
const MAX_TOTAL = 2 * 1024 * 1024 * 1024;
const MAX_ARCHIVE = 512 * 1024 * 1024;
const MAX_FILES = 100000;
const MAX_LINE = Math.ceil(MAX_FILE * 4 / 3) + 16384;
const digest = (buffer: Buffer) => createHash("sha256").update(buffer).digest("hex");

class ByteLimit extends Transform {
  private bytes = 0;
  constructor(private readonly limit: number) { super(); }
  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    this.bytes += chunk.length;
    callback(this.bytes > this.limit ? new Error("归档超过大小上限") : null, chunk);
  }
}

/** File-sized lines with an explicit ceiling, rather than an unbounded readline buffer. */
async function* lines(stream: Readable): AsyncGenerator<string> {
  let chunks: Buffer[] = [];
  let size = 0;
  for await (const value of stream) {
    const chunk = Buffer.from(value);
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(10, offset);
      const part = chunk.subarray(offset, newline < 0 ? chunk.length : newline);
      size += part.length;
      if (size > MAX_LINE) throw new Error("归档文件行超过大小上限");
      chunks.push(part);
      if (newline < 0) break;
      yield Buffer.concat(chunks, size).toString("utf8");
      chunks = []; size = 0; offset = newline + 1;
    }
  }
  if (size) throw new Error("归档缺少完整结尾");
}

function allowed(relative: string): boolean {
  const parts = relative.split("/");
  return parts.length >= 2 && ROOTS.includes(parts[0]) &&
    !parts.some((p) => !p || p === "." || p === ".." || /[\\\x00-\x1f]/.test(p)) &&
    !(parts[0] === ".pitavern" && parts[1] === "vectors") &&
    !parts.at(-1)!.startsWith(".pitavern-write-") && !parts.at(-1)!.endsWith(".tmp");
}

interface SourceFile { relative: string; size: number; mtimeMs: number; ctimeMs: number }

function inventory(root: string): SourceFile[] {
  const files: SourceFile[] = [];
  let bytes = 0;
  const walk = (relative: string): void => {
    if (relative === ".pitavern/vectors") return;
    const target = path.join(root, relative);
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink()) throw new Error(`备份不跟随符号链接：${relative}`);
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(target).sort()) walk(`${relative}/${name}`);
    } else if (stat.isFile() && allowed(relative)) {
      bytes += stat.size;
      if (stat.size > MAX_FILE || bytes > MAX_TOTAL || files.length >= MAX_FILES) throw new Error("资料库超过备份大小上限（单文件 32 MiB、总计 2 GiB、10 万文件）");
      files.push({ relative, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs });
    } else if (!stat.isFile()) throw new Error(`不支持的资料类型：${relative}`);
  };
  for (const name of ROOTS) if (fs.existsSync(path.join(root, name))) walk(name);
  return files;
}

export class LibraryBackupStore {
  private readonly previews = new Map<string, { dto: LibraryBackupPreviewDto; archive: string; checksum: string }>();
  readonly maintenanceDir: string;
  constructor(private readonly root: string) {
    this.maintenanceDir = path.join(path.dirname(root), `.${path.basename(root)}-maintenance`);
  }

  discard(id: string): void { this.previews.delete(id); }

  async export(): Promise<string> {
    fs.mkdirSync(this.maintenanceDir, { recursive: true, mode: 0o700 });
    const archive = path.join(this.maintenanceDir, `backup-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}.pitavern.gz`);
    const sources = inventory(this.root);
    const root = this.root;
    const records = async function* () {
      yield JSON.stringify({ format: "pitavern-library", version: 1, createdAt: new Date().toISOString() }) + "\n";
      const checksums = createHash("sha256");
      let bytes = 0;
      for (const source of sources) {
        const buffer = await fs.promises.readFile(path.join(root, source.relative));
        if (buffer.length !== source.size) throw new Error("备份期间源文件发生变化，请重新导出");
        const sha256 = digest(buffer);
        checksums.update(`${source.relative}\0${sha256}\n`);
        bytes += buffer.length;
        yield JSON.stringify({ path: source.relative, sha256, data: buffer.toString("base64") }) + "\n";
      }
      if (JSON.stringify(inventory(root)) !== JSON.stringify(sources)) throw new Error("备份期间资料库发生变化，请重新导出");
      yield JSON.stringify({ end: true, files: sources.length, bytes, sha256: checksums.digest("hex") }) + "\n";
    };
    try {
      await pipeline(Readable.from(records()), createGzip(), new ByteLimit(MAX_ARCHIVE), fs.createWriteStream(archive, { flags: "wx", mode: 0o600 }));
      return archive;
    } catch (error) {
      // Keep a failed artifact for diagnosis, but never advertise it as a complete backup.
      if (fs.existsSync(archive)) fs.renameSync(archive, archive + ".incomplete");
      throw error;
    }
  }

  private async extract(archive: string, target: string, id: string): Promise<LibraryBackupPreviewDto & { checksum: string }> {
    const decoded = new Transform({ transform(chunk, _encoding, callback) { callback(null, chunk); } });
    const pumping = pipeline(fs.createReadStream(archive), createGunzip(), new ByteLimit(MAX_TOTAL * 1.4 + MAX_FILES * 2048), decoded);
    // Attach the rejection handler immediately; parsing and decompression run concurrently.
    void pumping.catch(() => {});
    const seen = new Set<string>();
    const checksums = createHash("sha256");
    const counts: Record<string, number> = {};
    let bytes = 0;
    let createdAt = "";
    let ended = false;
    let checksum = "";
    let first = true;
    try {
      for await (const line of lines(decoded)) {
        const record: unknown = JSON.parse(line);
        if (!object(record) || ended) throw new Error("归档记录结构无效");
        if (first) {
          first = false;
          if (record.format !== "pitavern-library" || record.version !== 1 || typeof record.createdAt !== "string" || !Number.isFinite(Date.parse(record.createdAt))) throw new Error("不支持的备份格式或版本");
          createdAt = record.createdAt;
          continue;
        }
        if (record.end === true) {
          checksum = checksums.digest("hex");
          if (record.files !== seen.size || record.bytes !== bytes || record.sha256 !== checksum) throw new Error("归档汇总校验失败");
          ended = true; continue;
        }
        if (typeof record.path !== "string" || !allowed(record.path) || seen.has(record.path) ||
          typeof record.data !== "string" || typeof record.sha256 !== "string") throw new Error("归档文件记录无效");
        const buffer = Buffer.from(record.data, "base64");
        if (buffer.toString("base64") !== record.data || digest(buffer) !== record.sha256) throw new Error("归档文件校验失败");
        bytes += buffer.length;
        if (buffer.length > MAX_FILE || bytes > MAX_TOTAL || seen.size >= MAX_FILES) throw new Error("展开后资料库超过大小上限");
        const file = path.join(target, record.path);
        fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
        fs.writeFileSync(file, buffer, { flag: "wx", mode: 0o600 });
        seen.add(record.path);
        checksums.update(`${record.path}\0${record.sha256}\n`);
        const category = record.path.split("/")[0];
        counts[category] = (counts[category] ?? 0) + 1;
      }
      await pumping;
      if (!ended) throw new Error("归档不完整，缺少汇总记录");
      return { id, createdAt, files: seen.size, bytes, counts, checksum };
    } catch (error) {
      decoded.destroy(); await pumping.catch(() => {}); throw error;
    }
  }

  async preview(input: Readable): Promise<LibraryBackupPreviewDto> {
    if (this.previews.size >= 3) throw new Error("已有 3 份待恢复归档；请取消不需要的预览后再导入");
    const id = randomUUID();
    const dir = path.join(this.maintenanceDir, `import-${id}`);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const archive = path.join(dir, "source.pitavern.gz");
    await pipeline(input, new ByteLimit(MAX_ARCHIVE), fs.createWriteStream(archive, { flags: "wx", mode: 0o600 }));
    const { checksum, ...dto } = await this.extract(archive, path.join(dir, "preview"), id);
    this.previews.set(id, { dto, archive, checksum });
    return dto;
  }

  async restore(id: string, config: TavernConfig): Promise<{ stDataDir: string; previousDataDir: string; restartRequired: true }> {
    const preview = this.previews.get(id);
    if (!preview) throw new Error("预览已失效，请重新上传归档");
    const target = fs.mkdtempSync(path.join(path.dirname(this.root), `${path.basename(this.root)}-restored-`));
    // Re-validate the original archive; never trust mutable preview files.
    const actual = await this.extract(preview.archive, target, id);
    const { checksum, ...dto } = actual;
    if (checksum !== preview.checksum || JSON.stringify(dto) !== JSON.stringify(preview.dto)) throw new Error("归档在预览后发生变化，请重新上传");
    seedDataDirs(target);
    const next = { ...config, stDataDir: target };
    saveConfig(next);
    Object.assign(config, next);
    this.previews.delete(id);
    return { stDataDir: target, previousDataDir: this.root, restartRequired: true };
  }
}
