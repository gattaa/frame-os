# frame/ — the PWA (display)

The fullscreen Progressive Web App that runs on the AGFAPHOTO frame via Fully
Kiosk: a photo **slideshow** with a **control-center overlay** (clock, home
battery %, live power, energy today, AC controls) sourced from Home Assistant.

**Role in the architecture contract:** READ-ONLY consumer. It only reads
`../data/photos/` and `../data/manifest.json`, and Home Assistant for live
tiles. It never writes those files and never talks to ingest channels. See
[`../CLAUDE.md`](../CLAUDE.md).

## Running

```bash
npm install
npm run dev       # http://localhost:5173 — runs against pipeline mock data
npm run build     # type-check + production build (emits the legacy bundle)
npm run preview   # serve the built dist/ (also serves ../data at /data/*)
```

`npm run dev` and `npm run preview` mount the repo's `../data/` directory at
`/data/*` (see `vite.config.ts`), so the app reads `manifest.json`,
`mock-entities.json`, and `photos/` with no extra server. Generate mock data
first with `python ../pipeline/gen_mock.py`.

In dev (and any build made with `VITE_USE_MOCK=true`) the app runs entirely
against mock JSON — **no live Home Assistant needed**.

## The ancient-WebView build (non-negotiable)

The device WebView is ≈ **Chrome 60**, which has no `<script type=module>`
support, so it loads the **nomodule legacy bundle**.

- `vite.config.ts` sets `build.target = ["es2015","chrome61"]` and uses
  **`@vitejs/plugin-legacy`** (`targets: ["chrome >= 60"]`, polyfills on). The
  legacy + polyfill chunks are what actually run on the frame.
  - (Vite prints "plugin-legacy overrode 'build.target'" — expected; the plugin
    owns the legacy target. The legacy bundle is verified to contain no
    untranspiled `?.`/`??`.)
- **`backdrop-filter` is not used as a load-bearing style.** The overlay bar is
  a solid semi-opaque fill; blur is added only behind an
  `@supports (backdrop-filter: …)` guard and the UI is legible without it.
- **Light theme default** (matches the white bezel) + a **dark night theme**
  via `[data-theme]`, switched by `theme.ts` off HA's
  `input_boolean.frame_night_mode` (same boolean HA uses to drive screen
  brightness, so the two stay in lockstep).

## Layout

| File | Responsibility |
|------|----------------|
| `src/config.ts` | All env-specific config: entity IDs (`BATTERY_PCT`, `POWER_NOW`, `ENERGY_TODAY`, `CLIMATE_AC`), HA base URL + token, Fully Kiosk base, the `USE_MOCK`/`DEV` switch, data paths, behaviour tunables. |
| `src/photos.ts` | Reads `manifest.json`, preloads, crossfades every ~12s, `object-fit:cover`, optional Ken Burns (toggle with **k** in dev), ordered by `ts`, with a sender chip + caption. |
| `src/data.ts` | Subscribes to HA entities via `home-assistant-js-websocket`; mirrors every update to IndexedDB; falls back to last-known on disconnect / offline / mock and flags it **stale**. Never crashes on missing entities. |
| `src/idb.ts` | Tiny promise-based IndexedDB key/value store (hand-written, no dep). |
| `src/overlay.ts` | The control-center bar: clock/date, stats, AC `−`/`+`/mode (calls HA climate services). Auto-dims and nudges position to avoid retention. |
| `src/theme.ts` | `startTheme()` — light/dark driven by HA `input_boolean.frame_night_mode` (via the data layer). Optionally nudges PWA brightness on transitions. |
| `src/brightness.ts` | `setBrightness(0–255)` / `setScreenOn(bool)` → Fully Kiosk REST. Gated by config so it no-ops in desktop dev. |
| `src/main.ts` | Boot + service-worker registration. |
| `public/sw.js` | Hand-written, Chrome-60-safe service worker (see Offline). |
| `public/manifest.webmanifest` | PWA manifest (fullscreen, landscape). |

## Offline behaviour

`public/sw.js` (registered only for built/preview output, not the dev server):

- **app shell / navigation** → network-first, falls back to cached `index.html`
- **built assets, icons** → cache-first (hashed, immutable)
- **photos** → cache-first
- **`manifest.json` + entities JSON** → network-first, fall back to cache

Cache-fallback responses are tagged `X-From-Cache: 1` so the data layer knows
it's showing last-known values and lights the **stale dot**. A full reload with
the network offline still shows photos + last-known overlay values (verified
end-to-end against the real Chromium build).

## Configuration

Copy `.env.example` → `.env` for a real-device build (HA token, entity IDs,
Fully Kiosk host, data paths). None of it is needed for mock-mode development.
