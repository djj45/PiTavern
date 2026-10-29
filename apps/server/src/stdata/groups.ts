import type { GroupChatDto } from "@pitavern/shared";
/** PiTavern group metadata lives in the JSONL header and survives normal exports. */
export function readGroup(metadata: Record<string, unknown>): GroupChatDto | undefined {
  const value = metadata._pitavernGroup as GroupChatDto | undefined;
  if (value === undefined) return;
  if (!value || typeof value.name !== "string" || !value.name.trim() || value.name.length > 100 ||
    !Array.isArray(value.members) || value.members.length < 2 || value.members.length > 12 ||
    value.members.some((name) => typeof name !== "string" || !name.trim()) || new Set(value.members).size !== value.members.length)
    throw new Error("群聊成员配置无效（需要 2–12 个不同角色）");
  return { name: value.name, members: [...value.members] };
}
export function groupSpeakers(metadata: Record<string, unknown>, primary: string, requested?: string[]): string[] {
  const group = readGroup(metadata);
  if (!group) { if (requested?.length) throw new Error("单人聊天不能指定群聊角色"); return [primary]; }
  const speakers = requested ?? group.members;
  if (!Array.isArray(speakers) || !speakers.length || speakers.length > 12 || new Set(speakers).size !== speakers.length ||
    speakers.some((name) => !group.members.includes(name))) throw new Error("发言角色必须来自本群且不能重复");
  return [...speakers];
}
