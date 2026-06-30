/**
 * Central configuration for the frame-os PWA.
 *
 * Everything environment-specific lives here: the Home Assistant entity IDs the
 * overlay reads, the HA connection details, the Fully Kiosk REST base, and the
 * DEV/mock switch that lets the whole app run against the pipeline's mock JSON
 * with no live backend.
 *
 * Real values come from Vite env vars (`VITE_*`, see .env.example); the
 * placeholders below are safe defaults for mock-only development.
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
 * to on in dev; force it in a build with `VITE_USE_MOCK=true`.
 */
export const USE_MOCK: boolean = bool("VITE_USE_MOCK", DEV);

// --- Home Assistant entity IDs (placeholders; override via env) ------------

export const ENTITIES = {
  BATTERY_PCT: str("VITE_HA_BATTERY_PCT", "sensor.home_battery_level"),
  POWER_NOW: str("VITE_HA_POWER_NOW", "sensor.grid_power"),
  ENERGY_TODAY: str("VITE_HA_ENERGY_TODAY", "sensor.solar_energy_today"),
  CLIMATE_AC: str("VITE_HA_CLIMATE_AC", "climate.living_room"),
  /**
   * Single source of truth for day/night — an HA input_boolean driven by the
   * ha/ package (sun elevation + override). The PWA reads this for its theme
   * instead of guessing from the local clock, so theme and the HA-driven screen
   * brightness stay in lockstep.
   */
  NIGHT_MODE: str("VITE_HA_NIGHT_MODE", "input_boolean.frame_night_mode"),
} as const;

/** The set of entity IDs we subscribe to, derived from ENTITIES. */
export const SUBSCRIBED_ENTITY_IDS: string[] = [
  ENTITIES.BATTERY_PCT,
  ENTITIES.POWER_NOW,
  ENTITIES.ENERGY_TODAY,
  ENTITIES.CLIMATE_AC,
  ENTITIES.NIGHT_MODE,
];

// --- Home Assistant connection ---------------------------------------------

export const HA = {
  BASE_URL: str("VITE_HA_BASE_URL", "http://homeassistant.local:8123"),
  /** Long-lived access token. Never commit a real one — supply via env. */
  TOKEN: str("VITE_HA_TOKEN", ""),
} as const;

// --- Fully Kiosk REST (brightness / screen control) ------------------------

export const FULLY_KIOSK = {
  /** Set false in desktop dev so brightness.ts no-ops. */
  ENABLED: bool("VITE_FULLY_ENABLED", false),
  BASE: str("VITE_FULLY_KIOSK_BASE", "http://127.0.0.1:2323"),
  PASSWORD: str("VITE_FULLY_PASSWORD", ""),
} as const;

// --- Data paths (served at /data/* in dev & preview; see vite.config.ts) ----

export const PATHS = {
  MANIFEST: str("VITE_MANIFEST_URL", "/data/manifest.json"),
  PHOTOS_BASE: str("VITE_PHOTOS_BASE", "/data/photos"),
  MOCK_ENTITIES: str("VITE_MOCK_ENTITIES_URL", "/data/mock-entities.json"),
} as const;

// --- Behaviour tunables -----------------------------------------------------

export const SLIDESHOW = {
  INTERVAL_MS: 12_000,
  CROSSFADE_MS: 1200,
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
