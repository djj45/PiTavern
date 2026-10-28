import type { AuthorNoteDto } from "@pitavern/shared";

/** 与旧存档默认值一致；容忍导入元数据中的未知字段。 */
export function readAuthorNote(metadata: Record<string, unknown>): AuthorNoteDto {
  const integer = (value: unknown, fallback: number) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
  return {
    text: typeof metadata.note_prompt === "string" ? metadata.note_prompt : "",
    interval: integer(metadata.note_interval, 1),
    depth: integer(metadata.note_depth, 4),
    position: metadata.note_position === 0 || metadata.note_position === 2 ? metadata.note_position : 1,
    role: metadata.note_role === 1 || metadata.note_role === "user" ? "user"
      : metadata.note_role === 2 || metadata.note_role === "assistant" ? "assistant" : "system",
  };
}

export function validateAuthorNote(raw: unknown): AuthorNoteDto {
  if (!raw || typeof raw !== "object") throw new Error("作者注释参数无效");
  const note = raw as AuthorNoteDto;
  if (typeof note.text !== "string" || note.text.length > 100_000) throw new Error("作者注释不能超过 10 万字符");
  for (const key of ["interval", "depth"] as const) {
    if (!Number.isInteger(note[key]) || note[key] < 0 || note[key] > 1000) throw new Error("注释间隔和深度必须是 0～1000 的整数");
  }
  if (![0, 1, 2].includes(note.position) || !["system", "user", "assistant"].includes(note.role)) throw new Error("作者注释的位置或角色无效");
  return { text: note.text, interval: note.interval, depth: note.depth, position: note.position, role: note.role };
}
