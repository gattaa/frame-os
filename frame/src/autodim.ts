/**
 * Auto-dim: an opt-in, persisted setting (toggle lives in the settings panel)
 * that drops the physical screen brightness to AUTO_DIM.BRIGHTNESS after
 * AUTO_DIM.AFTER_MS of no touch, and restores the day/night SCHEDULE level on
 * the next touch. Off by default — most kiosk placements want the display
 * legible at a glance from across the room at all times.
 */

import { AUTO_DIM, SCHEDULE } from "./config";
import { setBrightness } from "./brightness";
import { getTheme } from "./theme";

const STORAGE_KEY = "frame:autodim";

let enabled = localStorage.getItem(STORAGE_KEY) === "1";
let dimmed = false;
let timer = 0;

function scheduledBrightness(): number {
  return getTheme() === "dark" ? SCHEDULE.NIGHT_BRIGHTNESS : SCHEDULE.DAY_BRIGHTNESS;
}

function dim(): void {
  if (!enabled || dimmed) return;
  dimmed = true;
  void setBrightness(AUTO_DIM.BRIGHTNESS);
}

function scheduleDim(): void {
  window.clearTimeout(timer);
  if (enabled) timer = window.setTimeout(dim, AUTO_DIM.AFTER_MS);
}

function wake(): void {
  if (dimmed) {
    dimmed = false;
    void setBrightness(scheduledBrightness());
  }
  scheduleDim();
}

export function isAutoDimEnabled(): boolean {
  return enabled;
}

export function setAutoDimEnabled(on: boolean): void {
  enabled = on;
  localStorage.setItem(STORAGE_KEY, on ? "1" : "0");
  if (!on && dimmed) {
    dimmed = false;
    void setBrightness(scheduledBrightness());
  }
  scheduleDim();
}

export function startAutoDim(): void {
  for (const evt of ["pointerdown", "touchstart", "mousemove", "keydown"]) {
    window.addEventListener(evt, wake, { passive: true });
  }
  scheduleDim();
}
