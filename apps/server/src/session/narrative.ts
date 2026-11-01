import { randomUUID } from "node:crypto";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import type { WorldModelSnapshot, WorldTemplate } from "@pitavern/shared/world";
import { WORLD_TEMPLATES_KEY } from "@pitavern/shared/world";
import { worldContentHash } from "../world/hash.ts";
import { stateFields } from "../stdata/replies.ts";
import type { StChatLine } from "../stdata/types.ts";

export const NARRATIVE_KEY = "_pitavernNarrative";
export const NARRATIVE_TEXT_KEY = "_pitavernNarrativeTextHash";
const strict = { additionalProperties: false };
const text = (maxLength: number) => Type.String({ minLength: 1, maxLength });
const id = text(128);
const hash = Type.String({ pattern: "^[a-f0-9]{64}$" });
export const narrativePlanSchema = Type.Object({
  scene: text(1000),
  beats: Type.Array(text(1000), { minItems: 1, maxItems: 12 }),
  dialogue: Type.Array(text(1000), { maxItems: 12 }),
  references: Type.Array(Type.Object({
    kind: Type.Union([Type.Literal("actor"), Type.Literal("fact"), Type.Literal("event")]), id,
  }, strict), { maxItems: 32 }),
}, strict);
export type NarrativePlan = Static<typeof narrativePlanSchema>;
const sampling = Type.Object({
  temperature: Type.Optional(Type.Number()), maxTokens: Type.Optional(Type.Integer({minimum:1,maximum:1_000_000})),
  samplingParams: Type.Optional(Type.Object({top_p:Type.Optional(Type.Number()),top_k:Type.Optional(Type.Number()),min_p:Type.Optional(Type.Number()),frequency_penalty:Type.Optional(Type.Number()),presence_penalty:Type.Optional(Type.Number()),repetition_penalty:Type.Optional(Type.Number())},strict)),
},strict);
const packetSchema = Type.Object({
  version: Type.Literal(1), settlementId: id, turnId: id,
  stateHash: hash, sourceHash: hash, templateSourceHash: hash,
  templateHash: hash, viewpointId: Type.String({ maxLength: 128 }), knowledgeKey: hash,
  // Never trust this imported field by itself: eligibility requires exact equality
  // with a freshly built player projection, and rendering uses that fresh view.
  state: Type.Unknown(), events: Type.Array(Type.Unknown(), { maxItems: 100 }),
  plan: narrativePlanSchema,
  writing: Type.Object({ settings: text(32000), input: text(32000), direction: Type.String({ maxLength: 4000 }), sampling: Type.Optional(sampling) }, strict),
  digest: hash,
}, strict);
export type NarrativePacket = Static<typeof packetSchema> & { state: WorldModelSnapshot; events: WorldModelSnapshot["recentEvents"] };

export function validatePlan(input: unknown, view: WorldModelSnapshot): NarrativePlan {
  if (!Value.Check(narrativePlanSchema, input)) throw new Error("叙事计划格式或长度无效");
  const allowed = { actor: new Set(Object.keys(view.actors)), fact: new Set(view.knownFacts.map(f => f.id)), event: new Set(view.recentEvents.map(e => e.id)) };
  for (const ref of input.references) if (!allowed[ref.kind].has(ref.id)) throw new Error("叙事计划包含不可见或不存在的引用");
  return structuredClone(input);
}

export function narrativeSource(lines: StChatLine[]): string {
  return worldContentHash(lines.filter(line => !line.is_system && line.mes.trim()).map(line => ({ name: line.name, user: line.is_user, system: line.is_system,
    text: line.mes, id: line.extra?.messageId })));
}
export function narrativeState(metadata: Record<string, unknown>): string { return worldContentHash(stateFields(metadata)); }
export function narrativeTemplates(metadata: Record<string, unknown>): string { return worldContentHash(metadata[WORLD_TEMPLATES_KEY] ?? null); }

export function parseNarrative(input: unknown): NarrativePacket {
  if (JSON.stringify(input)?.length > 250_000 || !Value.Check(packetSchema, input)) throw new Error("缺少有效叙事数据包，无法只重写正文");
  const { digest, ...body } = input;
  if (digest !== worldContentHash(body)) throw new Error("叙事数据包损坏，无法只重写正文");
  return structuredClone(input) as NarrativePacket;
}

export function createNarrative(input: {
  turnId: string; metadata: Record<string, unknown>; source: StChatLine[]; before: WorldModelSnapshot;
  view: WorldModelSnapshot; plan: unknown; writing: NarrativePacket["writing"];
}): NarrativePacket {
  const old = new Set(input.before.recentEvents.map(e => e.id));
  const body = {
    version: 1 as const, settlementId: randomUUID(), turnId: input.turnId,
    stateHash: narrativeState(input.metadata), sourceHash: narrativeSource(input.source), templateSourceHash: narrativeTemplates(input.metadata),
    templateHash: input.view.templateHash, viewpointId: input.view.viewpointId, knowledgeKey: input.view.knowledgeKey,
    state: structuredClone(input.view), events: input.view.recentEvents.filter(e => !old.has(e.id)),
    plan: validatePlan(input.plan, input.view), writing: input.writing,
  };
  return parseNarrative({ ...body, digest: worldContentHash(body) });
}

export function validateNarrative(input: unknown, metadata: Record<string, unknown>, source: StChatLine[], view: WorldModelSnapshot): NarrativePacket {
  const packet = parseNarrative(input);
  const user = source.filter(line => !line.is_system && line.mes.trim()).at(-1);
  if (!user?.is_user || user.extra?.messageId !== packet.turnId) throw new Error("叙事数据包不属于当前回合");
  if (packet.stateHash !== narrativeState(metadata) || packet.sourceHash !== narrativeSource(source) ||
      packet.templateSourceHash !== narrativeTemplates(metadata) || packet.templateHash !== view.templateHash ||
      packet.viewpointId !== view.viewpointId || packet.knowledgeKey !== view.knowledgeKey ||
      worldContentHash(packet.state) !== worldContentHash(view)) throw new Error("状态、知识、历史或模板已变化，不能沿用旧结算重写正文");
  validatePlan(packet.plan, view);
  const actual = new Map(view.recentEvents.map(e => [e.id, worldContentHash(e)]));
  for (const event of packet.events) if (actual.get(event.id) !== worldContentHash(event)) throw new Error("叙事事件来源已变化");
  return packet;
}

export const SETTLEMENT_INSTRUCTION = "本轮采用双阶段生成。先执行必要工具完成结算，只能通过 submit_narrative_plan 结束结算。不要输出正文；计划不能自填或改写金钱、库存、时间、知识授权或工具成功结果。引用只能使用当前玩家可见的角色、事实与事件 ID。提交计划后不得再调用任何工具。";

export function narrativeCatalog(template?: WorldTemplate) {
  const names = (items: Array<{id:string;name:string}>) => items.map(({id,name})=>({id,name}));
  return {actors:names(template?.actors??[]),locations:names(template?.locations??[]),items:names(template?.items??[])};
}

export function narrativePrompt(packet: NarrativePacket, view: WorldModelSnapshot, instruction = "", catalog?: ReturnType<typeof narrativeCatalog>): string {
  // Pass a known, server-built projection, not an arbitrary imported packet field.
  return JSON.stringify({ protocol: "pitavern-narrative-v1", settlementId: packet.settlementId,
    displayNames: catalog ?? narrativeCatalog(), authoritativeState: view, visibleEvents: packet.events, suggestedPlan: packet.plan,
    writingRequest: { originalInput: packet.writing.input, originalDirection: packet.writing.direction, rewriteDirection: instruction } });
}

export const REQUEST_KEY = "_pitavernGenerationRequest";
export interface GenerationRequest { requestId: string; revision: string }
export function requestFingerprint(value: unknown): string { return worldContentHash(value); }
/** Only committed reply metadata counts as a receipt; never user/model prose. */
export function findGenerationRequest(source: string, id: string, fingerprint: string): boolean {
  let found = false;
  const walk = (value: unknown, depth = 0): void => {
    if (depth > 64 || !value || typeof value !== "object") return;
    if (Array.isArray(value)) { for (const item of value) walk(item, depth + 1); return; }
    const object = value as Record<string, unknown>;
    const extra = object.extra as Record<string, unknown> | undefined;
    const receipt = extra?.[REQUEST_KEY] as {id?:unknown;hash?:unknown} | undefined;
    if (object.is_user === false && receipt?.id === id) {
      if (receipt.hash !== fingerprint) throw new Error("请求 ID 已用于其他内容");
      found = true;
    }
    for (const [key, child] of Object.entries(object)) {
      if (key === "continuation" && Array.isArray(child)) for (const raw of child) {
        if (typeof raw === "string") { try { walk(JSON.parse(raw), depth + 1); } catch (error) { if (error instanceof SyntaxError) continue; throw error; } }
      }
      else if (key !== "extra" || object.is_user === true) walk(child, depth + 1);
      // Assistant extras contain no candidate trees; walking them could mistake
      // arbitrary authored data for a committed reply receipt.
    }
  };
  for (const line of source.split("\n")) if (line.trim()) walk(JSON.parse(line));
  return found;
}
