/**
 * Control-center overlay.
 *
 * A solid semi-opaque bar (blur is progressive enhancement only, see CSS)
 * showing clock + date, battery %, live power, energy today, and AC controls.
 * The bar auto-dims during the slideshow to avoid screen retention and nudges
 * its position slightly over time; any touch wakes it to full opacity.
 */

import { OVERLAY } from "./config";
import { cycleAcMode, getState, nudgeAcTarget, onState } from "./data";
import type { FrameState } from "./data";

let dimTimer = 0;
let nudgeIdx = 0;

function el<T extends HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

// --- Clock ------------------------------------------------------------------

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function pad(n: number): string {
  return n < 10 ? "0" + n : String(n);
}

function tickClock(): void {
  const now = new Date();
  const clock = el("clock");
  const date = el("date");
  if (clock) clock.textContent = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
  if (date) {
    date.textContent =
      `${DAYS[now.getDay()]} ${now.getDate()} ${MONTHS[now.getMonth()]}`;
  }
}

// --- Stats / AC rendering ---------------------------------------------------

function fmt(n: number | null, digits = 0): string {
  if (n === null) return "--";
  return digits > 0 ? n.toFixed(digits) : String(Math.round(n));
}

function render(s: FrameState): void {
  const battery = el("battery");
  const power = el("power");
  const energy = el("energy");
  if (battery) battery.textContent = fmt(s.battery);
  if (power) power.textContent = fmt(s.power);
  if (energy) energy.textContent = fmt(s.energyToday, 1);

  const acCurrent = el("ac-current");
  const acTarget = el("ac-target");
  const acMode = el("ac-mode");
  if (s.ac) {
    if (acCurrent) acCurrent.textContent = s.ac.current === null ? "--°"
      : `${fmt(s.ac.current, 1)}°`;
    if (acTarget) acTarget.textContent = s.ac.target === null ? "--°"
      : `${fmt(s.ac.target, 1)}°`;
    if (acMode) acMode.textContent = s.ac.mode || "off";
  } else {
    if (acCurrent) acCurrent.textContent = "--°";
    if (acTarget) acTarget.textContent = "--°";
    if (acMode) acMode.textContent = "off";
  }

  // Stale dot: visible whenever we're showing last-known (disconnected/offline).
  const dot = el("stale-dot");
  if (dot) dot.classList.toggle("on", s.stale);
}

// --- Dimming + anti-retention nudge -----------------------------------------

function wake(): void {
  const overlay = el("overlay");
  if (!overlay) return;
  overlay.classList.remove("dim");
  if (dimTimer) window.clearTimeout(dimTimer);
  dimTimer = window.setTimeout(() => overlay.classList.add("dim"), OVERLAY.DIM_AFTER_MS);
}

function nudge(): void {
  const overlay = el("overlay");
  if (!overlay) return;
  // Cycle through a few small offsets so the bar never burns a fixed footprint.
  const spots = [
    { x: 0, y: 0 },
    { x: 6, y: -4 },
    { x: -6, y: 4 },
    { x: 4, y: 6 },
  ];
  nudgeIdx = (nudgeIdx + 1) % spots.length;
  const p = spots[nudgeIdx];
  overlay.style.transform = `translate(${p.x}px, ${p.y}px)`;
}

// --- Wiring -----------------------------------------------------------------

export function startOverlay(): void {
  tickClock();
  window.setInterval(tickClock, 1000);

  onState(render);

  const up = el<HTMLButtonElement>("ac-up");
  const down = el<HTMLButtonElement>("ac-down");
  const mode = el<HTMLButtonElement>("ac-mode");
  const step = (): number => {
    const ac = getState().ac;
    return ac ? ac.step : 0.5;
  };
  if (up) up.addEventListener("click", () => void nudgeAcTarget(step()));
  if (down) down.addEventListener("click", () => void nudgeAcTarget(-step()));
  if (mode) mode.addEventListener("click", () => void cycleAcMode());

  // Any touch/click/move wakes the bar.
  for (const evt of ["pointerdown", "touchstart", "mousemove", "keydown"]) {
    window.addEventListener(evt, wake, { passive: true });
  }
  wake();

  window.setInterval(nudge, OVERLAY.NUDGE_EVERY_MS);
}
