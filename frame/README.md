# frame/ — the PWA (display)

The fullscreen Progressive Web App that runs on the AGFAPHOTO frame via Fully
Kiosk. A photo **slideshow** with a **control-center overlay** (clock, home
battery %, live power, energy today, AC controls) sourced from Home Assistant.

**Role in the architecture contract:** this is a **READ-ONLY** consumer. It only
reads `../data/photos/` and `../data/manifest.json`. It never writes them and
never talks to ingest channels. See [`../CLAUDE.md`](../CLAUDE.md).

## Non-negotiable build target

The device WebView is ≈ **Chrome 60**.

- Vite `build.target` = `["es2015", "chrome61"]`.
- Use **`@vitejs/plugin-legacy`** with polyfills.
- No untranspiled optional chaining / nullish coalescing in `dist/`.
- **`backdrop-filter` is not safe.** Overlay default = semi-opaque solid bar;
  blur only behind `@supports (backdrop-filter: blur())`, and it must look fine
  without it.
- **Light theme default** (matches white bezel) + a separate **dark night
  theme**.

## Planned stack

- Vite + TypeScript, PWA (service worker for offline shell caching).
- No third-party runtime deps; talks only to the local Home Assistant.

## Status

Scaffold only — no app code yet. `src/` and `public/` are placeholders.
