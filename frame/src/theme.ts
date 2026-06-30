/**
 * Day/night theming.
 *
 * Light is the default (to match the white bezel); a dark "night" theme kicks
 * in during the configured night hours. Driven by local time for now via a
 * minute-tick; the seam is intentionally narrow so it can later be swapped for
 * Home Assistant's `sun.sun`. On each day<->night transition we also push the
 * matching Fully Kiosk brightness.
 */

import { SCHEDULE } from "./config";
import { setBrightness } from "./brightness";

export type Theme = "light" | "dark";

let currentTheme: Theme | null = null;
let ticker = 0;

function isNight(d: Date): boolean {
  const h = d.getHours();
  const start = SCHEDULE.NIGHT_START_HOUR;
  const end = SCHEDULE.NIGHT_END_HOUR;
  // Night window wraps past midnight (e.g. 20:00 -> 06:00).
  if (start <= end) return h >= start && h < end;
  return h >= start || h < end;
}

function apply(theme: Theme): void {
  if (theme === currentTheme) return;
  const first = currentTheme === null;
  currentTheme = theme;
  document.documentElement.setAttribute("data-theme", theme);

  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", theme === "dark" ? "#0f1115" : "#f4f5f7");

  // Push brightness on transitions (and once on first apply).
  const level = theme === "dark" ? SCHEDULE.NIGHT_BRIGHTNESS : SCHEDULE.DAY_BRIGHTNESS;
  void setBrightness(level);

  if (!first) console.info(`[theme] -> ${theme}`);
}

function evaluate(): void {
  apply(isNight(new Date()) ? "dark" : "light");
}

/** Start the theme scheduler. Evaluates now, then every minute. */
export function scheduleTheme(): void {
  evaluate();
  if (ticker) window.clearInterval(ticker);
  ticker = window.setInterval(evaluate, 60_000);
}

export function getTheme(): Theme {
  return currentTheme || "light";
}
