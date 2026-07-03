/**
 * Kiosk panel backend abstraction — brightness / force refresh.
 *
 * The actual HTTP call is behind the small `PanelBackend` interface below so
 * the UI (overlay.ts, theme.ts, autodim.ts) never talks to a specific kiosk
 * app's REST API directly. Swapping kiosk apps again later means adding a new
 * backend here, not touching callers. Selected by `PANEL.BACKEND`
 * (`VITE_PANEL_BACKEND=wallpanel|fully|none`); "none" (the default) no-ops
 * everywhere, e.g. in desktop dev.
 */

import { PANEL } from "./config";

interface PanelBackend {
  /** 1–255. Backends clamp to their own valid range. */
  setBrightness(level: number): Promise<void>;
  /** Clear the kiosk app's local cache, without relaunching. */
  clearCache(): Promise<void>;
  /** Relaunch the kiosk app, without clearing its cache. */
  relaunch(): Promise<void>;
  /** Recover from a stale service-worker/cache state: clear cache, then relaunch. */
  forceRefresh(): Promise<void>;
}

// --- none: desktop dev / unconfigured device --------------------------------

const noneBackend: PanelBackend = {
  async setBrightness(level) {
    console.info(`[brightness] (no-op, panel backend "none") setBrightness ${level}`);
  },
  async clearCache() {
    console.info(`[brightness] (no-op, panel backend "none") clearCache`);
  },
  async relaunch() {
    console.info(`[brightness] (no-op, panel backend "none") relaunch`);
  },
  async forceRefresh() {
    console.info(`[brightness] (no-op, panel backend "none") forceRefresh`);
  },
};

// --- wallpanel: WallPanel's local REST API -----------------------------------
// POST JSON to http://<device-ip>:2971/api/command. Same-device localhost
// only, so no ingress/auth token is needed (unlike Fully's password param).

async function wallpanelPost(body: Record<string, unknown>): Promise<void> {
  try {
    // WallPanel's local server sends no CORS headers and 404s its own OPTIONS
    // preflight, so a plain `Content-Type: application/json` POST (which
    // forces a preflight) gets blocked outright as a CORS failure — it never
    // reaches the device. Sending as `text/plain` keeps this a CORS-safelisted
    // "simple request" (no preflight); WallPanel parses the JSON body
    // regardless of the declared content type. `mode: "no-cors"` (same as the
    // legacy Fully client) makes this fire-and-forget so the still-missing
    // CORS headers on the *response* don't reject the fetch.
    await fetch(`${PANEL.WALLPANEL_BASE}/api/command`, {
      method: "POST",
      mode: "no-cors",
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    console.warn(`[brightness] wallpanel command failed`, body, err);
  }
}

const wallpanelBackend: PanelBackend = {
  async setBrightness(level) {
    // WallPanel's brightness command is 1–255 (no 0, unlike Fully's 0–255).
    const clamped = Math.max(1, Math.min(255, Math.round(level)));
    await wallpanelPost({ brightness: clamped });
  },
  async clearCache() {
    await wallpanelPost({ clearCache: true });
  },
  async relaunch() {
    await wallpanelPost({ relaunch: true });
  },
  async forceRefresh() {
    await wallpanelPost({ clearCache: true });
    await wallpanelPost({ relaunch: true });
  },
};

// --- fully: legacy Fully Kiosk REST API --------------------------------------
// Kept for devices not yet migrated to WallPanel. Default port 2323.

function fullyCmdUrl(cmd: string, extra: Record<string, string>): string {
  const params = new URLSearchParams({
    cmd,
    type: "json",
    password: PANEL.FULLY_PASSWORD,
    ...extra,
  });
  return `${PANEL.FULLY_BASE}/?${params.toString()}`;
}

async function fullySend(cmd: string, extra: Record<string, string> = {}): Promise<void> {
  try {
    // Fully accepts GET-style command URLs; POST keeps it off the URL bar logs.
    await fetch(fullyCmdUrl(cmd, extra), { method: "POST", mode: "no-cors" });
  } catch (err) {
    console.warn(`[brightness] fully ${cmd} failed`, err);
  }
}

const fullyBackend: PanelBackend = {
  async setBrightness(level) {
    const clamped = Math.max(0, Math.min(255, Math.round(level)));
    await fullySend("setStringSetting", { key: "screenBrightness", value: String(clamped) });
  },
  async clearCache() {
    // Fully has no separate "clear cache without relaunching" command.
    console.info(`[brightness] (unsupported on "fully" backend) clearCache`);
  },
  async relaunch() {
    await fullySend("restartApp");
  },
  async forceRefresh() {
    await fullySend("restartApp");
  },
};

// --- backend selection --------------------------------------------------

function selectBackend(): PanelBackend {
  switch (PANEL.BACKEND) {
    case "wallpanel":
      return wallpanelBackend;
    case "fully":
      return fullyBackend;
    default:
      return noneBackend;
  }
}

const backend = selectBackend();

/** Set screen brightness, 1–255 (backends clamp to their own valid range). */
export async function setBrightness(level: number): Promise<void> {
  await backend.setBrightness(level);
}

/** Clear the kiosk app's local cache, without relaunching. */
export async function clearCache(): Promise<void> {
  await backend.clearCache();
}

/** Relaunch the kiosk app, without clearing its cache. */
export async function relaunch(): Promise<void> {
  await backend.relaunch();
}

/** Recover the kiosk app from a stale service-worker/cache state. */
export async function forceRefresh(): Promise<void> {
  await backend.forceRefresh();
}
