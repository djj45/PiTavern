import path from 'node:path';
import { crc32, inflateRaw } from 'node:zlib';
import { promisify } from 'node:util';
const inflate = promisify(inflateRaw);
export const CARD_ARCHIVE_LIMITS = { upload: 24 * 1024 ** 2, file: 32 * 1024 ** 2, total: 128 * 1024 ** 2, entries: 2000 };
export function archivePath(name: string): string {
  if (!name || name.length > 1000 || /[\\\x00-\x1f:]/.test(name) || name.startsWith('/') || name.split('/').some((part) => part === '.' || part === '..' || part === '') || path.posix.normalize(name) !== name) throw new Error('归档包含不安全路径');
  return name;
}
interface Entry { name: string; flags: number; method: number; crc: number; compressed: number; size: number; offset: number; nameBytes: Buffer }
/** Central-directory parser. Reject ZIP64, encryption, links and ambiguous/overlapping entries. */
export async function readCardArchive(buffer: Buffer): Promise<Map<string, Buffer>> {
  const limit = CARD_ARCHIVE_LIMITS;
  if (buffer.length > limit.upload || buffer.length < 22) throw new Error('角色归档大小无效（上限 24 MiB）');
  let end = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 22 - 65535); i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50 && i + 22 + buffer.readUInt16LE(i + 20) === buffer.length) { end = i; break; }
  }
  if (end < 0) throw new Error('ZIP 归档不完整');
  const count = buffer.readUInt16LE(end + 10);
  const centralSize = buffer.readUInt32LE(end + 12), centralOffset = buffer.readUInt32LE(end + 16);
  if (buffer.readUInt16LE(end + 4) || buffer.readUInt16LE(end + 6) || buffer.readUInt16LE(end + 8) !== count || count === 65535 || centralSize === 0xffffffff || centralOffset === 0xffffffff) throw new Error('不支持分卷或 ZIP64 角色归档');
  if (!count || count > limit.entries) throw new Error('角色归档最多 2000 个条目');
  // Offsets remain relative to ZIP data in JPEG-prefixed/SFX CharX files.
  const base = end - centralSize - centralOffset;
  if (base < 0 || centralSize < count * 46 || centralOffset + base < 0) throw new Error('ZIP 目录范围无效');
  const entries: Entry[] = [], names = new Set<string>();
  let cursor = centralOffset + base, expanded = 0;
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > end || buffer.readUInt32LE(cursor) !== 0x02014b50) throw new Error('ZIP 目录损坏');
    const flags = buffer.readUInt16LE(cursor + 8), method = buffer.readUInt16LE(cursor + 10);
    const compressed = buffer.readUInt32LE(cursor + 20), size = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28), extraLength = buffer.readUInt16LE(cursor + 30), commentLength = buffer.readUInt16LE(cursor + 32);
    const offset = buffer.readUInt32LE(cursor + 42) + base;
    const endOfEntry = cursor + 46 + nameLength + extraLength + commentLength;
    if (!nameLength || endOfEntry > end || flags & 1 || ![0, 8].includes(method) || buffer.readUInt16LE(cursor + 34) || (buffer.readUInt32LE(cursor + 38) >>> 16 & 0xf000) === 0xa000) throw new Error('不支持加密、链接或特殊压缩的角色归档');
    const nameBytes = buffer.subarray(cursor + 46, cursor + 46 + nameLength);
    const rawName = nameBytes.toString('utf8');
    if (!Buffer.from(rawName, 'utf8').equals(nameBytes)) throw new Error('归档文件名必须为 UTF-8');
    const directory = rawName.endsWith('/');
    const name = archivePath(directory ? rawName.slice(0, -1) : rawName);
    if (names.has(name)) throw new Error('归档包含重复路径');
    names.add(name);
    if (size > limit.file || compressed > limit.upload || offset < base || offset >= centralOffset + base || (directory && size !== 0)) throw new Error('归档文件大小或位置无效');
    expanded += size;
    if (expanded > limit.total) throw new Error('角色归档展开大小超过 128 MiB');
    entries.push({ name: directory ? name + '/' : name, flags, method, crc: buffer.readUInt32LE(cursor + 16), compressed, size, offset, nameBytes });
    cursor = endOfEntry;
  }
  if (cursor !== end) throw new Error('ZIP 目录长度不匹配');
  const filePaths = new Set(entries.filter((entry) => !entry.name.endsWith('/')).map((entry) => entry.name));
  for (const entry of entries) { const parts = entry.name.replace(/\/$/, '').split('/'); for (let i = 1; i < parts.length; i++) if (filePaths.has(parts.slice(0, i).join('/'))) throw new Error('归档文件与目录路径冲突'); }
  const output = new Map<string, Buffer>(), spans: [number, number][] = [];
  for (const entry of entries) {
    const { offset, compressed, size } = entry;
    if (offset + 30 > centralOffset + base || buffer.readUInt32LE(offset) !== 0x04034b50) throw new Error('ZIP 文件头损坏');
    const nameLength = buffer.readUInt16LE(offset + 26), extraLength = buffer.readUInt16LE(offset + 28);
    const start = offset + 30 + nameLength + extraLength, finish = start + compressed;
    if (finish > centralOffset + base || buffer.readUInt16LE(offset + 6) !== entry.flags || buffer.readUInt16LE(offset + 8) !== entry.method || !buffer.subarray(offset + 30, offset + 30 + nameLength).equals(entry.nameBytes)) throw new Error('ZIP 文件头与目录不一致');
    if (spans.some(([a, b]) => offset < b && finish > a)) throw new Error('ZIP 文件范围重叠');
    spans.push([offset, finish]);
    const payload = buffer.subarray(start, finish);
    const data = entry.method === 0 ? payload : await inflate(payload, { maxOutputLength: Math.min(limit.file, Math.max(1, size)) });
    if (data.length !== size || crc32(data) !== entry.crc) throw new Error('ZIP 文件长度或 CRC 校验失败');
    if (!entry.name.endsWith('/')) output.set(entry.name, data);
  }
  return output;
}
