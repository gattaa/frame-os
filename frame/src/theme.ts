/**
 * Day/night theming — driven by Home Assistant.
 *
 * The theme follows `input_boolean.frame_night_mode` (exposed via the data
 * layer as `state.nightMode`), which the ha/ package drives from sun elevation
 * plus Mum's override. HA also drives the screen brightness off the same
 * boolean, so theme and brightness stay in lockstep. (The old local-clock
 * stub is gone.)
 *
 * Light is the default — including when `nightMode` is unknown (no HA yet, or
 * the boolean missing) — to match the white bezel.
 *
 * `brightness.ts` is still called on transitions, but it no-ops unless the
 * PWA's optional Fully Kiosk path is enabled; by default HA owns brightness.
 */

import { SCHEDULE } from "./config";
import { setBrightness } from "./brightness";
import { onState } from "./data";

export type Theme = "light" | "dark";

let currentTheme: Theme | null = null;

function apply(theme: Theme): void {
  if (theme === currentTheme) return;
  const first = currentTheme === null;
  currentTheme = theme;
  document.documentElement.setAttribute("data-theme", theme);

  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", theme === "dark" ? "#0f1115" : "#f4f5f7");

  // Optional PWA-driven brightness (no-ops unless Fully Kiosk is enabled).
  const level = theme === "dark" ? SCHEDULE.NIGHT_BRIGHTNESS : SCHEDULE.DAY_BRIGHTNESS;
  void setBrightness(level);

  if (!first) console.info(`[theme] -> ${theme} (from HA night mode)`);
}

/** Start theming: follow HA's night-mode boolean via the data layer. */
export function startTheme(): void {
  onState((s) => apply(s.nightMode === true ? "dark" : "light"));
}

export function getTheme(): Theme {
  return currentTheme || "light";
}
