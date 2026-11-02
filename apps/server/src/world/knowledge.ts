import type { WorldKnownFact, WorldModelSnapshot, WorldSnapshot, WorldTemplate } from "@pitavern/shared/world";
import { worldContentHash } from "./hash.ts";
import { validateWorldReferences } from "./schema.ts";

import {actorKnows} from "./conditions.ts";
export {actorKnows} from "./conditions.ts";
import {visibleQuests} from "./quest-view.ts";
import {interactionAvailability} from "./action-view.ts";

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
  const quests = visibleQuests(snapshot, usable, actorId);
  const questIds = new Set(quests.map(q=>q.id));
  const recentEvents = snapshot.recentEvents.flatMap(e=>{
    if (e.type === "schedule_skip") return [];
    if (e.type === "schedule_move") {
      if (!usable || usable.schemaVersion !== 4) return [];
      const actor = usable.actors.find(a=>a.id===e.actorId);
      const from = usable.locations.find(l=>l.id===e.fromLocationId);
      const to = usable.locations.find(l=>l.id===e.locationId);
      if (!actor || !from || !to) return [];
      return [{id:e.id,commandId:e.commandId,turn:e.turn,type:e.type,actorId:actor.id,
        fromLocationId:from.id,locationId:to.id,worldTimeMinutes:e.worldTimeMinutes,
        summary:`${actor.name}从${from.name}前往${to.name}`}];
    }
    if (e.scheduleId !== undefined || e.skipReason !== undefined || e.fromLocationId !== undefined || e.locationId !== undefined) return [];
    if (e.type.startsWith("quest_")) {
      if(!usable || !e.questId || !questIds.has(e.questId) || e.actorId!==actorId) return [];
      const q=quests.find(q=>q.id===e.questId)!;
      return [{id:e.id,commandId:e.commandId,turn:e.turn,type:e.type,actorId,questId:q.id,...(e.stageId?{stageId:e.stageId}:{}),worldTimeMinutes:e.worldTimeMinutes,summary:`${q.name}：${e.type==="quest_accept"?"已接取":e.type==="quest_complete"?"已完成":"阶段已完成"}`}];
    }
    if(e.questId!==undefined || e.stageId!==undefined) return [];
    if (!e.type.startsWith("knowledge_")) {
      // Malformed/imported audit records must not smuggle structured knowledge
      // through a hard-state event, even when the world is read-only.
      if (snapshot.schemaVersion >= 2 && (e.factId !== undefined || e.interactionId !== undefined)) return [];
      return [structuredClone(e)];
    }
    if (!usable || !e.factId || !visible.has(e.factId) || (e.type === "knowledge_learn" && e.actorId !== actorId)) return [];
    const fact = knownFacts.find(f=>f.id===e.factId)!;
    return [{id:e.id,commandId:e.commandId,turn:e.turn,type:e.type,actorId:e.actorId,factId:fact.id,interactionId:e.interactionId,worldTimeMinutes:e.worldTimeMinutes,summary:fact.text}];
  });
  const publicInteractions = usable?.interactions?.map(i=>({id:i.id,name:i.name,
    ...(actorId === usable!.initial.actorId ? {availability:interactionAvailability(snapshot,usable!,i)} : {})})) ?? [];
  const view: WorldModelSnapshot = {
    schemaVersion:snapshot.schemaVersion,revision:snapshot.revision,templateHash:snapshot.templateHash,
    templateVersion:snapshot.templateVersion,rulesVersion:snapshot.rulesVersion,clockMinutes:snapshot.clockMinutes,
    scene:structuredClone(snapshot.scene),actors:structuredClone(snapshot.actors),money:structuredClone(snapshot.money),inventory:structuredClone(snapshot.inventory),
    ...(usable?.actionTime?{actionTime:structuredClone(usable.actionTime)}:{}),
    ...(snapshot.schemaVersion>=3?{quests,questKey:worldContentHash({actorId,quests})}:{}),
    recentEvents,viewpointId:actorId,knownFacts,publicInteractions,
    // Readiness changes with hard state, not knowledge authorization. Keep the
    // authorization fingerprint stable across movements and inventory changes.
    knowledgeKey:worldContentHash({actorId,knownFacts,publicInteractions:publicInteractions.map(({id,name})=>({id,name}))}),
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
    ...(template.actionTime?{actionTime:structuredClone(template.actionTime)}:{}),
    locations:structuredClone(template.locations),actors:structuredClone(template.actors),items:structuredClone(template.items),
    initial:{actorId:template.initial.actorId,locationId:template.initial.locationId,money:template.initial.money,inventory:structuredClone(template.initial.inventory)}};
}
