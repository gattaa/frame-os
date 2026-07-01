/**
 * Control-center overlay.
 *
 * Transparent over the photo — clock/date/weather/battery/power sit top-right,
 * one tappable badge per AC room sits top-left. It wakes to full opacity on
 * any touch, then fades back to a dim (but still visible/legible) resting
 * state after a period of inactivity — dim rather than gone, so there's
 * always a glanceable clock even mid-slideshow. Tapping a room badge expands
 * a small control panel (setpoint, mode, fan) for that room; only one room
 * panel is open at a time.
 */

import { OVERLAY } from "./config";
import {
  acCool, acHeat, acOff, getState, onState, setAcFanMode, stepAcTarget,
} from "./data";
import type { AcState, FrameState } from "./data";
import { formatShortDate, pad } from "./format";
import { restartApp, setBrightness, setScreenOn } from "./brightness";
import { isPaused, stepPhoto, togglePause } from "./photos";

let dimTimer = 0;

function el<T extends HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

// --- Clock / date -------------------------------------------------------

function tickClock(): void {
  const now = new Date();
  const clock = el("clock");
  const date = el("date");
  if (clock) clock.textContent = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
  if (date) date.textContent = formatShortDate(now);
}

// --- Weather --------------------------------------------------------------

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

function renderWeather(state: string | null, temp: number | null): void {
  const wrap = el("ov-weather");
  const icon = el("weather-icon");
  const tempEl = el("weather-temp");
  if (!wrap || !icon || !tempEl) return;

  if (state === null) {
    wrap.classList.add("hidden");
    return;
  }
  wrap.classList.remove("hidden");
  const entry = CONDITION_MAP[state];
  icon.innerHTML = WEATHER_ICONS[entry ? entry.icon : "unknown"];
  wrap.setAttribute("aria-label", entry ? entry.label : titleCase(state));
  tempEl.textContent = temp !== null ? `${Math.round(temp)}°` : "";
}

// --- Battery / power stats --------------------------------------------------

function fmt(n: number | null, digits = 0): string {
  if (n === null) return "--";
  return digits > 0 ? n.toFixed(digits) : String(Math.round(n));
}

/** Small glyph next to the battery %, showing charge direction at a glance. */
function batteryStatusGlyph(status: string | null): string {
  if (status === "Charging") return "⚡";
  if (status === "Discharging") return "↓";
  return "";
}

/** "1.4kW" above 1000W, "850W" below — always includes its own unit. */
function fmtPower(n: number | null): string {
  if (n === null) return "--";
  const abs = Math.abs(n);
  if (abs >= 1000) return `${(n / 1000).toFixed(1)}kW`;
  return `${Math.round(n)}W`;
}

// --- AC badges + expand panel ------------------------------------------------

const ICON_POWER = `<svg viewBox="0 0 24 24"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M12 2v8"/><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M6.3 6.3a9 9 0 1 0 11.4 0"/></svg>`;
const ICON_FLAME = `<svg viewBox="0 0 24 24"><path fill="currentColor" d="M12 2c-.6 3-3 4.7-3 8a3 3 0 0 0 6 0c0-1-.4-1.8-1-2.5.1 1-.2 1.8-.9 2.3-.8.6-1.9.3-2.1-.7-.3-1.4.6-2.5 1.3-3.6.7-1.1 1.1-2.1.7-3.5zM12 15a5 5 0 0 0 5-5c0-.7-.1-1.3-.3-1.9C18.6 9.3 20 11.6 20 14a8 8 0 1 1-16 0c0-3.4 2.2-6.2 4.3-8.4C7.4 7.1 7 8.5 7 10a5 5 0 0 0 5 5z"/></svg>`;
const ICON_SNOWFLAKE = `<svg viewBox="0 0 24 24"><g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
  <path d="M12 2v20M4.5 6.5l15 11M19.5 6.5l-15 11"/>
  <path d="M12 2l-2 2M12 2l2 2M12 22l-2-2M12 22l2-2"/>
  <path d="M4.5 6.5l.5 2.7M4.5 6.5l2.7-.5M19.5 17.5l-.5-2.7M19.5 17.5l-2.7.5"/>
  <path d="M19.5 6.5l-.5 2.7M19.5 6.5l-2.7-.5M4.5 17.5l.5-2.7M4.5 17.5l2.7.5"/>
</g></svg>`;
const ICON_CHEVRON = `<svg viewBox="0 0 24 24"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M6 15l6-6 6 6"/></svg>`;
// Path-only (no <svg> wrapper) so they can be swapped via .innerHTML on the
// existing <svg id="nav-playpause-icon"> element in index.html.
const ICON_PAUSE_PATH = `<path fill="currentColor" d="M7 5h3v14H7zM14 5h3v14h-3z"/>`;
const ICON_PLAY_PATH = `<path fill="currentColor" d="M8 5l11 7-11 7z"/>`;

/** Which room's panel is expanded, or null when all badges are collapsed. */
let selectedAcId: string | null = null;
const badgeEls = new Map<string, HTMLElement>();
let badgeKey = "";
let panelEl: HTMLElement | null = null;
let lastPanelFanKey = "";

function acIconClass(mode: string): "heat" | "cool" | "off" {
  if (mode === "heat") return "heat";
  if (mode === "cool") return "cool";
  return "off";
}

function acIconHtml(mode: string): string {
  if (mode === "heat") return ICON_FLAME;
  if (mode === "cool") return ICON_SNOWFLAKE;
  return ICON_POWER;
}

function buildBadge(entityId: string): HTMLElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "ac-badge";
  btn.dataset.entity = entityId;

  const iconRow = document.createElement("span");
  iconRow.className = "ac-badge-iconrow";
  const icon = document.createElement("span");
  icon.className = "ac-badge-icon";
  const temp = document.createElement("span");
  temp.className = "ac-badge-temp";
  iconRow.appendChild(icon);
  iconRow.appendChild(temp);

  const name = document.createElement("span");
  name.className = "ac-badge-name";

  btn.appendChild(iconRow);
  btn.appendChild(name);
  btn.addEventListener("click", () => {
    selectedAcId = selectedAcId === entityId ? null : entityId;
    renderAcs(getState().acs);
  });
  return btn;
}

function updateBadge(btn: HTMLElement, ac: AcState, selected: boolean): void {
  btn.classList.toggle("selected", selected);
  const icon = btn.querySelector<HTMLElement>(".ac-badge-icon");
  const temp = btn.querySelector<HTMLElement>(".ac-badge-temp");
  const name = btn.querySelector<HTMLElement>(".ac-badge-name");
  if (icon) {
    icon.className = `ac-badge-icon ac-badge-icon-${acIconClass(ac.mode)}`;
    icon.innerHTML = acIconHtml(ac.mode);
  }
  if (temp) {
    const show = ac.mode !== "off" && ac.target !== null;
    temp.textContent = show ? `${fmt(ac.target)}°` : "";
  }
  if (name) name.textContent = ac.name;
}

function buildPanel(): HTMLElement {
  const panel = document.createElement("div");
  panel.className = "ac-panel";
  panel.id = "ac-panel";
  panel.innerHTML = `
    <div class="ac-panel-header">
      <span class="ac-panel-title">
        <span id="ac-panel-name"></span>
        <span class="ac-panel-ambient" id="ac-panel-ambient"></span>
      </span>
      <button type="button" class="ac-panel-collapse" id="ac-panel-collapse" aria-label="Collapse">${ICON_CHEVRON}</button>
    </div>
    <div class="ac-panel-setpoint">
      <button type="button" class="ac-panel-step" id="ac-panel-minus" aria-label="Lower target">&minus;</button>
      <span class="ac-panel-target" id="ac-panel-target">--°</span>
      <button type="button" class="ac-panel-step" id="ac-panel-plus" aria-label="Raise target">&plus;</button>
    </div>
    <div class="ac-panel-label">Modalità</div>
    <div class="ac-panel-segmented" id="ac-panel-modes">
      <button type="button" class="ac-seg-btn" data-mode="off" aria-label="Off">${ICON_POWER}</button>
      <button type="button" class="ac-seg-btn ac-seg-cool" data-mode="cool" aria-label="Raffredda">${ICON_SNOWFLAKE}</button>
      <button type="button" class="ac-seg-btn ac-seg-heat" data-mode="heat" aria-label="Riscalda">${ICON_FLAME}</button>
    </div>
    <div class="ac-panel-label">Ventola</div>
    <div class="ac-panel-fan" id="ac-panel-fan"></div>
  `;

  panel.querySelector("#ac-panel-collapse")?.addEventListener("click", () => {
    selectedAcId = null;
    renderAcs(getState().acs); // clears the badge's "selected" look too, not just the panel
  });
  panel.querySelector("#ac-panel-minus")?.addEventListener("click", () => {
    if (selectedAcId) void stepAcTarget(selectedAcId, -1);
  });
  panel.querySelector("#ac-panel-plus")?.addEventListener("click", () => {
    if (selectedAcId) void stepAcTarget(selectedAcId, 1);
  });
  panel.querySelector("#ac-panel-modes")?.addEventListener("click", (e) => {
    if (!selectedAcId) return;
    const btn = (e.target as HTMLElement).closest<HTMLElement>(".ac-seg-btn");
    const mode = btn?.dataset.mode;
    if (mode === "off") void acOff(selectedAcId);
    else if (mode === "cool") void acCool(selectedAcId);
    else if (mode === "heat") void acHeat(selectedAcId);
  });

  return panel;
}

/** Fan ticks: one per fan_mode, tallest = last entry (highest speed). */
function renderPanelFan(ac: AcState): void {
  const wrap = el("ac-panel-fan");
  if (!wrap) return;
  const key = ac.fanModes.join("|");
  if (key !== lastPanelFanKey) {
    lastPanelFanKey = key;
    wrap.innerHTML = "";
    ac.fanModes.forEach((mode, i) => {
      const tick = document.createElement("button");
      tick.type = "button";
      tick.className = "ac-fan-tick";
      tick.dataset.mode = mode;
      tick.setAttribute("aria-label", `Fan speed: ${mode}`);
      const pct = ac.fanModes.length > 1 ? i / (ac.fanModes.length - 1) : 1;
      tick.style.setProperty("--tick-h", `${30 + pct * 70}%`);
      tick.addEventListener("click", () => {
        if (selectedAcId) void setAcFanMode(selectedAcId, mode);
      });
      wrap.appendChild(tick);
    });
  }
  for (const child of Array.from(wrap.children) as HTMLElement[]) {
    child.classList.toggle("active", child.dataset.mode === ac.fanMode);
  }
}

function renderPanel(acs: AcState[]): void {
  const panel = panelEl;
  if (!panel) return;
  const ac = selectedAcId ? acs.find((a) => a.entityId === selectedAcId) : undefined;
  if (!ac) {
    panel.classList.remove("open");
    return;
  }
  panel.classList.add("open");

  const badge = badgeEls.get(ac.entityId);
  if (badge) panel.style.left = `${badge.offsetLeft}px`;

  const name = el("ac-panel-name");
  const ambient = el("ac-panel-ambient");
  const target = el("ac-panel-target");
  if (name) name.textContent = ac.name;
  if (ambient) ambient.textContent = ac.current !== null ? `${fmt(ac.current, 1)}° ambiente` : "";
  if (target) target.textContent = ac.target !== null ? `${fmt(ac.target)}°` : "--°";

  const modesWrap = el("ac-panel-modes");
  if (modesWrap) {
    for (const btn of Array.from(modesWrap.children) as HTMLElement[]) {
      btn.classList.toggle("active", btn.dataset.mode === ac.mode);
    }
  }

  renderPanelFan(ac);
}

function renderAcs(acs: AcState[]): void {
  const wrap = el("ac-badges");
  if (!wrap) return;
  if (!panelEl) panelEl = buildPanel();

  const key = acs.map((a) => a.entityId).join("|");
  if (key !== badgeKey) {
    badgeKey = key;
    wrap.innerHTML = "";
    badgeEls.clear();
    for (const ac of acs) {
      const badge = buildBadge(ac.entityId);
      badgeEls.set(ac.entityId, badge);
      wrap.appendChild(badge);
    }
    wrap.appendChild(panelEl);
    if (selectedAcId && !acs.some((a) => a.entityId === selectedAcId)) selectedAcId = null;
  }

  for (const ac of acs) {
    const badge = badgeEls.get(ac.entityId);
    if (badge) updateBadge(badge, ac, ac.entityId === selectedAcId);
  }

  renderPanel(acs);
}

// --- Photo nav: prev / play-pause / next --------------------------------

function updatePlayPauseIcon(): void {
  const icon = el("nav-playpause-icon");
  const btn = el<HTMLButtonElement>("nav-playpause");
  const paused = isPaused();
  if (icon) icon.innerHTML = paused ? ICON_PLAY_PATH : ICON_PAUSE_PATH;
  if (btn) btn.setAttribute("aria-label", paused ? "Resume slideshow" : "Pause slideshow");
}

function wireNav(): void {
  el<HTMLButtonElement>("nav-prev")?.addEventListener("click", () => stepPhoto(-1));
  el<HTMLButtonElement>("nav-next")?.addEventListener("click", () => stepPhoto(1));
  el<HTMLButtonElement>("nav-playpause")?.addEventListener("click", () => {
    togglePause();
    updatePlayPauseIcon();
  });
  updatePlayPauseIcon();
}

// --- Settings panel (Fully Kiosk: brightness / screen off / restart) ----

let settingsOpen = false;

function renderSettings(): void {
  const panel = el("settings-panel");
  if (panel) panel.classList.toggle("open", settingsOpen);
  if (!settingsOpen) hideRestartConfirm();
}

function hideRestartConfirm(): void {
  el("settings-restart-confirm")?.classList.remove("open");
}

function closeSettings(): void {
  if (!settingsOpen) return;
  settingsOpen = false;
  renderSettings();
}

function wireSettings(): void {
  el<HTMLButtonElement>("settings-gear")?.addEventListener("click", () => {
    settingsOpen = !settingsOpen;
    renderSettings();
  });
  el<HTMLButtonElement>("settings-close")?.addEventListener("click", closeSettings);

  const slider = el<HTMLInputElement>("brightness-slider");
  slider?.addEventListener("input", () => {
    void setBrightness(Number(slider.value));
  });

  el<HTMLButtonElement>("settings-screen-off")?.addEventListener("click", () => {
    void setScreenOn(false);
  });

  // Restart is destructive-ish (kicks the user off the kiosk app briefly), so
  // it requires an inline confirm step rather than firing on first tap.
  el<HTMLButtonElement>("settings-restart")?.addEventListener("click", () => {
    el("settings-restart-confirm")?.classList.add("open");
  });
  el<HTMLButtonElement>("settings-restart-confirm-cancel")?.addEventListener("click", hideRestartConfirm);
  el<HTMLButtonElement>("settings-restart-confirm-yes")?.addEventListener("click", () => {
    hideRestartConfirm();
    void restartApp();
  });
}

// --- Top-level render ---------------------------------------------------

function render(s: FrameState): void {
  const battery = el("battery");
  const battStatus = el("battery-status");
  const housePower = el("house-power");
  if (battery) battery.textContent = fmt(s.battery);
  if (battStatus) battStatus.textContent = batteryStatusGlyph(s.batteryStatus);
  if (housePower) housePower.textContent = fmtPower(s.housePower);

  renderWeather(s.weather, s.weatherTemp);
  renderAcs(s.acs);

  // Stale dot: visible whenever we're showing last-known (disconnected/offline).
  const dot = el("stale-dot");
  if (dot) dot.classList.toggle("on", s.stale);
}

// --- Dim-on-idle overlay -----------------------------------------------------

function dim(): void {
  const overlay = el("overlay");
  if (overlay) overlay.classList.add("ov-dim");
  // Start every wake from a clean, all-collapsed badge row.
  if (selectedAcId !== null) {
    selectedAcId = null;
    renderAcs(getState().acs);
  }
  // The nav/gear layer fades to fully hidden on dim (see .ov-controls) — close
  // the settings panel with it rather than leaving it open-but-invisible.
  closeSettings();
}

function wake(): void {
  const overlay = el("overlay");
  if (!overlay) return;
  overlay.classList.remove("ov-dim");
  if (dimTimer) window.clearTimeout(dimTimer);
  dimTimer = window.setTimeout(dim, OVERLAY.DIM_AFTER_MS);
}

// --- Wiring -----------------------------------------------------------------

export function startOverlay(): void {
  tickClock();
  window.setInterval(tickClock, 1000);

  onState(render);
  wireNav();
  wireSettings();

  // Any touch/click/move wakes the overlay to full opacity; it dims itself
  // again after OVERLAY.DIM_AFTER_MS of inactivity. touchstart/pointerdown
  // cover touch input, not just mouse.
  for (const evt of ["pointerdown", "touchstart", "mousemove", "keydown"]) {
    window.addEventListener(evt, wake, { passive: true });
  }
  wake();
}
