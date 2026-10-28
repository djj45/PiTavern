import type { ChatMessageDto, ToolActivityDto } from "@pitavern/shared";

export interface ToolItem extends ToolActivityDto {
  kind: "tool";
}

export type ChatItem = ChatMessageDto | ToolItem;

export function isToolItem(item: ChatItem): item is ToolItem {
  return (item as ToolItem).kind === "tool";
}

/** 工具显示元数据 */
export const TOOL_META: Record<string, { icon: string; label: string }> = {
  worldbook_search: { icon: "📖", label: "世界书" },
  tavern_recall_history: { icon: "🧠", label: "历史召回" },
  tavern_read_variables: { icon: "📊", label: "存档变量" },
  tavern_read_skill_reference: { icon: "📜", label: "Skill 参考" },
};

export function toolArgPreview(toolName: string, args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const a = args as Record<string, unknown>;
  const parts: string[] = [];
  if (typeof a.query === "string" && a.query) parts.push(`“${a.query}”`);
  if (typeof a.turn === "number") parts.push(`第${a.turn}轮${typeof a.radius === "number" ? `±${a.radius}` : ""}`);
  if (Array.isArray(a.refs) && a.refs.length) parts.push(`refs:${a.refs.join(",")}`);
  if (typeof a.path === "string" && a.path) parts.push(a.path);
  if (typeof a.action === "string") parts.push(a.action);
  if (typeof a.name === "string" && a.name) parts.push(a.name);
  return parts.join(" · ");
}
