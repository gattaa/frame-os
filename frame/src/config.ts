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
  WEATHER: "__mock_weather__",
  /**
   * One or more `climate.*` entities, one badge each in the overlay. Empty
   * until loadRuntimeConfig() resolves (or in mock mode, where mock-entities.json
   * supplies its own entity_id per room — see data.ts).
   */
  CLIMATES: [] as string[],
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
    ENTITIES.WEATHER,
    ENTITIES.NIGHT_MODE,
    ...ENTITIES.CLIMATES,
  ];
}

// --- Remote endpoints (Home Assistant, frame-uploader) -----------------------
// Placeholders only — real values are loaded at runtime by loadRuntimeConfig().
// Never baked into the build: dist/ is committed to a public repo, so any
// build-time-injected value (env vars included) would be publicly visible.

/** Shape shared by every remote service the PWA authenticates to at runtime. */
interface RemoteEndpoint {
  BASE_URL: string;
  /** Bearer/shared-secret token. Never in the build — loaded at runtime. */
  TOKEN: string;
}

function applyEndpoint(target: RemoteEndpoint, baseUrl: string | undefined, token: string | undefined): void {
  target.BASE_URL = baseUrl || "";
  target.TOKEN = token || "";
}

export const HA: RemoteEndpoint = {
  BASE_URL: "",
  TOKEN: "",
};

/**
 * The frame-uploader add-on, for `POST /favourite` (heart toggle + gallery).
 * The kiosk display isn't a logged-in HA session, so it can't resolve/
 * authenticate an ingress path — reaching the add-on requires its
 * mapped-port fallback (see haos-addons/frame-uploader/DOCS.md, "Alternative:
 * mapped port"), hence a base URL + bearer token here rather than a relative
 * path.
 */
export const UPLOADER: RemoteEndpoint = {
  BASE_URL: "",
  TOKEN: "",
};

interface RuntimeHaConfig {
  haUrl: string;
  haToken: string;
  entities: {
    battery: string;
    batteryStatus: string;
    housePower: string;
    climates: string[];
    weather: string;
  };
  /** Optional: only needed to enable the gallery's favourite toggle. */
  uploaderUrl?: string;
  uploaderToken?: string;
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
    applyEndpoint(HA, cfg.haUrl, cfg.haToken);
    applyEndpoint(UPLOADER, cfg.uploaderUrl, cfg.uploaderToken);
    if (cfg.entities) {
      ENTITIES.BATTERY_PCT = cfg.entities.battery || ENTITIES.BATTERY_PCT;
      ENTITIES.BATTERY_STATUS = cfg.entities.batteryStatus || ENTITIES.BATTERY_STATUS;
      ENTITIES.HOUSE_POWER = cfg.entities.housePower || ENTITIES.HOUSE_POWER;
      ENTITIES.CLIMATES = Array.isArray(cfg.entities.climates) ? cfg.entities.climates : ENTITIES.CLIMATES;
      ENTITIES.WEATHER = cfg.entities.weather || ENTITIES.WEATHER;
    }
  } catch (err) {
    console.warn("[config] no runtime-config.json; falling back to mock mode", err);
    USE_MOCK = true;
  }
}

// --- Kiosk panel backend (brightness / screen wake / force refresh) --------
// See brightness.ts. Which local kiosk app's REST API to drive; "none"
// (default, e.g. desktop dev) no-ops everywhere.

export type PanelBackendKind = "wallpanel" | "fully" | "none";

function panelBackend(): PanelBackendKind {
  const v = str("VITE_PANEL_BACKEND", "none");
  return v === "wallpanel" || v === "fully" ? v : "none";
}

export const PANEL = {
  BACKEND: panelBackend(),
  /** WallPanel's local REST API (POST JSON to `${BASE}/api/command`).
   *  Same-device localhost only — no ingress/auth token needed. */
  WALLPANEL_BASE: str("VITE_WALLPANEL_BASE", "http://127.0.0.1:2971"),
  /** Legacy Fully Kiosk REST API, kept for devices not yet migrated to WallPanel. */
  FULLY_BASE: str("VITE_FULLY_KIOSK_BASE", "http://127.0.0.1:2323"),
  FULLY_PASSWORD: str("VITE_FULLY_PASSWORD", ""),
} as const;

// --- Data paths (served at <base>* directly; see vite.config.ts) -----------
// The frame-uploader add-on writes manifest.json/photos/ straight into
// config/www/frame/ (no data/ subfolder), served by HA at /local/frame/.
// serveData in vite.config.ts mirrors that layout for dev/preview by
// forwarding requests straight through to the pipeline's ../data directory.
//
// import.meta.env.BASE_URL always has a trailing slash (Vite guarantees this),
// so these defaults resolve correctly whether the app is served from domain
// root (dev) or from HA's /local/frame/ (prod). Override via env for anything
// else (e.g. serving data from a different host).
const BASE_URL = import.meta.env.BASE_URL;

export const PATHS = {
  MANIFEST: str("VITE_MANIFEST_URL", `${BASE_URL}manifest.json`),
  PHOTOS_BASE: str("VITE_PHOTOS_BASE", `${BASE_URL}photos`),
  /** Gallery-grid thumbnails (<=300px) — see haos-addons/frame-uploader. */
  THUMBS_BASE: str("VITE_THUMBS_BASE", `${BASE_URL}thumbs`),
  MOCK_ENTITIES: str("VITE_MOCK_ENTITIES_URL", `${BASE_URL}mock-entities.json`),
} as const;

/**
 * `POST /favourite` lives on the UPLOADER host, not the display's own origin
 * (see UPLOADER above) — computed lazily since UPLOADER.BASE_URL is only
 * populated once loadRuntimeConfig() resolves. Empty when unconfigured (dev/
 * mock, or a box that hasn't set up the mapped-port fallback yet); callers
 * treat that as "favouriting unavailable" rather than erroring.
 */
export function favouriteUrl(): string {
  return UPLOADER.BASE_URL ? `${UPLOADER.BASE_URL}/favourite` : "";
}

// --- Behaviour tunables -----------------------------------------------------

export const SLIDESHOW = {
  INTERVAL_MS: 12_000,
  CROSSFADE_MS: 1200,
  /** Re-fetch the manifest this often so photos added after boot appear
   *  without a reload (the frame is always-on). */
  MANIFEST_REFRESH_MS: Math.max(1000, Number(str("VITE_MANIFEST_REFRESH_MS", "60000")) || 60_000),
  /** Screen aspect ratio (1280x800). Photos whose aspect ratio deviates from
   *  this by more than ASPECT_DEVIATION_THRESHOLD get letterboxed/pillarboxed
   *  in black instead of being cropped to fill. */
  SCREEN_RATIO: 1280 / 800,
  ASPECT_DEVIATION_THRESHOLD: 0.15,
} as const;

export const OVERLAY = {
  /** Fade the overlay to its dim resting state this long after the last touch;
   *  a touch anywhere brings it back to full opacity. */
  DIM_AFTER_MS: 8_000,
} as const;

/**
 * Brightness levels (0–255) for the optional PWA-driven panel-backend path
 * (`brightness.ts`, gated by `PANEL.BACKEND !== "none"`). Day/night is now
 * decided by HA's `frame_night_mode`, not a local clock — by default HA also
 * owns brightness (via the ha/ package), so these only apply if you turn on
 * the PWA's secondary brightness control.
 */
export const SCHEDULE = {
  DAY_BRIGHTNESS: 220,
  NIGHT_BRIGHTNESS: 60,
} as const;

/**
 * Auto-dim (see autodim.ts): an opt-in toggle (persisted in localStorage, set
 * from the settings panel) that drops brightness to AUTO_DIM_BRIGHTNESS after
 * AFTER_MS of no touch, and restores the day/night SCHEDULE level on the next
 * touch. Independent of OVERLAY.DIM_AFTER_MS, which only fades the on-screen
 * chrome (a few seconds) — this is a much longer real-departure timeout for
 * the physical backlight.
 */
export const AUTO_DIM = {
  AFTER_MS: 5 * 60_000,
  BRIGHTNESS: 20,
} as const;
