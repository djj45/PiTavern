import type {WorldQuestView, WorldSnapshot, WorldTemplate} from "@pitavern/shared/world";
import {worldConditionsMet} from "./conditions.ts";

/** Only the bound player owns quests. Future objectives and rule internals never cross this DTO. */
export function visibleQuests(snapshot: WorldSnapshot, template: WorldTemplate | undefined, actorId: string): WorldQuestView[] {
  if (snapshot.schemaVersion < 3 || !template || template.schemaVersion < 3 || actorId !== template.initial.actorId) return [];
  return template.quests!.flatMap(quest => {
    const state = snapshot.questStates!.find(s => s.questId === quest.id);
    if (!state && !worldConditionsMet(snapshot, template, quest.openConditions)) return [];
    const current = quest.stages[state?.completedStages.length ?? 0];
    return [{id: quest.id, name: quest.name, status: state?.status ?? "available",
      ...(current ? {currentStage: {id: current.id, objective: current.objective}} : {}),
      completedStages: (state?.completedStages ?? []).map((s, i) => ({id: s.stageId, objective: quest.stages[i].objective, turn: s.turn}))}];
  });
}
