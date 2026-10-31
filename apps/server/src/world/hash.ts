import { createHash } from "node:crypto";

/** 只用于已校验的 JSON 契约；对象键排序，数组顺序保留，undefined 可选字段按 JSON 规则省略。 */
export function worldContentHash(value: unknown): string {
  const canonical = JSON.stringify(value, (_key, entry: unknown) => {
    if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      return Object.fromEntries(Object.keys(entry).sort().map((key) => [key, (entry as Record<string, unknown>)[key]]));
    }
    return entry;
  });
  return createHash("sha256").update(canonical).digest("hex");
}
