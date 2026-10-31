import type { WorldTemplate, WorldTemplateSummaryDto } from "@pitavern/shared/world";
import { createWorldTemplateRecord } from "./index.ts";

interface CatalogEntry {
  name: string;
  description: string;
  template: WorldTemplate;
}

/** v0.1 内置模板；模板正文仍由聊天 JSONL 的模板表持有。 */
const ENTRIES: CatalogEntry[] = [
  {
    name: "酒馆买剑",
    description: "酒馆、掌柜和长剑的固定规则样本，用于验证金钱、库存、移动与时间。",
    template: {
      schemaVersion: 1, templateId: "tavern-sword", templateVersion: 1, rulesVersion: 1,
      locations: [
        { id: "tavern", name: "酒馆", description: "临街的旧酒馆，柜台后挂着账本。" },
        { id: "square", name: "集市", description: "白天喧闹、夜里只剩风声的集市。" },
      ],
      actors: [
        { id: "player", name: "旅人", description: "刚进城的旅行者。" },
        { id: "merchant", name: "掌柜", description: "酒馆掌柜，也做一点武器生意。" },
        { id: "bard", name: "吟游诗人", description: "坐在角落拨弦的诗人。" },
      ],
      items: [
        { id: "sword", name: "长剑", price: 30, description: "普通的铁制长剑。" },
        { id: "potion", name: "药水", price: 10, description: "能止血的草药酒。" },
      ],
      initial: {
        actorId: "player", locationId: "tavern", money: 100,
        inventory: [
          { ownerId: "merchant", itemId: "sword", quantity: 2 },
          { ownerId: "merchant", itemId: "potion", quantity: 3 },
        ],
      },
    },
  },
  {
    name: "雾港旅店",
    description: "雾港码头的短篇模板：防风灯、潮汐旅店和一位店主。",
    template: {
      schemaVersion: 1, templateId: "mist-harbor", templateVersion: 1, rulesVersion: 1,
      locations: [
        { id: "pier", name: "雾港码头", description: "终年潮湿的木栈桥。" },
        { id: "inn", name: "潮汐旅店", description: "门口挂着鲸骨招牌的小旅店。" },
      ],
      actors: [
        { id: "player", name: "旅人" },
        { id: "innkeeper", name: "店主", description: "寡言，但记得每个住客的名字。" },
      ],
      items: [
        { id: "lamp", name: "防风灯", price: 15, description: "雾夜里不会熄灭的铜灯。" },
      ],
      initial: {
        actorId: "player", locationId: "pier", money: 40,
        inventory: [{ ownerId: "innkeeper", itemId: "lamp", quantity: 2 }],
      },
    },
  },
];

const BUILTINS = ENTRIES.map((entry) => ({
  ...entry,
  record: createWorldTemplateRecord(entry.template),
}));

export function worldTemplateSummaries(): WorldTemplateSummaryDto[] {
  return BUILTINS.map(({ name, description, record }) => ({
    id: record.template.templateId,
    name,
    description,
    templateVersion: record.template.templateVersion,
    rulesVersion: record.template.rulesVersion,
    contentHash: record.contentHash,
    locations: record.template.locations.length,
    actors: record.template.actors.length,
    items: record.template.items.length,
  }));
}

export function getWorldTemplate(id: string): WorldTemplate | undefined {
  const entry = BUILTINS.find((candidate) => candidate.record.template.templateId === id);
  return entry ? structuredClone(entry.record.template) : undefined;
}

export function worldTemplateName(id: string): string {
  return ENTRIES.find((entry) => entry.template.templateId === id)?.name ?? id;
}
