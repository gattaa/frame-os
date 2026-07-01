/**
 * Control-center overlay.
 *
 * A solid semi-opaque bar (blur is progressive enhancement only, see CSS)
 * showing clock + date + weather, battery % (with a charge/discharge
 * indicator), house power draw, and AC controls. The bar auto-dims during
 * the slideshow to avoid screen retention and nudges its position slightly
 * over time; any touch wakes it to full opacity.
 */

import { OVERLAY } from "./config";
import { acCool, acHeat, acOff, onState, setAcFanMode, stepAcFan } from "./data";
import type { AcState, FrameState } from "./data";

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

// --- Weather ------------------------------------------------------------

// Built from circle/rect/line primitives (no bezier path art) so every glyph
// is guaranteed valid geometry within a 24x24 viewBox.
const CLOUD_SHAPE = `<circle cx="9" cy="10" r="3.2"/><circle cx="13" cy="8.5" r="4"/>` +
  `<circle cx="17" cy="10.5" r="2.6"/><rect x="7" y="10" width="12" height="5" rx="2.5"/>`;

function svg(body: string): string {
  return `<svg viewBox="0 0 24 24">${body}</svg>`;
}

const WEATHER_ICONS: Record<string, string> = {
  sun: svg(`<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
    <circle cx="12" cy="12" r="4" fill="currentColor" stroke="none"/>
    <line x1="12" y1="1" x2="12" y2="4"/><line x1="12" y1="20" x2="12" y2="23"/>
    <line x1="1" y1="12" x2="4" y2="12"/><line x1="20" y1="12" x2="23" y2="12"/>
    <line x1="4.2" y1="4.2" x2="6.3" y2="6.3"/><line x1="17.7" y1="17.7" x2="19.8" y2="19.8"/>
    <line x1="4.2" y1="19.8" x2="6.3" y2="17.7"/><line x1="17.7" y1="6.3" x2="19.8" y2="4.2"/>
  </g>`),
  moon: svg(`<path fill="currentColor" d="M20 14.5A8.5 8.5 0 1 1 9.5 4a7 7 0 1 0 10.5 10.5z"/>`),
  cloud: svg(`<g fill="currentColor">${CLOUD_SHAPE}</g>`),
  "cloud-sun": svg(`<g fill="currentColor"><circle cx="17" cy="6" r="2.6"/></g>
    <g fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round">
      <line x1="17" y1="1" x2="17" y2="2.4"/><line x1="21.6" y1="6" x2="20.2" y2="6"/>
      <line x1="20.3" y1="2.7" x2="19.3" y2="3.7"/>
    </g>
    <g fill="currentColor">${CLOUD_SHAPE}</g>`),
  fog: svg(`<g stroke="currentColor" stroke-width="2" stroke-linecap="round">
    <line x1="3" y1="8" x2="21" y2="8"/><line x1="3" y1="13" x2="21" y2="13"/>
    <line x1="3" y1="18" x2="17" y2="18"/>
  </g>`),
  rain: svg(`<g fill="currentColor">${CLOUD_SHAPE}</g>
    <g stroke="currentColor" stroke-width="2" stroke-linecap="round">
      <line x1="8" y1="18" x2="7" y2="22"/><line x1="12" y1="18" x2="11" y2="22"/>
      <line x1="16" y1="18" x2="15" y2="22"/>
    </g>`),
  pouring: svg(`<g fill="currentColor">${CLOUD_SHAPE}</g>
    <g stroke="currentColor" stroke-width="2" stroke-linecap="round">
      <line x1="7" y1="17" x2="5.5" y2="23"/><line x1="10.5" y1="17" x2="9" y2="23"/>
      <line x1="14" y1="17" x2="12.5" y2="23"/><line x1="17.5" y1="17" x2="16" y2="23"/>
    </g>`),
  storm: svg(`<g fill="currentColor">${CLOUD_SHAPE}</g>
    <path fill="currentColor" d="M14 15l-4 5h3l-2 5 5-6h-3l1-4z"/>`),
  snow: svg(`<g fill="currentColor">${CLOUD_SHAPE}</g>
    <g fill="currentColor">
      <circle cx="8" cy="19" r="1.1"/><circle cx="12" cy="21.5" r="1.1"/><circle cx="16" cy="19" r="1.1"/>
    </g>`),
  sleet: svg(`<g fill="currentColor">${CLOUD_SHAPE}</g>
    <g stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="8" y1="18" x2="7" y2="22"/></g>
    <g fill="currentColor"><circle cx="12" cy="21" r="1.1"/><circle cx="16" cy="19" r="1.1"/></g>`),
  wind: svg(`<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
    <path d="M3 8h11a3 3 0 1 0-3-3"/><path d="M3 13h15a3 3 0 1 1-3 3"/><path d="M3 18h8"/>
  </g>`),
  unknown: svg(`<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/>
    <text x="12" y="16" font-size="11" text-anchor="middle" fill="currentColor" font-family="sans-serif">?</text>`),
};

// met.no's typical `weather.*` condition strings (also the general HA
// weather-entity vocabulary), mapped to an icon key + short recap word.
const CONDITION_MAP: Record<string, { icon: string; label: string }> = {
  "sunny": { icon: "sun", label: "Sunny" },
  "clear-night": { icon: "moon", label: "Clear" },
  "partlycloudy": { icon: "cloud-sun", label: "Partly Cloudy" },
  "cloudy": { icon: "cloud", label: "Cloudy" },
  "fog": { icon: "fog", label: "Foggy" },
  "rainy": { icon: "rain", label: "Rainy" },
  "pouring": { icon: "pouring", label: "Pouring" },
  "lightning": { icon: "storm", label: "Stormy" },
  "lightning-rainy": { icon: "storm", label: "Stormy" },
  "snowy": { icon: "snow", label: "Snowy" },
  "snowy-rainy": { icon: "sleet", label: "Sleet" },
  "hail": { icon: "sleet", label: "Hail" },
  "windy": { icon: "wind", label: "Windy" },
  "windy-variant": { icon: "wind", label: "Windy" },
  "exceptional": { icon: "unknown", label: "Unknown" },
};

/** "clear-night" -> "Clear Night" — best-effort label for an unmapped state. */
function titleCase(s: string): string {
  return s.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function renderWeather(state: string | null): void {
  const wrap = el("ov-weather");
  const icon = el("weather-icon");
  const label = el("weather-label");
  if (!wrap || !icon || !label) return;

  if (state === null) {
    wrap.classList.add("hidden");
    return;
  }
  wrap.classList.remove("hidden");
  const entry = CONDITION_MAP[state];
  icon.innerHTML = WEATHER_ICONS[entry ? entry.icon : "unknown"];
  label.textContent = entry ? entry.label : titleCase(state);
}

// --- Stats / AC rendering ---------------------------------------------------

function fmt(n: number | null, digits = 0): string {
  if (n === null) return "--";
  return digits > 0 ? n.toFixed(digits) : String(Math.round(n));
}

/** Small glyph next to the battery %, showing charge direction at a glance. */
function batteryIcon(status: string | null): string {
  if (status === "Charging") return "⚡"; // lightning bolt
  if (status === "Discharging") return "↓"; // down arrow
  return ""; // Idle / unknown: no icon
}

/** "1.4kW" above 1000W, "850W" below — always includes its own unit. */
function fmtPower(n: number | null): string {
  if (n === null) return "--";
  const abs = Math.abs(n);
  if (abs >= 1000) return `${(n / 1000).toFixed(1)}kW`;
  return `${Math.round(n)}W`;
}

// Rebuilt whenever the entity's fan_modes list changes shape (rare); a plain
// string join is enough to detect that without deep-equal machinery.
let lastFanModesKey = "";

/** Fan scale ticks: one per fan_mode, tallest = last entry (highest speed). */
function renderFanScale(ac: AcState | null): void {
  const scale = el("fan-scale");
  if (!scale) return;
  // Guard against a stale IndexedDB cache from before fanModes existed on AcState.
  const modes = ac && Array.isArray(ac.fanModes) ? ac.fanModes : [];
  const key = modes.join("|");
  if (key !== lastFanModesKey) {
    lastFanModesKey = key;
    scale.innerHTML = "";
    modes.forEach((mode, i) => {
      const tick = document.createElement("button");
      tick.className = "fan-tick";
      tick.dataset.mode = mode;
      tick.setAttribute("aria-label", `Fan speed: ${mode}`);
      // Ramp tick height with position so the scale reads left-to-right as low-to-high.
      const pct = modes.length > 1 ? i / (modes.length - 1) : 1;
      tick.style.setProperty("--tick-h", `${30 + pct * 70}%`);
      tick.addEventListener("click", () => void setAcFanMode(mode));
      scale.appendChild(tick);
    });
  }
  const active = ac ? ac.fanMode : null;
  for (const child of Array.from(scale.children)) {
    (child as HTMLElement).classList.toggle("active", (child as HTMLElement).dataset.mode === active);
  }
}

function renderAc(ac: AcState | null): void {
  const name = el("ac-name");
  const acCurrent = el("ac-current");
  const heatBtn = el<HTMLButtonElement>("ac-heat");
  const coolBtn = el<HTMLButtonElement>("ac-cool");

  if (name) name.textContent = (ac && ac.name) || "AC";
  if (acCurrent) acCurrent.textContent = ac && ac.current !== null ? `${fmt(ac.current, 1)}°` : "--°";

  // Flame/ice need current_temperature for the +3/-3 math; disable without it.
  // Off and the fan controls stay active regardless — they don't depend on it.
  const canAdjust = !!ac && ac.current !== null;
  if (heatBtn) heatBtn.disabled = !canAdjust;
  if (coolBtn) coolBtn.disabled = !canAdjust;

  renderFanScale(ac);
}

function render(s: FrameState): void {
  const battery = el("battery");
  const battIcon = el("battery-icon");
  const housePower = el("house-power");
  if (battery) battery.textContent = fmt(s.battery);
  if (battIcon) battIcon.textContent = batteryIcon(s.batteryStatus);
  if (housePower) housePower.textContent = fmtPower(s.housePower);

  renderWeather(s.weather);
  renderAc(s.ac);

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

  const heat = el<HTMLButtonElement>("ac-heat");
  const cool = el<HTMLButtonElement>("ac-cool");
  const off = el<HTMLButtonElement>("ac-off");
  const fanDown = el<HTMLButtonElement>("fan-down");
  const fanUp = el<HTMLButtonElement>("fan-up");
  if (heat) heat.addEventListener("click", () => void acHeat());
  if (cool) cool.addEventListener("click", () => void acCool());
  if (off) off.addEventListener("click", () => void acOff());
  if (fanDown) fanDown.addEventListener("click", () => void stepAcFan(-1));
  if (fanUp) fanUp.addEventListener("click", () => void stepAcFan(1));

  // Any touch/click/move wakes the bar.
  for (const evt of ["pointerdown", "touchstart", "mousemove", "keydown"]) {
    window.addEventListener(evt, wake, { passive: true });
  }
  wake();

  window.setInterval(nudge, OVERLAY.NUDGE_EVERY_MS);
}
