/**
 * Fully Kiosk Browser REST control.
 *
 * Fully Kiosk exposes a local REST API (default port 2323) for screen control.
 * We POST `setBrightness` / `screenOn` / `screenOff`. Gated behind
 * FULLY_KIOSK.ENABLED so it no-ops in desktop dev (where there is no Fully
 * Kiosk and the host:port isn't reachable).
 */

import { FULLY_KIOSK } from "./config";

function cmdUrl(cmd: string, extra: Record<string, string>): string {
  const params = new URLSearchParams({
    cmd,
    type: "json",
    password: FULLY_KIOSK.PASSWORD,
    ...extra,
  });
  return `${FULLY_KIOSK.BASE}/?${params.toString()}`;
}

async function send(cmd: string, extra: Record<string, string> = {}): Promise<void> {
  if (!FULLY_KIOSK.ENABLED) {
    console.info(`[brightness] (no-op, Fully disabled) ${cmd}`, extra);
    return;
  }
  try {
    // Fully accepts GET-style command URLs; POST keeps it off the URL bar logs.
    await fetch(cmdUrl(cmd, extra), { method: "POST", mode: "no-cors" });
  } catch (err) {
    console.warn(`[brightness] ${cmd} failed`, err);
  }
}

/** Set screen brightness, 0–255. */
export async function setBrightness(level: number): Promise<void> {
  const clamped = Math.max(0, Math.min(255, Math.round(level)));
  await send("setStringSetting", { key: "screenBrightness", value: String(clamped) });
}

/** Turn the screen on or off. Fully wakes on touch, so screenOff is reversible. */
export async function setScreenOn(on: boolean): Promise<void> {
  await send(on ? "screenOn" : "screenOff");
}

/** Soft-restart the Fully Kiosk app (not the frame/device itself). */
export async function restartApp(): Promise<void> {
  await send("restartApp");
}
