/** Shared formatting helpers used by both the clock (overlay.ts) and photo
 *  captions (photos.ts) so the two date displays stay in sync. */

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function pad(n: number): string {
  return n < 10 ? "0" + n : String(n);
}

/** "22 Jul" — day + abbreviated month, no year or weekday. */
export function formatShortDate(d: Date): string {
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

/** True when the two dates fall on the same calendar day (local time). */
function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();
}

/**
 * A short "when" label for a calendar event, relative to now:
 *   today            -> "Today 14:00"  (or "Today" if all-day)
 *   tomorrow         -> "Tomorrow 09:00"
 *   within this week -> "Tue 09:00"
 *   further out      -> "22 Jul 09:00"
 * All-day events drop the time. Uses local time throughout.
 */
export function formatEventWhen(startMs: number, allDay: boolean, now: Date = new Date()): string {
  const d = new Date(startMs);
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const weekAhead = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 7);

  let day: string;
  if (sameDay(d, now)) day = "Today";
  else if (sameDay(d, tomorrow)) day = "Tomorrow";
  else if (d < weekAhead) day = WEEKDAYS[d.getDay()];
  else day = formatShortDate(d);

  if (allDay) return day;
  return `${day} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
