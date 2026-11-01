import type { WorldKnownFact, WorldModelSnapshot, WorldSnapshot, WorldTemplate } from "@pitavern/shared/world";
import { worldContentHash } from "./hash.ts";
import { validateWorldReferences } from "./schema.ts";

export function actorKnows(snapshot: WorldSnapshot, template: WorldTemplate, actorId: string, factId: string): boolean {
  return !!snapshot.actors[actorId] && (template.facts?.some(f=>f.id===factId && f.visibility==="public") === true
    || snapshot.publishedFactIds?.includes(factId) === true || snapshot.knowledge?.some(k=>k.actorId===actorId && k.factId===factId) === true);
}

/** Exact allowlist: no complete knowledge table, private notes, or interaction rules cross this boundary. */
export function buildRoleWorldView(snapshot: WorldSnapshot, template: WorldTemplate | undefined, actorId: string): WorldModelSnapshot {
  let usable = template;
  try { if (usable) validateWorldReferences(snapshot,usable); } catch { usable = undefined; }
  const knownFacts: WorldKnownFact[] = usable && snapshot.actors[actorId] ? (usable.facts ?? []).flatMap(f=>{
    if (!actorKnows(snapshot,usable!,actorId,f.id)) return [];
    const entry = snapshot.knowledge?.find(k=>k.actorId===actorId && k.factId===f.id);
    const source = f.visibility === "public" || snapshot.publishedFactIds?.includes(f.id)
      ? {type:"public" as const,turn:snapshot.recentEvents.find(e=>e.type==="knowledge_publish" && e.factId===f.id)?.turn ?? 0}
      : entry!.source;
    return [{id:f.id,text:f.text,source:structuredClone(source)}];
  }) : [];
  const visible = new Set(knownFacts.map(f=>f.id));
  const recentEvents = snapshot.recentEvents.flatMap(e=>{
    if (!e.type.startsWith("knowledge_")) return [structuredClone(e)];
    if (!usable || !e.factId || !visible.has(e.factId) || (e.type === "knowledge_learn" && e.actorId !== actorId)) return [];
    const fact = knownFacts.find(f=>f.id===e.factId)!;
    return [{id:e.id,commandId:e.commandId,turn:e.turn,type:e.type,actorId:e.actorId,factId:fact.id,interactionId:e.interactionId,worldTimeMinutes:e.worldTimeMinutes,summary:fact.text}];
  });
  const publicInteractions = usable?.interactions?.map(i=>({id:i.id,name:i.name})) ?? [];
  const view: WorldModelSnapshot = {
    schemaVersion:snapshot.schemaVersion,revision:snapshot.revision,templateHash:snapshot.templateHash,
    templateVersion:snapshot.templateVersion,rulesVersion:snapshot.rulesVersion,clockMinutes:snapshot.clockMinutes,
    scene:structuredClone(snapshot.scene),actors:structuredClone(snapshot.actors),money:structuredClone(snapshot.money),inventory:structuredClone(snapshot.inventory),
    recentEvents,viewpointId:actorId,knownFacts,publicInteractions,
    knowledgeKey:worldContentHash({actorId,knownFacts,publicInteractions}),
  };
  return view;
}
export function buildPlayerWorldView(snapshot: WorldSnapshot, template?: WorldTemplate): WorldModelSnapshot {
  return buildRoleWorldView(snapshot,template,template?.initial.actorId ?? "");
}
/** Author-only: local management operations, never used by the model or default state API. */
export function buildAuthorWorldView(snapshot: WorldSnapshot, template?: WorldTemplate) {
  return {snapshot:structuredClone(snapshot),template:template && structuredClone(template)};
}
export function publicWorldTemplate(template?: WorldTemplate): WorldTemplate | undefined {
  if (!template) return undefined;
  return {schemaVersion:template.schemaVersion,templateId:template.templateId,templateVersion:template.templateVersion,rulesVersion:template.rulesVersion,
    locations:structuredClone(template.locations),actors:structuredClone(template.actors),items:structuredClone(template.items),
    initial:{actorId:template.initial.actorId,locationId:template.initial.locationId,money:template.initial.money,inventory:structuredClone(template.initial.inventory)}};
}
