import type {WorldScheduleDefinition} from "@pitavern/shared/world";

/** Last point in (after, through], without scanning days or consulting audit events. */
export function lastScheduleOccurrence(schedule: WorldScheduleDefinition, after: number, through: number): number | undefined {
  let last: number | undefined;
  for (const point of schedule.points) {
    const day = Math.floor((through - point.minuteOfDay) / 1440);
    const at = day * 1440 + point.minuteOfDay;
    if (day >= 0 && at > after && (last === undefined || at > last)) last = at;
  }
  return last;
}
