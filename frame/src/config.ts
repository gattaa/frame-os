/**
 * Central configuration for the frame-os PWA.
 *
 * Most values come from Vite env vars (`VITE_*`, see .env.example), baked in
 * at build time. The Home Assistant URL, token, and entity IDs are the
 * exception: `dist/` is committed to a public repo, so anything build-time-
 * injected there is publicly visible. Those 5 values are instead fetched at
 * runtime from `runtime-config.json` (see `loadRuntimeConfig` below), which
 * lives only on the HA box and is never committed. See runtime-config.example.json.
 */

type Env = Record<string, string | boolean | undefined>;
const ENV = import.meta.env as unknown as Env;

function str(key: string, fallback: string): string {
  const v = ENV[key];
  return typeof v === "string" && v !== "" ? v : fallback;
}
function bool(key: string, fallback: boolean): boolean {
  const v = ENV[key];
  if (v === undefined || v === "") return fallback;
  return v === true || v === "true" || v === "1";
}

/** Vite is in dev (`vite dev`) — true for `dev`, false for `build`. */
export const DEV: boolean = import.meta.env.DEV === true;

/**
 * Master switch: when true, the data layer reads mock JSON instead of talking
 * to Home Assistant, and Fully Kiosk / service calls become no-ops. Defaults
 * to on in dev; force it in a build with `VITE_USE_MOCK=true`. Also flipped
 * on at runtime if `runtime-config.json` can't be loaded (see below), so a
 * box without that file falls back to mock instead of a dead live connection.
 */
export let USE_MOCK: boolean = bool("VITE_USE_MOCK", DEV);

// --- Home Assistant entity IDs -----------------------------------------------
// Not real entity IDs — just internal map keys until loadRuntimeConfig() (or a
// live runtime-config.json) replaces them, so no HA entity-naming info ships
// in the build.

export const ENTITIES = {
  BATTERY_PCT: "__mock_battery__",
  BATTERY_STATUS: "__mock_battery_status__",
  HOUSE_POWER: "__mock_house_power__",
  CLIMATE_AC: "__mock_climate__",
  /**
   * Single source of truth for day/night — an HA input_boolean driven by the
   * ha/ package (sun elevation + override). The PWA reads this for its theme
   * instead of guessing from the local clock, so theme and the HA-driven screen
   * brightness stay in lockstep. Not sensitive (just an entity name), so this
   * one alone is still fine to bake in via env var.
   */
  NIGHT_MODE: str("VITE_HA_NIGHT_MODE", "input_boolean.frame_night_mode"),
};

/** The set of entity IDs we subscribe to. Call fresh each time — entity IDs
 *  may change after loadRuntimeConfig() resolves. */
export function getSubscribedEntityIds(): string[] {
  return [
    ENTITIES.BATTERY_PCT,
    ENTITIES.BATTERY_STATUS,
    ENTITIES.HOUSE_POWER,
    ENTITIES.CLIMATE_AC,
    ENTITIES.NIGHT_MODE,
  ];
}

// --- Home Assistant connection -----------------------------------------------
// Placeholders only — real values are loaded at runtime by loadRuntimeConfig().

export const HA = {
  BASE_URL: "",
  /** Long-lived access token. Never in the build — loaded at runtime. */
  TOKEN: "",
};

interface RuntimeHaConfig {
  haUrl: string;
  haToken: string;
  entities: {
    battery: string;
    batteryStatus: string;
    housePower: string;
    climate: string;
  };
}

let runtimeConfigLoaded = false;

/**
 * Fetch HA_URL/HA_TOKEN/entity IDs from `<base>runtime-config.json` — a file
 * that lives only on the HA box (see runtime-config.example.json), never in
 * the repo or the build. Call once at boot, before connecting to HA. If the
 * fetch 404s (no runtime-config.json deployed, e.g. local dev), falls back to
 * mock mode rather than attempting a live connection with no credentials.
 */
export async function loadRuntimeConfig(): Promise<void> {
  if (runtimeConfigLoaded) return;
  runtimeConfigLoaded = true;
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}runtime-config.json`, { cache: "no-cache" });
    if (!res.ok) throw new Error(`runtime-config.json ${res.status}`);
    const cfg = (await res.json()) as RuntimeHaConfig;
    HA.BASE_URL = cfg.haUrl || "";
    HA.TOKEN = cfg.haToken || "";
    if (cfg.entities) {
      ENTITIES.BATTERY_PCT = cfg.entities.battery || ENTITIES.BATTERY_PCT;
      ENTITIES.BATTERY_STATUS = cfg.entities.batteryStatus || ENTITIES.BATTERY_STATUS;
      ENTITIES.HOUSE_POWER = cfg.entities.housePower || ENTITIES.HOUSE_POWER;
      ENTITIES.CLIMATE_AC = cfg.entities.climate || ENTITIES.CLIMATE_AC;
    }
  } catch (err) {
    console.warn("[config] no runtime-config.json; falling back to mock mode", err);
    USE_MOCK = true;
  }
}

// --- Fully Kiosk REST (brightness / screen control) ------------------------

export const FULLY_KIOSK = {
  /** Set false in desktop dev so brightness.ts no-ops. */
  ENABLED: bool("VITE_FULLY_ENABLED", false),
  BASE: str("VITE_FULLY_KIOSK_BASE", "http://127.0.0.1:2323"),
  PASSWORD: str("VITE_FULLY_PASSWORD", ""),
} as const;

// --- Data paths (served at <base>data/* in dev, preview & prod; see
// vite.config.ts) ------------------------------------------------------------

// import.meta.env.BASE_URL always has a trailing slash (Vite guarantees this),
// so these defaults resolve correctly whether the app is served from domain
// root (dev) or from HA's /local/frame/ (prod). Override via env for anything
// else (e.g. serving data from a different host).
const BASE_URL = import.meta.env.BASE_URL;

export const PATHS = {
  MANIFEST: str("VITE_MANIFEST_URL", `${BASE_URL}data/manifest.json`),
  PHOTOS_BASE: str("VITE_PHOTOS_BASE", `${BASE_URL}data/photos`),
  MOCK_ENTITIES: str("VITE_MOCK_ENTITIES_URL", `${BASE_URL}data/mock-entities.json`),
} as const;

// --- Behaviour tunables -----------------------------------------------------

export const SLIDESHOW = {
  INTERVAL_MS: 12_000,
  CROSSFADE_MS: 1200,
  /** Re-fetch the manifest this often so photos added after boot appear
   *  without a reload (the frame is always-on). */
  MANIFEST_REFRESH_MS: Math.max(1000, Number(str("VITE_MANIFEST_REFRESH_MS", "60000")) || 60_000),
  /** Slow Ken Burns pan/zoom on each photo. */
  KEN_BURNS: bool("VITE_KEN_BURNS", true),
} as const;

export const OVERLAY = {
  /** Dim the bar this long after the last touch, to avoid OLED retention. */
  DIM_AFTER_MS: 8_000,
  DIM_OPACITY: 0.16,
  /** Nudge the bar a few px on this cadence so it never burns a fixed spot. */
  NUDGE_EVERY_MS: 90_000,
} as const;

/**
 * Brightness levels (0–255) for the optional PWA-driven Fully Kiosk path
 * (`brightness.ts`, gated by `FULLY_KIOSK.ENABLED`). Day/night is now decided
 * by HA's `frame_night_mode`, not a local clock — by default HA also owns
 * brightness (via the ha/ package), so these only apply if you turn on the
 * PWA's secondary brightness control.
 */
export const SCHEDULE = {
  DAY_BRIGHTNESS: 220,
  NIGHT_BRIGHTNESS: 60,
} as const;
