/**
 * frame-os PWA entry point.
 *
 * Wires the photo slideshow, the data layer (HA / mock), the control-center
 * overlay, day/night theming, and the offline service worker. Order is chosen
 * so the screen shows *something* as fast as possible and nothing here can
 * hard-fail the boot.
 */

import "./styles.css";
import { DEV, USE_MOCK } from "./config";
import { startSlideshow, toggleKenBurns } from "./photos";
import { startData } from "./data";
import { startOverlay } from "./overlay";
import { startTheme } from "./theme";

function registerServiceWorker(): void {
  if (!("serviceWorker" in navigator)) return;
  // SW is only meaningful for built/preview output; skip in the Vite dev server
  // (modules are served unbundled there and a precache list would be wrong).
  if (DEV) return;
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch((err) => {
      console.warn("[sw] registration failed", err);
    });
  });
}

async function boot(): Promise<void> {
  console.info(`[frame-os] boot (mock=${USE_MOCK}, dev=${DEV})`);

  startTheme();      // follow HA night mode (subscribes to the data layer)
  startOverlay();    // clock ticks and controls are live immediately
  startData();       // hydrate from cache, then HA/mock (async, non-blocking)
  startSlideshow();  // manifest + crossfade (async, non-blocking)

  registerServiceWorker();

  // Dev affordance: press "k" to toggle Ken Burns.
  window.addEventListener("keydown", (e) => {
    if (e.key === "k") {
      const on = toggleKenBurns();
      console.info(`[frame-os] Ken Burns ${on ? "on" : "off"}`);
    }
  });
}

void boot();
