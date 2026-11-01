import type {WorldInteractionCondition, WorldSnapshot, WorldTemplate} from "@pitavern/shared/world";

export function actorKnows(snapshot: WorldSnapshot, template: WorldTemplate, actorId: string, factId: string): boolean {
  return !!snapshot.actors[actorId] && (template.facts?.some(f => f.id === factId && f.visibility === "public") === true
    || snapshot.publishedFactIds?.includes(factId) === true || snapshot.knowledge?.some(k => k.actorId === actorId && k.factId === factId) === true);
}

export function actorPresent(snapshot: WorldSnapshot, player: string, actor: string): boolean {
  return snapshot.actors[player]?.status === "alive" && snapshot.actors[actor]?.status === "alive"
    && snapshot.actors[actor].locationId === snapshot.actors[player].locationId;
}

/** Read-only; never grants knowledge, accepts tasks or advances progress. */
export function worldConditionsMet(snapshot: WorldSnapshot, template: WorldTemplate, conditions: WorldInteractionCondition[]): boolean {
  const player = template.initial.actorId;
  return actorPresent(snapshot, player, player) && conditions.every(c => {
    switch (c.type) {
      case "at_location": return snapshot.actors[player].locationId === c.locationId;
      case "npc_present": return c.actorId !== player && actorPresent(snapshot, player, c.actorId);
      case "has_item": return snapshot.inventory.some(i => i.ownerId === player && i.itemId === c.itemId && i.quantity >= c.quantity);
      case "knows_fact": return actorKnows(snapshot, template, c.actorId, c.factId);
    }
  });
}
