import type { WorldActionAvailability, WorldInteractionCondition, WorldInteractionDefinition, WorldSnapshot, WorldTemplate } from "@pitavern/shared/world";
import { actorKnows, actorPresent, worldConditionsMet } from "./conditions.ts";

/** A projection only. Never executes a rule, reveals an effect, or grants knowledge. */
export function conditionAvailability(snapshot: WorldSnapshot, template: WorldTemplate, conditions: WorldInteractionCondition[], publicIndexes: number[] = []): WorldActionAvailability {
  const player = template.initial.actorId;
  const reasons: string[] = [];
  if (!actorPresent(snapshot, player, player)) reasons.push("玩家当前无法行动");
  for (const [index, condition] of conditions.entries()) {
    if (worldConditionsMet(snapshot, template, [condition])) continue;
    if (!publicIndexes.includes(index)) {
      reasons.push("仍有未满足的调查或任务条件，请先推进已公开的目标");
      continue;
    }
    switch (condition.type) {
      case "at_location": reasons.push(`需前往${template.locations.find(l => l.id === condition.locationId)!.name}`); break;
      case "npc_present": reasons.push(`需${template.actors.find(a => a.id === condition.actorId)!.name}在场且可交互`); break;
      case "has_item": reasons.push(`需持有${template.items.find(i => i.id === condition.itemId)!.name}×${condition.quantity}`); break;
      // Never disclose unknown fact IDs/text, or an NPC's private knowledge relation.
      case "knows_fact": reasons.push("仍有未满足的调查或任务条件，请先推进已公开的目标"); break;
    }
  }
  return { status: reasons.length ? "later" : "ready", reasons: [...new Set(reasons)] };
}

export function interactionConditionsMet(snapshot: WorldSnapshot, template: WorldTemplate, interaction: WorldInteractionDefinition): boolean {
  return worldConditionsMet(snapshot, template, interaction.conditions)
    && interaction.effects.every(e => e.type !== "learn" || !e.fromActorId
      || (actorPresent(snapshot, template.initial.actorId, e.fromActorId) && actorKnows(snapshot, template, e.fromActorId, e.factId)));
}

export function interactionAvailability(snapshot: WorldSnapshot, template: WorldTemplate, interaction: WorldInteractionDefinition): WorldActionAvailability {
  const availability = conditionAvailability(snapshot, template, interaction.conditions, interaction.publicConditionIndexes);
  if (!interactionConditionsMet(snapshot, template, interaction) && availability.status === "ready") {
    return { status: "later", reasons: ["当前交互条件尚未满足，请先推进已公开的目标"] };
  }
  return availability;
}
