import type { WorldEngineCapability, WorldEvent, WorldSnapshot, WorldTemplate } from "@pitavern/shared/world";

function actorLabel(id: string, template?: WorldTemplate): string {
  return template?.actors.find((entry) => entry.id === id)?.name ?? id;
}

function locationLabel(id: string, template?: WorldTemplate): string {
  return template?.locations.find((entry) => entry.id === id)?.name ?? id;
}

function itemLabel(id: string, template?: WorldTemplate): string {
  return template?.items.find((entry) => entry.id === id)?.name ?? id;
}

export function worldClockLabel(minutes: number): string {
  const day = Math.floor(minutes / 1440) + 1;
  const minute = minutes % 1440;
  return `第${day}天 ${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
}

function restrictionLabel(capability?: WorldEngineCapability): string | undefined {
  if (!capability || capability.mode === "enabled") return undefined;
  const kind = capability.mode === "disabled" ? "世界已禁用" : "世界为只读模式";
  return capability.reason ? `${kind}（${capability.reason}）` : kind;
}

/** 事件摘要优先用模板名称重排；旧存档只有原始 summary 时回退到原文。 */
function eventText(event: WorldEvent, template?: WorldTemplate): string {
  const actor = event.actorId ? actorLabel(event.actorId, template) : "";
  if (event.type === "purchase" && event.targetId && event.itemId && event.quantity !== undefined) {
    const cost = Math.abs(event.moneyDelta ?? 0);
    return `${actor} 花费 ${cost} 向 ${actorLabel(event.targetId, template)} 购买 ${event.quantity} 件${itemLabel(event.itemId, template)}`;
  }
  if (event.type === "transfer" && event.targetId && event.itemId && event.quantity !== undefined) {
    return `${actor} 向 ${actorLabel(event.targetId, template)} 转移 ${event.quantity} 件${itemLabel(event.itemId, template)}`;
  }
  // 移动事件摘要以 actorId 开头；替换为显示名，兼容已写入的旧事件。
  return event.actorId && event.summary.startsWith(event.actorId + " ")
    ? actor + event.summary.slice(event.actorId.length)
    : event.summary;
}

export interface WorldDigestOptions {
  /** 本轮模型是否能调用世界工具；默认 true。false 时不提示调用不存在的工具。 */
  toolsAvailable?: boolean;
}

export function worldDigest(
  snapshot: WorldSnapshot,
  template?: WorldTemplate,
  capability?: WorldEngineCapability,
  options: WorldDigestOptions = {},
): string {
  const toolsAvailable = options.toolsAvailable ?? true;
  const playerId = template?.initial.actorId;
  const scene = snapshot.scene;
  const present = scene.presentActorIds.map((id) => actorLabel(id, template)).join("、") || "无";
  const lines = [
    "### 当前世界状态",
    `时间：${worldClockLabel(snapshot.clockMinutes)}；地点：${locationLabel(scene.locationId, template)}`,
    `在场：${present}`,
  ];
  if (playerId && typeof snapshot.money[playerId] === "number") lines.push(`金钱：${snapshot.money[playerId]}`);
  if (playerId) {
    const inventory = snapshot.inventory.filter((entry) => entry.ownerId === playerId)
      .map((entry) => `${itemLabel(entry.itemId, template)}×${entry.quantity}`);
    lines.push(`随身物品：${inventory.join("、") || "无"}`);
  }
  const events = snapshot.recentEvents.slice(-3);
  if (events.length) lines.push("最近变化：" + events.map((event) => eventText(event, template)).join("；"));
  const restriction = restrictionLabel(capability);
  if (restriction) {
    lines.push(`${restriction}：本轮不要声称修改了金钱、物品、位置或时间。`);
    lines.push(toolsAvailable
      ? "需要精确状态或命令 ID 时调用 world_query（section=catalog/all）；本轮不能执行 world_command。"
      : "本轮没有可用的世界工具，只能依据以上摘要叙述。");
  } else if (toolsAvailable) {
    lines.push("需要精确状态、命令 ID 或完整目录时调用 world_query（section=catalog/all）；硬状态变化先用 world_command，命令返回 staged 只表示本轮暂存，整轮成功后才会提交。");
  } else {
    lines.push("本轮没有可用的世界工具；不要声称修改了金钱、物品、位置或时间。");
  }
  return lines.join("\n");
}

function eventsText(snapshot: WorldSnapshot, template?: WorldTemplate): string {
  return snapshot.recentEvents.length
    ? snapshot.recentEvents.map((event) => `${worldClockLabel(event.worldTimeMinutes)} · ${eventText(event, template)}`).join("\n")
    : "没有世界事件。";
}

/** 命令需要稳定 ID：查询结果同时给显示名、ID、价格和可用地点。 */
function catalogText(template: WorldTemplate | undefined, compact: boolean): string {
  if (!template) return "世界模板缺失，无法列出角色、地点和物品目录。";
  if (compact) {
    return [
      "角色：" + template.actors.map((actor) => `${actor.name}（${actor.id}）`).join("、"),
      "地点：" + template.locations.map((location) => `${location.name}（${location.id}）`).join("、"),
      "物品：" + template.items.map((item) => `${item.name}（${item.id}，价格 ${item.price}）`).join("、"),
    ].join("\n");
  }
  return [
    "角色：",
    ...template.actors.map((actor) => `- ${actor.name}（id: ${actor.id}）${actor.description ? `：${actor.description}` : ""}`),
    "",
    "地点：",
    ...template.locations.map((location) => `- ${location.name}（id: ${location.id}）${location.description ? `：${location.description}` : ""}`),
    "",
    "物品：",
    ...template.items.map((item) => `- ${item.name}（id: ${item.id}，价格 ${item.price}）${item.description ? `：${item.description}` : ""}`),
  ].join("\n");
}

export function worldStateText(
  snapshot: WorldSnapshot,
  template?: WorldTemplate,
  section: "summary" | "actors" | "inventory" | "events" | "catalog" | "all" = "summary",
  capability?: WorldEngineCapability,
): string {
  const restriction = restrictionLabel(capability);
  const restrictedNote = restriction ? `\n\n${restriction}，不能执行命令。` : "";
  if (section === "summary") {
    return `${worldDigest(snapshot, template, capability)}\n\n### 可用标识目录\n${catalogText(template, true)}`;
  }
  if (section === "actors") {
    const body = Object.values(snapshot.actors).map((actor) =>
      `${actorLabel(actor.id, template)}（${actor.id}）：${actor.status}，位于${locationLabel(actor.locationId, template)}（${actor.locationId}）`).join("\n") || "没有角色。";
    return body + restrictedNote;
  }
  if (section === "inventory") {
    const rows = snapshot.inventory.map((entry) =>
      `${actorLabel(entry.ownerId, template)}（${entry.ownerId}）：${itemLabel(entry.itemId, template)}（${entry.itemId}）×${entry.quantity}`);
    return (rows.length ? rows.join("\n") : "没有物品。") + restrictedNote;
  }
  if (section === "events") return eventsText(snapshot, template) + restrictedNote;
  if (section === "catalog") return catalogText(template, false) + restrictedNote;
  return [
    worldDigest(snapshot, template, capability),
    "",
    "角色：",
    Object.values(snapshot.actors).map((actor) => `- ${actorLabel(actor.id, template)}（${actor.id}）：${actor.status} @ ${locationLabel(actor.locationId, template)}（${actor.locationId}）`).join("\n"),
    "",
    "库存：",
    snapshot.inventory.map((entry) => `- ${actorLabel(entry.ownerId, template)}（${entry.ownerId}）：${itemLabel(entry.itemId, template)}（${entry.itemId}）×${entry.quantity}`).join("\n") || "- 无",
    "",
    "目录：",
    catalogText(template, false),
    "",
    "事件：",
    eventsText(snapshot, template),
  ].join("\n");
}
