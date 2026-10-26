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
