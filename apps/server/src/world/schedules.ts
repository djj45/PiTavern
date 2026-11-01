import {WORLD_MAX_CLOCK_MINUTES,WORLD_MAX_SCHEDULE_TRIGGERS,type WorldEvent,type WorldSnapshot,type WorldTemplate} from "@pitavern/shared/world";
import {parseWorldSnapshot,parseWorldTemplate,presentActorIds,validateWorldReferences} from "./schema.ts";
import {lastScheduleOccurrence} from "./schedule-time.ts";
import {visibleQuests} from "./quest-view.ts";
import {worldContentHash} from "./hash.ts";

export class ScheduleAdvanceError extends Error {
  constructor(readonly code: "TIME_LIMIT" | "SCHEDULE_LIMIT" | "INVALID_COMMAND", message: string) {super(message);}
}
export type ScheduleEvent = Omit<WorldEvent,"id"|"commandId"|"turn">;
export interface ScheduleAdvanceResult {
  snapshot: WorldSnapshot;
  events: ScheduleEvent[];
  /** Sticky proof covering every intermediate move, even when the final view matches. */
  questViewsChanged: boolean;
}

/** Pure, bounded advance. No I/O, wall clock, random IDs, tools, or mutation of caller data. */
export function advanceSchedules(input: WorldSnapshot, definition: WorldTemplate, targetMinute: number): ScheduleAdvanceResult {
  const template = parseWorldTemplate(definition);
  const snapshot = parseWorldSnapshot(input);
  validateWorldReferences(snapshot,template);
  if (snapshot.schemaVersion !== 4 || template.schemaVersion !== 4 || snapshot.templateHash !== worldContentHash(template) ||
      snapshot.templateVersion !== template.templateVersion || snapshot.rulesVersion !== template.rulesVersion) {
    throw new ScheduleAdvanceError("INVALID_COMMAND","日程来源与当前世界不一致");
  }
  if (!Number.isSafeInteger(targetMinute) || targetMinute <= snapshot.clockMinutes || targetMinute > WORLD_MAX_CLOCK_MINUTES) {
    throw new ScheduleAdvanceError("TIME_LIMIT","时间推进必须是上限内的正整数分钟");
  }
  const oldMinute = snapshot.clockMinutes;
  // Count arithmetically before enumerating or modifying anything, even for skipped NPCs.
  let count = 0;
  for (const schedule of template.schedules!) for (const point of schedule.points) {
    count += Math.floor((targetMinute-point.minuteOfDay)/1440)-Math.floor((oldMinute-point.minuteOfDay)/1440);
    if (count > WORLD_MAX_SCHEDULE_TRIGGERS) throw new ScheduleAdvanceError("SCHEDULE_LIMIT","本次时间推进超过日程处理上限，请缩短等待时间");
  }
  const occurrences: Array<{at:number;scheduleId:string;actorId:string;locationId:string}> = [];
  for (const schedule of template.schedules!) for (const point of schedule.points) {
    const firstDay = Math.floor((oldMinute-point.minuteOfDay)/1440)+1;
    for (let at=firstDay*1440+point.minuteOfDay;at<=targetMinute;at+=1440) {
      occurrences.push({at,scheduleId:schedule.id,actorId:schedule.actorId,locationId:point.locationId});
    }
  }
  occurrences.sort((a,b)=>a.at-b.at || (a.scheduleId<b.scheduleId?-1:a.scheduleId>b.scheduleId?1:0));
  const initialView = JSON.stringify(visibleQuests(snapshot,template,template.initial.actorId));
  let questViewsChanged = false;
  const events: ScheduleEvent[] = [];
  for (const occurrence of occurrences) {
    const actor = snapshot.actors[occurrence.actorId];
    const fromLocationId = actor.locationId;
    const skipReason = actor.status !== "alive" ? actor.status : fromLocationId === occurrence.locationId ? "already_there" : undefined;
    if (!skipReason) actor.locationId = occurrence.locationId;
    snapshot.clockMinutes = occurrence.at;
    snapshot.scene.presentActorIds = presentActorIds(snapshot.actors,snapshot.scene.locationId);
    if (!questViewsChanged) questViewsChanged = JSON.stringify(visibleQuests(snapshot,template,template.initial.actorId)) !== initialView;
    events.push({type:skipReason?"schedule_skip":"schedule_move",scheduleId:occurrence.scheduleId,actorId:actor.id,
      fromLocationId,locationId:occurrence.locationId,worldTimeMinutes:occurrence.at,
      ...(skipReason?{skipReason}:{}),summary:skipReason?"日程触发已跳过":"日程移动已执行"});
  }
  snapshot.clockMinutes = targetMinute;
  snapshot.scheduleStates = snapshot.scheduleStates!.map(progress=>{
    const schedule = template.schedules!.find(s=>s.id===progress.scheduleId)!;
    const lastOccurrenceAt = lastScheduleOccurrence(schedule,progress.activatedAt,targetMinute);
    return {scheduleId:progress.scheduleId,activatedAt:progress.activatedAt,processedThrough:targetMinute,
      ...(lastOccurrenceAt===undefined?{}:{lastOccurrenceAt})};
  });
  validateWorldReferences(snapshot,template);
  return {snapshot,events,questViewsChanged};
}
