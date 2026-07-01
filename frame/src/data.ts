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
  mode: string;
  current: number | null;
  target: number | null;
  hvacModes: string[];
  minTemp: number;
  maxTemp: number;
  step: number;
}

export interface FrameState {
  battery: number | null;
  /**
   * Raw HA state string, passed through as-is (not parsed/validated as a
   * number). Expected values: "Charging" | "Discharging" | "Idle".
   */
  batteryStatus: string | null;
  housePower: number | null;
  ac: AcState | null;
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
  ac: null,
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
}

function acFromEntity(entityId: string, e: HassLike | undefined): AcState | null {
  if (!e) return null;
  const a = e.attributes || {};
  const modes = Array.isArray(a["hvac_modes"]) ? (a["hvac_modes"] as string[]) : [];
  return {
    entityId,
    mode: String(e.state),
    current: num(a["current_temperature"]),
    target: num(a["temperature"]),
    hvacModes: modes.length ? modes : ["off"],
    minTemp: num(a["min_temp"]) ?? 16,
    maxTemp: num(a["max_temp"]) ?? 30,
    step: num(a["target_temp_step"]) ?? 0.5,
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

/** Build FrameState from a map of entity_id -> hass entity. */
function fromEntityMap(map: Record<string, HassLike | undefined>): Partial<FrameState> {
  const battery = map[ENTITIES.BATTERY_PCT];
  const batteryStatus = map[ENTITIES.BATTERY_STATUS];
  const housePower = map[ENTITIES.HOUSE_POWER];
  const ac = map[ENTITIES.CLIMATE_AC];
  return {
    battery: battery ? num(battery.state) : null,
    batteryStatus: batteryStatus ? String(batteryStatus.state) : null,
    housePower: housePower ? num(housePower.state) : null,
    ac: acFromEntity(ENTITIES.CLIMATE_AC, ac),
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
  ac?: HassLike;
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
      [ENTITIES.CLIMATE_AC]: j.ac,
      [ENTITIES.NIGHT_MODE]: j.night_mode,
    };
    // The SW tags cache-served responses; that is the precise "showing
    // last-known, not live" signal. We deliberately do NOT use navigator.onLine
    // here: on the frame, /data is served from the local host, so onLine can be
    // false (no internet) while the data is perfectly fresh over the LAN.
    const stale = res.headers.get("X-From-Cache") === "1";
    emit({ ...fromEntityMap(map), connected: !stale, stale });
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

/** Nudge the AC target by `delta` degrees (optimistic; persists locally). */
export async function nudgeAcTarget(delta: number): Promise<void> {
  const ac = current.ac;
  if (!ac || ac.target === null) return;
  const next = clamp(ac.target + delta, ac.minTemp, ac.maxTemp);
  emit({ ac: { ...ac, target: next } });
  void persist();

  if (USE_MOCK || !conn) return; // dev/offline: optimistic only
  try {
    const haws = await getHaws();
    await haws.callService(conn, "climate", "set_temperature",
      { temperature: next }, { entity_id: ac.entityId });
  } catch (err) {
    console.error("[data] set_temperature failed", err);
  }
}

/** Advance the AC to the next hvac mode (optimistic; persists locally). */
export async function cycleAcMode(): Promise<void> {
  const ac = current.ac;
  if (!ac || ac.hvacModes.length === 0) return;
  const i = ac.hvacModes.indexOf(ac.mode);
  const next = ac.hvacModes[(i + 1) % ac.hvacModes.length];
  emit({ ac: { ...ac, mode: next } });
  void persist();

  if (USE_MOCK || !conn) return;
  try {
    const haws = await getHaws();
    await haws.callService(conn, "climate", "set_hvac_mode",
      { hvac_mode: next }, { entity_id: ac.entityId });
  } catch (err) {
    console.error("[data] set_hvac_mode failed", err);
  }
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
