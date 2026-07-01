/** Shared formatting helpers used by both the clock (overlay.ts) and photo
 *  captions (photos.ts) so the two date displays stay in sync. */

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function pad(n: number): string {
  return n < 10 ? "0" + n : String(n);
}

/** "22 Jul" — day + abbreviated month, no year or weekday. */
export function formatShortDate(d: Date): string {
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
}
