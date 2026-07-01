/**
 * Data layer: Home Assistant state in, normalized FrameState out.
 *
 * Live mode uses `home-assistant-js-websocket` to subscribe to the configured
 * entities. Every update is mirrored to IndexedDB so the overlay survives
 * reloads and dropouts. On disconnect — or in mock/DEV mode when the network is
 * gone — we fall back to the last-known value and flag it stale. Missing
 * entities never crash; their values just render as "--".
 */

import {
  ENTITIES,
  HA,
  PATHS,
  getSubscribedEntityIds,
  loadRuntimeConfig,
  USE_MOCK,
} from "./config";
import { idbGet, idbSet } from "./idb";

export interface AcState {
  entityId: string;
  name: string;
  mode: string;
  current: number | null;
  target: number | null;
  hvacModes: string[];
  minTemp: number;
  maxTemp: number;
  step: number;
  fanMode: string | null;
  fanModes: string[];
}

export interface FrameState {
  battery: number | null;
  /**
   * Raw HA state string, passed through as-is (not parsed/validated as a
   * number). Expected values: "Charging" | "Discharging" | "Idle".
   */
  batteryStatus: string | null;
  housePower: number | null;
  /** One entry per configured climate entity, in config order. */
  acs: AcState[];
  /** Raw weather.* state (e.g. "sunny", "rainy"); null when unavailable/missing. */
  weather: string | null;
  /** Outdoor temperature from the weather entity's `temperature` attribute. */
  weatherTemp: number | null;
  /** HA day/night source of truth; null when unknown. true = night. */
  nightMode: boolean | null;
  updatedAt: number;
  connected: boolean;
  stale: boolean;
}

const IDB_KEY = "last-state";

const EMPTY: FrameState = {
  battery: null,
  batteryStatus: null,
  housePower: null,
  acs: [],
  weather: null,
  weatherTemp: null,
  nightMode: null,
  updatedAt: 0,
  connected: false,
  stale: true,
};

type Listener = (s: FrameState) => void;
const listeners: Listener[] = [];
let current: FrameState = { ...EMPTY };

export function onState(cb: Listener): void {
  listeners.push(cb);
  cb(current);
}

export function getState(): FrameState {
  return current;
}

function emit(next: Partial<FrameState>): void {
  current = { ...current, ...next };
  for (const cb of listeners) {
    try {
      cb(current);
    } catch (err) {
      console.error("[data] listener error", err);
    }
  }
}

function num(v: unknown): number | null {
  const n = typeof v === "number" ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}

// --- Normalizers ------------------------------------------------------------

interface HassLike {
  state: unknown;
  attributes?: Record<string, unknown>;
  /** Only set in mock-entities.json's `acs` list, which carries its own id per room. */
  entity_id?: string;
}

function acFromEntity(entityId: string, e: HassLike | undefined): AcState | null {
  if (!e) return null;
  const a = e.attributes || {};
  const modes = Array.isArray(a["hvac_modes"]) ? (a["hvac_modes"] as string[]) : [];
  const fanModes = Array.isArray(a["fan_modes"]) ? (a["fan_modes"] as string[]) : [];
  return {
    entityId,
    name: typeof a["friendly_name"] === "string" ? a["friendly_name"] : "AC",
    mode: String(e.state),
    current: num(a["current_temperature"]),
    target: num(a["temperature"]),
    hvacModes: modes.length ? modes : ["off"],
    minTemp: num(a["min_temp"]) ?? 16,
    maxTemp: num(a["max_temp"]) ?? 30,
    step: num(a["target_temp_step"]) ?? 0.5,
    fanMode: typeof a["fan_mode"] === "string" ? a["fan_mode"] : null,
    fanModes,
  };
}

/**
 * Resolve the night-mode boolean. On a transient HA dropout the entity reports
 * "unavailable"/"unknown" (or vanishes from the payload); treating that as
 * "day" would flash the frame from dark to light. Instead, keep the last-known
 * value so the theme only changes on a real on/off.
 */
function nightFrom(night: HassLike | undefined): boolean | null {
  if (!night) return current.nightMode;
  const s = String(night.state);
  if (s === "on") return true;
  if (s === "off") return false;
  return current.nightMode; // unavailable / unknown -> hold last-known
}

/** Raw weather state, or null if the entity is missing/unavailable/unknown. */
function weatherFrom(weather: HassLike | undefined): string | null {
  if (!weather) return null;
  const s = String(weather.state);
  if (s === "unavailable" || s === "unknown") return null;
  return s;
}

/** Outdoor temperature from the weather entity's `temperature` attribute. */
function weatherTempFrom(weather: HassLike | undefined): number | null {
  if (!weather) return null;
  return num(weather.attributes?.["temperature"]);
}

/** One AcState per configured climate entity; entities that aren't in the map are omitted. */
function acsFromEntityMap(map: Record<string, HassLike | undefined>): AcState[] {
  return ENTITIES.CLIMATES
    .map((id) => acFromEntity(id, map[id]))
    .filter((ac): ac is AcState => ac !== null);
}

/** Build FrameState (minus acs, handled separately per-mode) from a map of entity_id -> hass entity. */
function fromEntityMap(map: Record<string, HassLike | undefined>): Partial<FrameState> {
  const battery = map[ENTITIES.BATTERY_PCT];
  const batteryStatus = map[ENTITIES.BATTERY_STATUS];
  const housePower = map[ENTITIES.HOUSE_POWER];
  return {
    battery: battery ? num(battery.state) : null,
    batteryStatus: batteryStatus ? String(batteryStatus.state) : null,
    housePower: housePower ? num(housePower.state) : null,
    acs: acsFromEntityMap(map),
    weather: weatherFrom(map[ENTITIES.WEATHER]),
    weatherTemp: weatherTempFrom(map[ENTITIES.WEATHER]),
    nightMode: nightFrom(map[ENTITIES.NIGHT_MODE]),
    updatedAt: Date.now(),
    connected: true,
    stale: false,
  };
}

// --- Persistence ------------------------------------------------------------

async function persist(): Promise<void> {
  await idbSet(IDB_KEY, current);
}

async function hydrateFromCache(): Promise<void> {
  const cached = await idbGet<FrameState>(IDB_KEY);
  if (cached) {
    // Anything from cache is by definition last-known => stale until refreshed.
    emit({ ...cached, connected: false, stale: true });
  }
}

// --- Mock mode --------------------------------------------------------------

interface MockEntities {
  battery?: HassLike;
  batteryStatus?: HassLike;
  housePower?: HassLike;
  /** Each entry carries its own entity_id — mock mode doesn't go through ENTITIES.CLIMATES. */
  acs?: HassLike[];
  weather?: HassLike;
  night_mode?: HassLike;
}

async function pollMock(): Promise<void> {
  try {
    const res = await fetch(PATHS.MOCK_ENTITIES, { cache: "no-cache" });
    if (!res.ok) throw new Error(`mock entities ${res.status}`);
    const j = (await res.json()) as MockEntities;
    const map: Record<string, HassLike | undefined> = {
      [ENTITIES.BATTERY_PCT]: j.battery,
      [ENTITIES.BATTERY_STATUS]: j.batteryStatus,
      [ENTITIES.HOUSE_POWER]: j.housePower,
      [ENTITIES.WEATHER]: j.weather,
      [ENTITIES.NIGHT_MODE]: j.night_mode,
    };
    const acs = (j.acs || [])
      .map((e) => acFromEntity(e.entity_id || "", e))
      .filter((ac): ac is AcState => ac !== null);
    // The SW tags cache-served responses; that is the precise "showing
    // last-known, not live" signal. We deliberately do NOT use navigator.onLine
    // here: on the frame, /data is served from the local host, so onLine can be
    // false (no internet) while the data is perfectly fresh over the LAN.
    const stale = res.headers.get("X-From-Cache") === "1";
    emit({ ...fromEntityMap(map), acs, connected: !stale, stale });
    await persist();
  } catch (err) {
    // Offline (e.g. throttled reload): keep last-known, mark stale.
    console.warn("[data] mock fetch failed; using last-known", err);
    emit({ connected: false, stale: true });
  }
}

// --- Live mode (home-assistant-js-websocket) --------------------------------

// Loosely typed to avoid leaking the lib's types across the module boundary.
let conn: any = null;

// Cache the lazily-imported lib so AC actions don't re-resolve it each press.
type Haws = typeof import("home-assistant-js-websocket");
let hawsMod: Haws | null = null;
async function getHaws(): Promise<Haws> {
  if (!hawsMod) hawsMod = await import("home-assistant-js-websocket");
  return hawsMod;
}

async function connectLive(): Promise<void> {
  if (!HA.TOKEN) {
    console.warn("[data] no HA token configured; staying on last-known");
    emit({ connected: false, stale: true });
    return;
  }
  try {
    const haws = await getHaws();
    const auth = haws.createLongLivedTokenAuth(HA.BASE_URL, HA.TOKEN);
    conn = await haws.createConnection({ auth });

    conn.addEventListener("disconnected", () => emit({ connected: false, stale: true }));
    conn.addEventListener("ready", () => emit({ connected: true, stale: false }));

    haws.subscribeEntities(conn, (entities: Record<string, HassLike>) => {
      const map: Record<string, HassLike | undefined> = {};
      for (const id of getSubscribedEntityIds()) map[id] = entities[id];
      emit(fromEntityMap(map));
      void persist();
    });
  } catch (err) {
    console.error("[data] HA connection failed; using last-known", err);
    emit({ connected: false, stale: true });
  }
}

// --- AC control -------------------------------------------------------------

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

async function callClimate(entityId: string, service: string,
  data: Record<string, unknown>): Promise<void> {
  if (USE_MOCK || !conn) return; // dev/offline: optimistic only
  try {
    const haws = await getHaws();
    await haws.callService(conn, "climate", service, data, { entity_id: entityId });
  } catch (err) {
    console.error(`[data] ${service} failed`, err);
  }
}

function findAc(entityId: string): AcState | null {
  return current.acs.find((a) => a.entityId === entityId) || null;
}

/** Replace one room's AcState in place, keeping the others untouched. */
function patchAc(entityId: string, patch: Partial<AcState>): void {
  emit({
    acs: current.acs.map((a) => (a.entityId === entityId ? { ...a, ...patch } : a)),
  });
}

/**
 * Flame button: heat + bump the setpoint 3° above current. Fires
 * set_hvac_mode BEFORE set_temperature, awaited in sequence — some climate
 * integrations validate/clamp the setpoint against the mode that's active
 * *at the time the temperature call lands*, so sending the mode first avoids
 * a brief window where the target is interpreted under the old mode.
 */
export async function acHeat(entityId: string): Promise<void> {
  const ac = findAc(entityId);
  if (!ac || ac.current === null) return;
  const target = clamp(ac.current + 3, ac.minTemp, ac.maxTemp);
  patchAc(entityId, { mode: "heat", target });
  void persist();
  await callClimate(entityId, "set_hvac_mode", { hvac_mode: "heat" });
  await callClimate(entityId, "set_temperature", { temperature: target });
}

/** Ice button: cool + drop the setpoint 3° below current. Same call order as acHeat(). */
export async function acCool(entityId: string): Promise<void> {
  const ac = findAc(entityId);
  if (!ac || ac.current === null) return;
  const target = clamp(ac.current - 3, ac.minTemp, ac.maxTemp);
  patchAc(entityId, { mode: "cool", target });
  void persist();
  await callClimate(entityId, "set_hvac_mode", { hvac_mode: "cool" });
  await callClimate(entityId, "set_temperature", { temperature: target });
}

/** Off button: hvac_mode only — never touches temperature or fan_mode. */
export async function acOff(entityId: string): Promise<void> {
  if (!findAc(entityId)) return;
  patchAc(entityId, { mode: "off" });
  void persist();
  await callClimate(entityId, "set_hvac_mode", { hvac_mode: "off" });
}

/** +/- setpoint buttons in the expanded panel: nudge the target by one step, independent of mode. */
export async function stepAcTarget(entityId: string, delta: number): Promise<void> {
  const ac = findAc(entityId);
  if (!ac || ac.target === null) return;
  const target = clamp(ac.target + delta * ac.step, ac.minTemp, ac.maxTemp);
  if (target === ac.target) return;
  patchAc(entityId, { target });
  void persist();
  await callClimate(entityId, "set_temperature", { temperature: target });
}

/** Set fan_mode directly (tapping a tick). Independent of hvac_mode/temperature. */
export async function setAcFanMode(entityId: string, mode: string): Promise<void> {
  if (!findAc(entityId)) return;
  patchAc(entityId, { fanMode: mode });
  void persist();
  await callClimate(entityId, "set_fan_mode", { fan_mode: mode });
}

// --- Lifecycle --------------------------------------------------------------

// If nothing has updated for this long, treat the data as stale even if the
// link still looks "connected". Catches a silent stall (HA reachable but an
// integration hung and the entity stopped publishing) that emits no
// disconnect event. Generous so a genuinely quiet but healthy feed (HA only
// pushes on change) doesn't false-trip.
const STALE_AFTER_MS = 15 * 60 * 1000;

function startFreshnessWatch(): void {
  window.setInterval(() => {
    if (current.updatedAt > 0 && !current.stale &&
        Date.now() - current.updatedAt > STALE_AFTER_MS) {
      console.warn("[data] no update in >%d min; marking stale", STALE_AFTER_MS / 60000);
      emit({ stale: true });
    }
  }, 60_000);
}

/** Start the data layer: hydrate from cache, then connect live or poll mock. */
export async function startData(): Promise<void> {
  await hydrateFromCache();
  await loadRuntimeConfig();
  if (USE_MOCK) {
    await pollMock();
    // Re-poll occasionally so a regenerated mock or restored network recovers.
    window.setInterval(() => void pollMock(), 30_000);
  } else {
    await connectLive();
  }
  startFreshnessWatch();
}
