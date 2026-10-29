/**
 * 零依赖 PNG tEXt 解析：SillyTavern 把角色卡 JSON base64 后
 * 存在 tEXt chunk 里（V2 关键字 chara，V3 关键字 ccv3）。
 */

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** 提取所有 tEXt chunk 为 { keyword: text }，非 PNG 或损坏文件返回 null */
export function extractPngTextChunks(buffer: Buffer): Record<string, string> | null {
  if (buffer.length < 8 + 12 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  const chunks: Record<string, string> = {};
  let offset = 8;
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("latin1", offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > buffer.length) break;
    if (type === "tEXt") {
      const data = buffer.subarray(dataStart, dataEnd);
      const zero = data.indexOf(0);
      if (zero > 0) {
        const keyword = data.toString("latin1", 0, zero);
        const text = data.toString("latin1", zero + 1);
        chunks[keyword] = text;
      }
    }
    if (type === "IEND") break;
    offset = dataEnd + 4;
  }
  return chunks;
}

/**
 * 从 PNG buffer 解析角色卡 JSON。优先 V3 (ccv3)，回退 V2 (chara)。
 * 返回原始 JSON 对象（含 spec / data 字段），失败返回 null。
 */
export function parseCardFromPng(buffer: Buffer): { spec: string; data: unknown } | null {
  const chunks = extractPngTextChunks(buffer);
  if (!chunks) return null;
  for (const keyword of ["ccv3", "chara"]) {
    const encoded = chunks[keyword];
    if (!encoded) continue;
    try {
      const json = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
      const spec = typeof json?.spec === "string" ? json.spec : keyword === "ccv3" ? "chara_card_v3" : "chara_card_v2";
      // 规范卡在 data 字段；老卡可能平铺
      const data = json?.data && typeof json.data === "object" ? json.data : json;
      return { spec, data };
    } catch {
      // 单个关键字损坏时继续尝试下一个
    }
  }
  return null;
}

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Update both card formats, preserving pixels, other chunks and unknown JSON fields. */
export function rewritePngRegex(buffer: Buffer, scripts: unknown[]): Buffer {
  return rewritePngCard(buffer, (card) => {
    if (card.extensions != null && (typeof card.extensions !== "object" || Array.isArray(card.extensions))) throw new Error("卡片 extensions 不是对象");
    card.extensions = { ...card.extensions as Record<string, unknown>, regex_scripts: scripts };
  });
}

/** Rewrite card metadata in both V2/V3 chunks without changing image or unrelated metadata. */
export function rewritePngCard(buffer: Buffer, update: (card: Record<string, unknown>) => void): Buffer {
  if (!parseCardFromPng(buffer)) throw new Error("PNG 没有有效角色卡");
  const result = [buffer.subarray(0, 8)];
  let offset = 8;
  let updated = 0;
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const end = offset + length + 12;
    if (end > buffer.length) throw new Error("PNG 数据不完整");
    const type = buffer.toString("latin1", offset + 4, offset + 8);
    let chunk = buffer.subarray(offset, end);
    if (type === "tEXt") {
      const data = buffer.subarray(offset + 8, end - 4);
      const zero = data.indexOf(0);
      const keyword = data.toString("latin1", 0, Math.max(0, zero));
      if (keyword === "chara" || keyword === "ccv3") {
        const raw = JSON.parse(Buffer.from(data.subarray(zero + 1).toString("latin1"), "base64").toString("utf8"));
        const card = raw?.data && typeof raw.data === "object" ? raw.data : raw;
        if (!card || typeof card !== "object" || Array.isArray(card)) throw new Error("PNG 卡片结构无效");
        update(card);
        const payload = Buffer.from(`${keyword}\0${Buffer.from(JSON.stringify(raw)).toString("base64")}`, "latin1");
        chunk = Buffer.alloc(payload.length + 12);
        chunk.writeUInt32BE(payload.length, 0);
        chunk.write("tEXt", 4, "latin1");
        payload.copy(chunk, 8);
        chunk.writeUInt32BE(crc32(chunk.subarray(4, chunk.length - 4)), chunk.length - 4);
        updated++;
      }
    }
    result.push(chunk);
    offset = end;
    if (type === "IEND") {
      if (!updated) throw new Error("PNG 没有可编辑的角色卡");
      result.push(buffer.subarray(offset));
      return Buffer.concat(result);
    }
  }
  throw new Error("PNG 缺少结束块");
}
